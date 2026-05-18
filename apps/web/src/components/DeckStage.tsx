/**
 * Renders the current slide inside a small **persistent pool** of sandboxed
 * iframes, scaled into the available wrapper via the letterbox transform
 * from spec §6.2.
 *
 * Why a pool: every slide is a fresh sandboxed iframe at an opaque origin,
 * which means each one carries an isolated `FontFaceSet`. If we tore down
 * the previous iframe on every page turn the new one would always pay the
 * full webfont swap cost — that's the "font flash" / "font flicker" bug
 * users see when implementations only buffer two slots and promote at
 * `iframe.onload`. Conversely, gating the promotion on
 * `document.fonts.ready` removes the flash but introduces a perceptible
 * lag on every key press while the gate waits.
 *
 * The pool solves both: we keep up to `POOL_SIZE` iframes mounted at the
 * same time — the active slide and its immediate neighbours, kept warm by
 * `preloadSrcs` from the parent. When the user advances the next iframe is
 * almost always already loaded *and* its fonts have already swapped in, so
 * the promotion is a zero-latency `opacity` flip with no visual change to
 * font rendering. Iframes are reused (`key` is fixed per slot index, not
 * per src), so React never unmounts a slot — the underlying `<iframe>` DOM
 * node stays in place and only its `src` attribute is repointed when LRU
 * eviction happens. This keeps the FontFaceSet stable for every slide
 * that lives in the pool.
 *
 * For non-sequential navigation (overview pick, Goto page N) the requested
 * src may not be in the pool. We still flip `active` immediately so the
 * viewer responds to input, but the user may see a brief font swap on
 * that slide; the next sequential turn from there is back to zero-flash.
 *
 * Coordinates with `routes/storage.ts › injectReadySignal`: every slide
 * HTML postMessages `slidestage:ready` once its fonts have settled. We
 * track `ready` per slot so the visibility logic can fall back to the
 * previously-displayed slot when the user lands on something the pool
 * hasn't warmed yet.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useStageLayout } from '../hooks/useStageLayout.js';

interface Props {
  src: string;
  width: number;
  height: number;
  className?: string;
  testId?: string;
  /** Disable scripts in the iframe (used by tiny in-overview previews). */
  noScripts?: boolean;
  onLoaded?: () => void;
  /** Adjacent slide URLs the parent expects the user to land on next. */
  preloadSrcs?: string[];
  /**
   * Optional space-separated sandbox token string for live (non-`noScripts`)
   * iframes. Defaults to the historic `allow-scripts` baseline; pass a value
   * derived from the deck's `compat.requires` (see `utils/iframeSandbox.ts`)
   * to elevate the sandbox when the producer declared it needs storage,
   * BroadcastChannel, or popups.
   */
  sandbox?: string;
}

/**
 * Pool capacity. 3 = prev + active + next, which covers the steady-state
 * sequential navigation pattern. Bumping to 5 (±2) helps when users skim
 * with rapid arrow presses, at the cost of 2 extra mounted iframes —
 * acceptable since each slide is small and the inactive ones are paused
 * by the browser when offscreen.
 */
const POOL_SIZE = 3;

/** Time to wait for the in-iframe ready signal before promoting anyway. */
const READY_FALLBACK_MS = 2000;

interface Slot {
  src: string | null;
  loaded: boolean;
  ready: boolean;
  /** Monotonic counter for LRU eviction (higher = more recently desired). */
  lastUsed: number;
}

function emptySlot(): Slot {
  return { src: null, loaded: false, ready: false, lastUsed: 0 };
}

export function DeckStage({
  src,
  width,
  height,
  className,
  testId,
  noScripts = false,
  onLoaded,
  preloadSrcs = [],
  sandbox,
}: Props): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const layout = useStageLayout(wrapperRef, width, height);

  // Pool of slot states. We treat the array index as the slot id; React
  // gets `key={index}` so the underlying <iframe> DOM nodes are never
  // unmounted — only their `src` attribute is repointed when a slot is
  // re-assigned. That keeps the per-iframe FontFaceSet warm across
  // navigations as long as the URL stays in the pool.
  const [pool, setPool] = useState<Slot[]>(() =>
    Array.from({ length: POOL_SIZE }, emptySlot),
  );
  /** Previously visible src — used as a graceful fallback while the user
   *  lands on something the pool hadn't warmed yet (and therefore can't
   *  display immediately). */
  const [lastVisibleSrc, setLastVisibleSrc] = useState<string | null>(
    src || null,
  );

  // Per-slot timers for the ready-signal safety net.
  const slotTimersRef = useRef<(ReturnType<typeof setTimeout> | null)[]>(
    Array(POOL_SIZE).fill(null),
  );
  const iframeRefs = useRef<(HTMLIFrameElement | null)[]>(
    Array(POOL_SIZE).fill(null),
  );
  /** Monotonic counter shared across renders for LRU eviction. */
  const useCounterRef = useRef(0);

  const requiresReadySignal = !noScripts;

  const clearSlotTimer = useCallback((slot: number): void => {
    const t = slotTimersRef.current[slot];
    if (t) {
      clearTimeout(t);
      slotTimersRef.current[slot] = null;
    }
  }, []);

  // ── Pool maintenance ─────────────────────────────────────────────────
  //
  // Whenever the parent's `src` or `preloadSrcs` change, re-derive which
  // URLs the pool should be holding. New URLs evict the least-recently
  // requested slot that isn't itself desired.

  const desiredUrls = useMemo<string[]>(() => {
    if (!src) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (u: string | undefined | null): void => {
      if (!u || seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };
    push(src);
    for (const u of preloadSrcs) push(u);
    return out.slice(0, POOL_SIZE);
  }, [src, preloadSrcs]);

  useEffect(() => {
    if (desiredUrls.length === 0) {
      setPool(Array.from({ length: POOL_SIZE }, emptySlot));
      for (let i = 0; i < POOL_SIZE; i++) clearSlotTimer(i);
      return;
    }

    setPool((prev) => {
      const next = prev.map((s) => ({ ...s }));

      // 1. Bump `lastUsed` for slots whose src is still desired.
      const tickNow = (): number => ++useCounterRef.current;
      for (const url of desiredUrls) {
        const slotIdx = next.findIndex((s) => s.src === url);
        if (slotIdx >= 0) next[slotIdx]!.lastUsed = tickNow();
      }

      // 2. Assign any desired URL not yet in the pool to the LRU victim
      //    slot whose own src is not currently desired.
      for (const url of desiredUrls) {
        if (next.some((s) => s.src === url)) continue;
        let victimIdx = -1;
        let oldest = Infinity;
        for (let i = 0; i < next.length; i++) {
          const slot = next[i]!;
          if (slot.src !== null && desiredUrls.includes(slot.src)) continue;
          if (slot.lastUsed < oldest) {
            oldest = slot.lastUsed;
            victimIdx = i;
          }
        }
        if (victimIdx < 0) {
          // All slots desired (shouldn't happen with desiredUrls capped at
          // POOL_SIZE) — pick the actually-oldest slot anyway.
          victimIdx = next.reduce(
            (acc, s, i) =>
              s.lastUsed < (next[acc]?.lastUsed ?? Infinity) ? i : acc,
            0,
          );
        }
        next[victimIdx] = {
          src: url,
          loaded: false,
          ready: false,
          lastUsed: tickNow(),
        };
        clearSlotTimer(victimIdx);
        if (requiresReadySignal) {
          slotTimersRef.current[victimIdx] = setTimeout(() => {
            // Mark as ready after the safety window so the visibility
            // logic doesn't hold the prev slide forever.
            const v = victimIdx;
            setPool((cur) => {
              const copy = cur.map((s) => ({ ...s }));
              if (copy[v] && copy[v]!.src === url) copy[v]!.ready = true;
              return copy;
            });
          }, READY_FALLBACK_MS);
        }
      }

      return next;
    });
  }, [desiredUrls, requiresReadySignal, clearSlotTimer]);

  // ── Visibility resolution ────────────────────────────────────────────
  //
  // The "shown" slot is the one matching `src`. If that slot is ready (or
  // doesn't need a ready signal, e.g. inert previews) we show it; if it
  // isn't ready yet but a `lastVisibleSrc` is still in the pool we hold
  // the previous slide visible until the new one settles. Falling back to
  // the previous slide is what makes random navigation (Goto page N) feel
  // continuous even when the destination isn't preloaded.

  const activeSlotIdx = useMemo(
    () => pool.findIndex((s) => s.src === src),
    [pool, src],
  );
  const activeSlotReady =
    activeSlotIdx >= 0 &&
    pool[activeSlotIdx]!.loaded &&
    (!requiresReadySignal || pool[activeSlotIdx]!.ready);

  const fallbackSlotIdx = useMemo(() => {
    if (!lastVisibleSrc || lastVisibleSrc === src) return -1;
    const idx = pool.findIndex(
      (s) =>
        s.src === lastVisibleSrc &&
        s.loaded &&
        (!requiresReadySignal || s.ready),
    );
    return idx;
  }, [pool, lastVisibleSrc, src, requiresReadySignal]);

  const visibleSlotIdx = activeSlotReady
    ? activeSlotIdx
    : fallbackSlotIdx >= 0
      ? fallbackSlotIdx
      : activeSlotIdx;

  // Promote `lastVisibleSrc` to whatever's on screen as soon as the new
  // active slot is ready — so the next navigation has a fresh anchor.
  useEffect(() => {
    if (activeSlotReady && src) setLastVisibleSrc(src);
  }, [activeSlotReady, src]);

  // ── Per-slot iframe event handlers ───────────────────────────────────

  const handleFrameLoad = useCallback(
    (slot: number) => {
      setPool((prev) => {
        const next = prev.map((s) => ({ ...s }));
        const entry = next[slot];
        if (entry) {
          entry.loaded = true;
          if (!requiresReadySignal) entry.ready = true;
        }
        return next;
      });
      // The non-script preview path never emits a ready signal — promote
      // its onLoaded callback right away.
      if (!requiresReadySignal) onLoaded?.();
    },
    [requiresReadySignal, onLoaded],
  );

  // Listen for `slidestage:ready` postMessages and mark the matching slot
  // as ready. Match by `event.source` because the iframe runs at an
  // opaque origin (we can't trust `event.origin`).
  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      const data = e.data as { type?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'slidestage:ready') return;
      const slot = iframeRefs.current.findIndex(
        (f) => f !== null && f.contentWindow === e.source,
      );
      if (slot < 0) return;
      setPool((prev) => {
        const next = prev.map((s) => ({ ...s }));
        const entry = next[slot];
        if (entry && !entry.ready) entry.ready = true;
        return next;
      });
      clearSlotTimer(slot);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [clearSlotTimer]);

  // Fire `onLoaded` whenever the visible slot is the active one and
  // ready — useful for tests / parent UI that wants to drop a loading
  // spinner.
  useEffect(() => {
    if (
      activeSlotReady &&
      activeSlotIdx === visibleSlotIdx &&
      pool[activeSlotIdx]?.src
    ) {
      onLoaded?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlotReady, activeSlotIdx, visibleSlotIdx]);

  // Cleanup any pending safety timers on unmount.
  useEffect(
    () => () => {
      for (let i = 0; i < POOL_SIZE; i++) clearSlotTimer(i);
    },
    [clearSlotTimer],
  );

  // Match the existing `<link rel="prefetch">` behaviour for the no-script
  // (overview thumbnail) path — those callers don't get a real pool but
  // can still hint the document fetch to the browser.
  useEffect(() => {
    if (!noScripts) return;
    if (preloadSrcs.length === 0) return;
    const unique = Array.from(
      new Set(preloadSrcs.filter((u) => u && u !== src)),
    );
    const links = unique.map((href) => {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = 'document';
      link.href = href;
      document.head.appendChild(link);
      return link;
    });
    return () => {
      for (const link of links) link.remove();
    };
  }, [noScripts, preloadSrcs, src]);

  const stageStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width,
    height,
    transform: `translate(${layout.offsetX}px, ${layout.offsetY}px) scale(${layout.scale})`,
    transformOrigin: 'top left',
  };

  const sandboxFlags = noScripts ? '' : sandbox ?? 'allow-scripts';

  return (
    <div
      ref={wrapperRef}
      className={`deck-stage-wrapper${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      <div className="deck-stage" style={stageStyle} data-testid="deck-stage">
        {pool.map((slot, i) =>
          slot.src ? (
            <iframe
              key={i}
              ref={(el) => {
                iframeRefs.current[i] = el;
              }}
              src={slot.src}
              title="slide content"
              sandbox={sandboxFlags}
              referrerPolicy="no-referrer"
              loading="eager"
              data-active={i === visibleSlotIdx ? 'true' : 'false'}
              data-ready={slot.ready ? 'true' : 'false'}
              onLoad={() => handleFrameLoad(i)}
              style={{
                position: 'absolute',
                inset: 0,
                width,
                height,
                border: 0,
                display: 'block',
                opacity: i === visibleSlotIdx ? 1 : 0,
                // Inactive slots are kept warm but inert — events go only
                // to the currently displayed slide.
                pointerEvents: noScripts
                  ? 'none'
                  : i === visibleSlotIdx
                    ? 'auto'
                    : 'none',
              }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}
