/**
 * PowerPoint-style presenter view: large current slide on the left, next-slide
 * thumbnail + timer + audience-status on the right, speaker notes across the
 * bottom. The "Open audience window" button opens `/decks/:id/audience` in a
 * separate window; once both windows are alive a BroadcastChannel keeps them
 * in lock-step (slide index, tool, strokes, draft ink, laser/spotlight cursor).
 *
 * Authoritative state lives here. The audience window is a pure mirror.
 */

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Stroke } from '@slidestage/shared';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Grid3X3,
  Radio,
} from 'lucide-react';
import { api } from '../api/client.js';
import { DeckStage } from '../components/DeckStage.js';
import { EditableNotes } from '../components/EditableNotes.js';
import { NotesHistory } from '../components/NotesHistory.js';
import { Overview } from '../components/Overview.js';
import { useDeckFontWarmup } from '../hooks/useDeckFontWarmup.js';
import { useKeyboardNav } from '../hooks/useKeyboardNav.js';
import { useNotesSync } from '../hooks/useNotesSync.js';
import { useStageLayout } from '../hooks/useStageLayout.js';
import { useDeckLoader, useInitialAnnotations } from '../hooks/useDeckLoader.js';
import { AnnotationOverlay } from '../presenter/AnnotationOverlay.js';
import { Blackout } from '../presenter/Blackout.js';
import { LaserPointer } from '../presenter/LaserPointer.js';
import { Spotlight } from '../presenter/Spotlight.js';
import { Toolbar } from '../presenter/Toolbar.js';
import {
  usePresenter,
  usePresenterShortcuts,
} from '../presenter/usePresenter.js';
import { usePresentationSync, type SyncMessage } from '../presenter/usePresentationSync.js';
import { useStrokeSync } from '../presenter/useStrokeSync.js';
import { sandboxForCompat } from '../utils/iframeSandbox.js';
import { storageAssetUrl } from '../utils/storageUrl.js';

function readHashIndex(total: number): number {
  if (typeof window === 'undefined') return 1;
  const m = window.location.hash.match(/^#(\d+)$/);
  if (!m) return 1;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(total, n));
}

// Placeholder so `useNotesSync` has a stable manifest reference before the
// real one arrives. The hook resets its internal state whenever the manifest
// reference changes — pointing at this constant during the loading window
// avoids re-renders on every parent re-render.
const EMPTY_MANIFEST = {
  slides: [],
  dimensions: { width: 1920, height: 1080 },
} as unknown as import('@slidestage/shared').Manifest;

const MIN_SIDE_PANEL_WIDTH = 260;
const MAX_SIDE_PANEL_WIDTH = 560;
const MIN_NOTES_HEIGHT = 120;
const MAX_NOTES_HEIGHT = 420;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function PresenterViewPage(): JSX.Element {
  const { deckId: rawDeckId = '' } = useParams<{ deckId: string }>();
  const deckId = decodeURIComponent(rawDeckId);
  const nav = useNavigate();

  const { deck, error, setDeck } = useDeckLoader(deckId);
  const presenter = usePresenter();
  const [currentIdx, setCurrentIdx] = useState<number>(1);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [audienceConnected, setAudienceConnected] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audienceWindow, setAudienceWindow] = useState<Window | null>(null);
  const [sidePanelWidth, setSidePanelWidth] = useState(380);
  const [notesHeight, setNotesHeight] = useState(200);
  const audienceCloseTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const startedAtRef = useRef<number>(performance.now());

  // Once the deck arrives, sync the slide index from the URL hash.
  useEffect(() => {
    if (!deck) return;
    setCurrentIdx(readHashIndex(deck.totalSlides));
  }, [deck]);

  useInitialAnnotations(deck ? deck.id : null, presenter.loadStrokes);

  // ── Cross-window sync ────────────────────────────────────────────
  // Captured-state ref so the message handler always reads the latest
  // values without needing to be reconstructed (and re-subscribed).
  const stateRef = useRef({
    slideIdx: currentIdx,
    tool: presenter.state.tool,
    penColor: presenter.state.penColor,
    strokesByIdx: presenter.state.strokesByIdx,
    spotlightRadius: presenter.state.spotlightRadius,
  });
  stateRef.current = {
    slideIdx: currentIdx,
    tool: presenter.state.tool,
    penColor: presenter.state.penColor,
    strokesByIdx: presenter.state.strokesByIdx,
    spotlightRadius: presenter.state.spotlightRadius,
  };

  // Sync ref is filled in once `sync` is created below.
  const syncRef = useRef<{ send: (msg: SyncMessage) => void } | null>(null);

  const sendSnapshot = useCallback(() => {
    syncRef.current?.send({
      type: 'snapshot',
      state: {
        slideIdx: stateRef.current.slideIdx,
        tool: stateRef.current.tool,
        penColor: stateRef.current.penColor,
        strokesByIdx: stateRef.current.strokesByIdx,
        blackoutAt: null,
        pointerPos: null,
        spotlightRadius: stateRef.current.spotlightRadius,
      },
    });
  }, []);

  const handleMessage = useCallback(
    (msg: SyncMessage) => {
      if (msg.type === 'hello' && msg.role === 'audience') {
        setAudienceConnected(true);
        sendSnapshot();
      } else if (msg.type === 'request-snapshot') {
        setAudienceConnected(true);
        sendSnapshot();
      }
    },
    [sendSnapshot],
  );

  const sync = usePresentationSync({
    deckId,
    role: 'presenter',
    onMessage: handleMessage,
  });
  syncRef.current = sync;

  // Broadcast slide changes.
  useEffect(() => {
    sync.send({ type: 'slide', slideIdx: currentIdx });
  }, [sync, currentIdx]);

  // Broadcast tool changes.
  useEffect(() => {
    sync.send({ type: 'tool', tool: presenter.state.tool });
  }, [sync, presenter.state.tool]);

  // Broadcast color changes (cosmetic on audience side, but cheap).
  useEffect(() => {
    sync.send({ type: 'color', color: presenter.state.penColor });
  }, [sync, presenter.state.penColor]);

  // Broadcast spotlight aperture changes so the audience window mirrors the
  // exact circle size. Cheap (one int every few hundred ms when a user drags
  // the slider) so we don't bother with rAF throttling.
  useEffect(() => {
    sync.send({
      type: 'spotlight-radius',
      radius: presenter.state.spotlightRadius,
    });
  }, [sync, presenter.state.spotlightRadius]);

  // Broadcast strokes for the current slide whenever the array reference
  // changes. We keep a per-slide last-sent ref to avoid a flood of "strokes"
  // messages while typing keys (which doesn't change strokes but does
  // re-render this hook).
  const lastSentRef = useRef<Map<number, Stroke[]>>(new Map());
  useEffect(() => {
    const map = presenter.state.strokesByIdx;
    for (const key of Object.keys(map)) {
      const idx = Number(key);
      const cur = map[idx] ?? [];
      const prev = lastSentRef.current.get(idx);
      if (prev !== cur) {
        sync.send({ type: 'strokes', slideIdx: idx, strokes: cur });
        lastSentRef.current.set(idx, cur);
      }
    }
  }, [sync, presenter.state.strokesByIdx]);

  // Broadcast draft stroke (in-flight pen / highlighter ink).
  const draftStrokeRef = useRef<Stroke | null>(null);
  const draftFlushRef = useRef<number | null>(null);
  const handleDraftChange = useCallback(
    (stroke: Stroke | null) => {
      draftStrokeRef.current = stroke;
      if (draftFlushRef.current !== null) return;
      draftFlushRef.current = window.requestAnimationFrame(() => {
        draftFlushRef.current = null;
        sync.send({
          type: 'draft',
          slideIdx: currentIdx,
          stroke: draftStrokeRef.current,
        });
      });
    },
    [sync, currentIdx],
  );
  // Also clear draft when the slide changes mid-stroke.
  useEffect(() => {
    return () => {
      if (draftStrokeRef.current) {
        draftStrokeRef.current = null;
        sync.send({ type: 'draft', slideIdx: currentIdx, stroke: null });
      }
    };
  }, [currentIdx, sync]);

  // Broadcast pointer position (laser / spotlight) — throttled via rAF.
  const pointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const pointerFlushRef = useRef<number | null>(null);
  const handlePointerPos = useCallback(
    (pos: { x: number; y: number } | null) => {
      pointerPosRef.current = pos;
      if (pointerFlushRef.current !== null) return;
      pointerFlushRef.current = window.requestAnimationFrame(() => {
        pointerFlushRef.current = null;
        sync.send({ type: 'pointer', pos: pointerPosRef.current });
      });
    },
    [sync],
  );

  // ── Hash / nav plumbing ──────────────────────────────────────────
  useEffect(() => {
    if (!deck) return;
    const target = `#${currentIdx}`;
    if (window.location.hash !== target) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${target}`,
      );
    }
  }, [currentIdx, deck]);

  useEffect(() => {
    if (!deck) return;
    function onHash(): void {
      if (!deck) return;
      setCurrentIdx(readHashIndex(deck.totalSlides));
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [deck]);

  const goto = useCallback(
    (idx: number) => {
      if (!deck) return;
      const clamped = Math.max(1, Math.min(deck.totalSlides, idx));
      setCurrentIdx(clamped);
      setOverviewOpen(false);
    },
    [deck],
  );

  const presenterShortcuts = usePresenterShortcuts(presenter, currentIdx);

  const navApi = useMemo(
    () => ({
      total: deck?.totalSlides ?? 0,
      goto,
      next: () => goto(currentIdx + 1),
      prev: () => goto(currentIdx - 1),
      first: () => goto(1),
      last: () => deck && goto(deck.totalSlides),
      toggleOverview: () => setOverviewOpen((v) => !v),
      // Speaker view IS the presenter view — toggling does nothing here.
      toggleSpeakerView: () => undefined,
      toggleFullscreen: () => {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
        } else {
          void document.documentElement.requestFullscreen().catch(() => {});
        }
      },
      digitsOwnedByTool: presenterShortcuts.isToolDigitContext,
    }),
    [deck, currentIdx, goto, presenterShortcuts.isToolDigitContext],
  );

  useKeyboardNav(navApi);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && overviewOpen) setOverviewOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overviewOpen]);

  // Persist strokes to backend (presenter is the source of truth).
  const slideStrokes = presenter.state.strokesByIdx[currentIdx] ?? [];
  useStrokeSync({
    deckId,
    slideIdx: currentIdx,
    strokes: slideStrokes,
  });

  // Speaker-notes editing — bottom strip below the stage.
  const onNotesPersisted = useCallback(
    (newNotesByIdx: Record<number, string | null>, manifestUpdatedAt: string) => {
      setDeck((d) => {
        if (!d) return d;
        const slides = d.manifest.slides.map((s) => ({
          ...s,
          notes: newNotesByIdx[s.index] ?? s.notes ?? null,
        }));
        return {
          ...d,
          updatedAt: manifestUpdatedAt,
          manifest: { ...d.manifest, slides, updatedAt: manifestUpdatedAt },
        };
      });
    },
    [setDeck],
  );
  const notesSync = useNotesSync({
    deckId,
    manifest: deck?.manifest ?? EMPTY_MANIFEST,
    activeSlideIdx: currentIdx,
    onPersisted: onNotesPersisted,
  });
  const notesValue = notesSync.notes[currentIdx] ?? '';

  // Edit-mode lock for the bottom notes strip — see EditableNotes header
  // comment. Default false: while presenting, arrow keys / Space stay live until the
  // user explicitly clicks Edit.
  const [notesEditing, setNotesEditing] = useState(false);
  const exitNotesEdit = useCallback(() => {
    setNotesEditing(false);
    void notesSync.flush();
  }, [notesSync]);

  const handleExport = useCallback(async () => {
    if (!deck) return;
    await notesSync.flush();
    try {
      await api.exportDeck(deck.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'export failed';
      window.alert(`Export failed: ${msg}`);
    }
  }, [deck, notesSync]);

  const stageLayout = useStageLayout(
    stageHostRef,
    deck?.width ?? 1920,
    deck?.height ?? 1080,
  );

  useDeckFontWarmup({
    deckId: deck?.id,
    manifest: deck?.manifest,
    storageToken: deck?.storageToken,
  });

  // ── Timer ────────────────────────────────────────────────────────
  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current);
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const resetTimer = useCallback(() => {
    startedAtRef.current = performance.now();
    setElapsedMs(0);
  }, []);

  const startSideResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      const pointerId = e.pointerId;
      target.setPointerCapture(pointerId);
      const startX = e.clientX;
      const startWidth = sidePanelWidth;
      const maxWidth = Math.min(MAX_SIDE_PANEL_WIDTH, window.innerWidth - 360);
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(ev: PointerEvent): void {
        const next = startWidth + (startX - ev.clientX);
        setSidePanelWidth(clamp(next, MIN_SIDE_PANEL_WIDTH, maxWidth));
      }
      function onUp(): void {
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    },
    [sidePanelWidth],
  );

  const startNotesResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      const pointerId = e.pointerId;
      target.setPointerCapture(pointerId);
      const startY = e.clientY;
      const startHeight = notesHeight;
      const maxHeight = Math.min(MAX_NOTES_HEIGHT, window.innerHeight - 260);
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      function onMove(ev: PointerEvent): void {
        const next = startHeight + (startY - ev.clientY);
        setNotesHeight(clamp(next, MIN_NOTES_HEIGHT, maxHeight));
      }
      function onUp(): void {
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    },
    [notesHeight],
  );

  // ── Audience window ──────────────────────────────────────────────
  const openAudienceWindow = useCallback(() => {
    if (!deck) return;
    if (audienceWindow && !audienceWindow.closed) {
      audienceWindow.focus();
      return;
    }
    const w = window.open(
      `/decks/${encodeURIComponent(deck.id)}/audience#${currentIdx}`,
      `slidestage-audience-${deck.id}`,
      'popup=yes,width=1280,height=720',
    );
    if (!w) return;
    setAudienceWindow(w);
  }, [deck, currentIdx, audienceWindow]);

  // Detect when the audience window closes so we can update the indicator.
  useEffect(() => {
    if (!audienceWindow) return;
    if (audienceCloseTimer.current) clearInterval(audienceCloseTimer.current);
    audienceCloseTimer.current = setInterval(() => {
      if (audienceWindow.closed) {
        setAudienceConnected(false);
        setAudienceWindow(null);
        if (audienceCloseTimer.current) {
          clearInterval(audienceCloseTimer.current);
          audienceCloseTimer.current = null;
        }
      }
    }, 1000);
    return () => {
      if (audienceCloseTimer.current) {
        clearInterval(audienceCloseTimer.current);
        audienceCloseTimer.current = null;
      }
    };
  }, [audienceWindow]);

  // Close the audience window if the presenter navigates away.
  useEffect(() => {
    return () => {
      if (audienceWindow && !audienceWindow.closed) {
        try {
          audienceWindow.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [audienceWindow]);

  if (error) {
    return (
      <div className="page deck-viewer-error">
        <h2>Failed to load deck</h2>
        <p className="alert error">{error}</p>
        <Link to="/decks" className="inline-action">
          <ArrowLeft className="inline-icon" aria-hidden size={14} />
          back to library
        </Link>
      </div>
    );
  }
  if (!deck) {
    return <div className="page empty">Loading deck…</div>;
  }

  const slide = deck.manifest.slides[currentIdx - 1];
  const next = deck.manifest.slides[currentIdx];
  const slideUrl = slide
    ? storageAssetUrl(deck.id, slide.file, deck.storageToken)
    : '';
  const nextSlideUrl = next
    ? storageAssetUrl(deck.id, next.file, deck.storageToken)
    : null;
  const preloadSlideUrls = [deck.manifest.slides[currentIdx - 2], next]
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => storageAssetUrl(deck.id, s.file, deck.storageToken));

  const tool = presenter.state.tool;
  const blackoutColor = tool === 'blackout' ? '#000' : tool === 'whiteout' ? '#fff' : null;
  const layoutStyle = {
    '--presenter-side-width': `${sidePanelWidth}px`,
    '--presenter-notes-height': `${notesHeight}px`,
  } as CSSProperties;

  return (
    <div
      className="presenter-view"
      data-tool={tool}
      data-testid="presenter-view"
      style={layoutStyle}
    >
      <div className="presenter-view-toolbar">
        <button
          className="btn ghost"
          onClick={() => nav(`/decks/${encodeURIComponent(deck.id)}`)}
          aria-label="back to viewer"
        >
          <ArrowLeft className="btn-icon" aria-hidden size={16} />
          Single window
        </button>
        <h2 className="deck-title">{deck.title}</h2>
        <div className="deck-counter" data-testid="deck-counter">
          {currentIdx} / {deck.totalSlides}
        </div>
        <div className="deck-toolbar-spacer" />
        <button
          className="btn ghost icon-only"
          onClick={() => navApi.prev()}
          aria-label="previous slide"
        >
          <ChevronLeft className="btn-icon" aria-hidden size={18} />
        </button>
        <button
          className="btn ghost icon-only"
          onClick={() => navApi.next()}
          aria-label="next slide"
        >
          <ChevronRight className="btn-icon" aria-hidden size={18} />
        </button>
        <button
          className="btn ghost"
          onClick={() => setOverviewOpen(true)}
          data-testid="overview-button"
          aria-pressed={overviewOpen}
        >
          <Grid3X3 className="btn-icon" aria-hidden size={16} />
          Overview (O)
        </button>
        <button
          className="btn ghost"
          onClick={handleExport}
          data-testid="export-button"
          title="Download deck as a fresh .stage package (incl. edited notes)"
        >
          <Download className="btn-icon" aria-hidden size={16} />
          Export
        </button>
        <button
          type="button"
          className={`btn ${audienceConnected ? 'ghost' : 'primary'}`}
          onClick={openAudienceWindow}
          data-testid="open-audience"
        >
          {audienceConnected
            ? (
              <>
                <Radio className="btn-icon" aria-hidden size={16} />
                Audience window: Live
              </>
            )
            : (
              <>
                <ExternalLink className="btn-icon" aria-hidden size={16} />
                Open audience window
              </>
            )}
        </button>
      </div>

      <div className="presenter-view-body">
        <div className="presenter-host" ref={stageHostRef} data-testid="presenter-host">
          <DeckStage
            src={slideUrl}
            width={deck.width}
            height={deck.height}
            testId="deck-stage-wrapper"
            preloadSrcs={preloadSlideUrls}
            sandbox={sandboxForCompat(deck.manifest.compat)}
          />
          <AnnotationOverlay
            width={deck.width}
            height={deck.height}
            layout={stageLayout}
            presenter={presenter}
            slideIdx={currentIdx}
            hostRef={stageHostRef}
            onDraftChange={handleDraftChange}
          />
          <LaserPointer
            hostRef={stageHostRef}
            active={tool === 'laser'}
            layout={stageLayout}
            onPointerPos={handlePointerPos}
          />
          <Spotlight
            hostRef={stageHostRef}
            active={tool === 'spotlight'}
            layout={stageLayout}
            onPointerPos={handlePointerPos}
            radius={presenter.state.spotlightRadius}
            onResize={presenter.nudgeSpotlightRadius}
          />
          <Blackout color={blackoutColor} />
          <Toolbar
            hostRef={stageHostRef}
            presenter={presenter}
            slideIdx={currentIdx}
            mode="right-dock"
          />
        </div>

        <div
          className="presenter-resizer presenter-side-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize presenter side panel"
          data-testid="presenter-side-resizer"
          onPointerDown={startSideResize}
        />

        <aside
          className="presenter-side"
          aria-label="presenter side panel"
          data-testid="presenter-side"
        >
          <section className="presenter-side-card">
            <h3>Up next</h3>
            {next && nextSlideUrl ? (
              <div className="presenter-next">
                <DeckStage
                  src={nextSlideUrl}
                  width={deck.width}
                  height={deck.height}
                  className="mini"
                  noScripts
                />
                <div className="presenter-next-label muted">
                  #{next.index} {next.label || next.id}
                </div>
              </div>
            ) : (
              <div className="muted">— end of deck —</div>
            )}
          </section>

          <section className="presenter-side-card">
            <h3>Timer</h3>
            <div className="presenter-timer" data-testid="presenter-timer">
              {formatElapsed(elapsedMs)}
            </div>
            <button
              type="button"
              className="btn ghost small"
              onClick={resetTimer}
              data-testid="presenter-timer-reset"
            >
              Reset
            </button>
          </section>

          <section className="presenter-side-card">
            <h3>Audience window</h3>
            <div
              className={`presenter-audience-status ${
                audienceConnected ? 'live' : 'idle'
              }`}
              data-testid="audience-status"
            >
              <span className="status-dot" aria-hidden />
              {audienceConnected ? 'Live' : 'Disconnected'}
            </div>
            <p className="muted small">
              {audienceConnected
                ? 'Strokes, slide index & cursor mirror in real time.'
                : 'Click the orange button up top to launch the audience window.'}
            </p>
          </section>
        </aside>
      </div>

      <div
        className="presenter-resizer presenter-notes-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize speaker notes panel"
        data-testid="presenter-notes-resizer"
        onPointerDown={startNotesResize}
      />

      <div className="presenter-notes" data-testid="speaker-notes">
        <EditableNotes
          slideIdx={currentIdx}
          value={notesValue}
          status={notesSync.status}
          errorMessage={notesSync.errorMessage}
          onChange={(v) => notesSync.setNote(currentIdx, v)}
          onRetry={() => void notesSync.flush()}
          variant="strip"
          editing={notesEditing}
          onEnterEdit={() => setNotesEditing(true)}
          onExitEdit={exitNotesEdit}
        />
        <NotesHistory
          deckId={deck.id}
          refreshKey={notesSync.status}
          variant="strip"
        />
      </div>

      {overviewOpen && (
        <Overview
          manifest={deck.manifest}
          deckId={deck.id}
          storageToken={deck.storageToken}
          currentIdx={currentIdx}
          onPick={goto}
          onClose={() => setOverviewOpen(false)}
        />
      )}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
