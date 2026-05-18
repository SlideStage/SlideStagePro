/**
 * Deck-info editor sync hook.
 *
 * Mirrors `useNotesSync` (apps/web/src/hooks/useNotesSync.ts) — the same
 * "stage to pending, debounce, flush" loop — but for the deck-level
 * metadata (title / subtitle / author / description) and per-slide
 * labels exposed by `PATCH /api/decks/:id/info`.
 *
 *   • local edits stage into a `pending` object
 *   • after 800 ms of idle typing they PATCH to the backend
 *   • on unmount → flush whatever's pending so nav-away doesn't lose work
 *   • on error → restore the pending entry so the next debounce retries
 *
 * The hook intentionally does *not* own the form-input state. Components
 * pass each edit through `setDeckField` / `setSlideLabel`; the hook
 * returns the effective merged values (server + pending) for rendering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeckInfoPatchBody, Manifest } from '@slidestage/shared';
import { api } from '../api/client.js';

const FLUSH_DELAY_MS = 800;
const SAVED_DECAY_MS = 1800;

export type DeckInfoSyncStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export type DeckInfoField =
  | 'title'
  | 'subtitle'
  | 'author'
  | 'description';

const DECK_FIELDS: readonly DeckInfoField[] = [
  'title',
  'subtitle',
  'author',
  'description',
] as const;

interface DeckInfoSnapshot {
  title: string;
  subtitle: string | null;
  author: string | null;
  description: string | null;
}

interface PendingState {
  deck: Partial<DeckInfoSnapshot>;
  slideLabels: Record<number, string | null>;
}

const EMPTY_PENDING: PendingState = { deck: {}, slideLabels: {} };

function hasPendingWork(p: PendingState): boolean {
  return (
    Object.keys(p.deck).length > 0 || Object.keys(p.slideLabels).length > 0
  );
}

function snapshotFromManifest(manifest: Manifest): {
  deck: DeckInfoSnapshot;
  labels: Record<number, string>;
} {
  return {
    deck: {
      title: manifest.title,
      subtitle: manifest.subtitle ?? null,
      author: manifest.author ?? null,
      description: manifest.description ?? null,
    },
    labels: Object.fromEntries(
      manifest.slides.map((s) => [s.index, s.label]),
    ),
  };
}

export interface DeckInfoSyncOptions {
  deckId: string;
  manifest: Manifest;
  /**
   * Called after a successful PATCH with the merged snapshot. The parent
   * uses this to refresh its `DeckDetail` mirror (cover thumbnail title /
   * subtitle / author appear in multiple places).
   */
  onPersisted?: (
    deck: DeckInfoSnapshot,
    labels: Record<number, string>,
    manifestUpdatedAt: string,
  ) => void;
}

export interface DeckInfoSyncApi {
  /** Effective deck-level values (server + pending overrides). */
  deck: DeckInfoSnapshot;
  /** Effective per-slide labels (1-based index → label). */
  labels: Record<number, string>;
  status: DeckInfoSyncStatus;
  errorMessage: string | null;
  /** Stage a deck-level field edit. `null` clears (except for `title`). */
  setDeckField: <K extends DeckInfoField>(
    field: K,
    value: DeckInfoSnapshot[K],
  ) => void;
  /** Stage a slide-label edit. Empty string / null resets the label. */
  setSlideLabel: (slideIdx: number, value: string | null) => void;
  /** Force a flush right now. Resolves after the network call. */
  flush: () => Promise<void>;
}

export function useDeckInfoSync(opts: DeckInfoSyncOptions): DeckInfoSyncApi {
  const { deckId, manifest, onPersisted } = opts;

  const initial = useMemo(() => snapshotFromManifest(manifest), [manifest]);
  const [serverDeck, setServerDeck] = useState<DeckInfoSnapshot>(initial.deck);
  const [serverLabels, setServerLabels] = useState<Record<number, string>>(
    initial.labels,
  );

  const [pending, setPending] = useState<PendingState>(EMPTY_PENDING);
  const pendingRef = useRef<PendingState>(pending);
  pendingRef.current = pending;

  const [status, setStatus] = useState<DeckInfoSyncStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const onPersistedRef = useRef(onPersisted);
  onPersistedRef.current = onPersisted;

  // Refresh server-side snapshot whenever the parent passes a new manifest
  // (e.g. after a successful PATCH callback). Pending edits stay intact —
  // the user's still-uncommitted typing wins.
  useEffect(() => {
    const snap = snapshotFromManifest(manifest);
    setServerDeck(snap.deck);
    setServerLabels(snap.labels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  // Switching deckId drops any pending edits — they belonged to the old deck.
  useEffect(() => {
    setPending(EMPTY_PENDING);
    pendingRef.current = EMPTY_PENDING;
    setStatus('idle');
    setErrorMessage(null);
  }, [deckId]);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);
  const clearSavedDecay = useCallback(() => {
    if (savedDecayRef.current) {
      clearTimeout(savedDecayRef.current);
      savedDecayRef.current = null;
    }
  }, []);

  const flushNow = useCallback(async (): Promise<void> => {
    clearFlushTimer();
    if (inflightRef.current) {
      // Coalesce concurrent flushes; the post-flight effect kicks a new
      // debounce if anything still remained pending.
      await inflightRef.current;
      return;
    }
    const snapshot = pendingRef.current;
    if (!hasPendingWork(snapshot)) return;

    setPending(EMPTY_PENDING);
    pendingRef.current = EMPTY_PENDING;
    setStatus('saving');
    setErrorMessage(null);

    const body: DeckInfoPatchBody = {};
    for (const f of DECK_FIELDS) {
      if (snapshot.deck[f] !== undefined) {
        if (f === 'title') {
          body.title = (snapshot.deck.title ?? '').trim();
        } else {
          body[f] = snapshot.deck[f] ?? null;
        }
      }
    }
    if (Object.keys(snapshot.slideLabels).length > 0) {
      body.slideLabels = Object.fromEntries(
        Object.entries(snapshot.slideLabels).map(([k, v]) => [k, v]),
      );
    }

    const work = (async (): Promise<void> => {
      try {
        const resp = await api.updateDeckInfo(deckId, body);
        const nextDeck: DeckInfoSnapshot = { ...serverDeck };
        for (const f of resp.deckFieldsChanged) {
          if (f === 'title') {
            nextDeck.title = body.title ?? nextDeck.title;
          } else {
            nextDeck[f] = (body[f] ?? null) as DeckInfoSnapshot[typeof f];
          }
        }
        const nextLabels = { ...serverLabels };
        for (const idx of resp.slideLabelsChanged) {
          const proposed = snapshot.slideLabels[idx];
          if (proposed === null || proposed === undefined || proposed === '') {
            // Server reset to slide.id; we don't have that locally, so leave
            // the manifest-driven refresh (onPersisted -> setDeck) update it.
            continue;
          }
          nextLabels[idx] = proposed;
        }
        setServerDeck(nextDeck);
        setServerLabels(nextLabels);
        onPersistedRef.current?.(nextDeck, nextLabels, resp.manifestUpdatedAt);
        setStatus('saved');
        clearSavedDecay();
        savedDecayRef.current = setTimeout(() => {
          setStatus((s) => (s === 'saved' ? 'idle' : s));
          savedDecayRef.current = null;
        }, SAVED_DECAY_MS);
      } catch (err) {
        // Re-merge the snapshot under whatever the user typed during the
        // request — never drop their work.
        setPending((curr) => {
          const next: PendingState = {
            deck: { ...snapshot.deck, ...curr.deck },
            slideLabels: { ...snapshot.slideLabels, ...curr.slideLabels },
          };
          pendingRef.current = next;
          return next;
        });
        setStatus('error');
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save deck info',
        );
      }
    })();
    inflightRef.current = work;
    try {
      await work;
    } finally {
      inflightRef.current = null;
    }
  }, [deckId, serverDeck, serverLabels, clearFlushTimer, clearSavedDecay]);

  const armDebounce = useCallback((): void => {
    clearFlushTimer();
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      void flushNow();
    }, FLUSH_DELAY_MS);
  }, [clearFlushTimer, flushNow]);

  const setDeckField = useCallback(
    <K extends DeckInfoField>(field: K, value: DeckInfoSnapshot[K]): void => {
      setPending((prev) => {
        const next: PendingState = {
          deck: { ...prev.deck, [field]: value },
          slideLabels: prev.slideLabels,
        };
        pendingRef.current = next;
        return next;
      });
      setStatus('dirty');
      setErrorMessage(null);
      armDebounce();
    },
    [armDebounce],
  );

  const setSlideLabel = useCallback(
    (slideIdx: number, value: string | null): void => {
      setPending((prev) => {
        const normalized = value === null ? null : value;
        const next: PendingState = {
          deck: prev.deck,
          slideLabels: { ...prev.slideLabels, [slideIdx]: normalized },
        };
        pendingRef.current = next;
        return next;
      });
      setStatus('dirty');
      setErrorMessage(null);
      armDebounce();
    },
    [armDebounce],
  );

  // Final flush on unmount.
  useEffect(() => {
    return () => {
      clearFlushTimer();
      clearSavedDecay();
      if (hasPendingWork(pendingRef.current)) {
        void flushNow();
      }
    };
  }, [clearFlushTimer, clearSavedDecay, flushNow]);

  // If a flush left work behind (user kept typing), kick a new debounce.
  useEffect(() => {
    if (status === 'saving') return;
    if (!hasPendingWork(pending)) return;
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      void flushNow();
    }, FLUSH_DELAY_MS);
  }, [pending, status, flushNow]);

  // Effective views = server + pending overrides.
  const deck = useMemo<DeckInfoSnapshot>(() => {
    return {
      title: pending.deck.title ?? serverDeck.title,
      subtitle:
        pending.deck.subtitle !== undefined
          ? pending.deck.subtitle
          : serverDeck.subtitle,
      author:
        pending.deck.author !== undefined
          ? pending.deck.author
          : serverDeck.author,
      description:
        pending.deck.description !== undefined
          ? pending.deck.description
          : serverDeck.description,
    };
  }, [serverDeck, pending.deck]);

  const labels = useMemo<Record<number, string>>(() => {
    const out: Record<number, string> = { ...serverLabels };
    for (const [k, v] of Object.entries(pending.slideLabels)) {
      const idx = Number(k);
      if (v === null || v === '') {
        // Reset → fall back to server's label until persistence resolves.
        out[idx] = serverLabels[idx] ?? '';
      } else {
        out[idx] = v;
      }
    }
    return out;
  }, [serverLabels, pending.slideLabels]);

  return {
    deck,
    labels,
    status,
    errorMessage,
    setDeckField,
    setSlideLabel,
    flush: flushNow,
  };
}
