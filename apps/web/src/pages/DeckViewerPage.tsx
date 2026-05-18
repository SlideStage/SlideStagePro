import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Grid3X3,
  Pencil,
  Presentation,
  StickyNote,
  WifiOff,
} from 'lucide-react';
import { api, type DeckDetail } from '../api/client.js';
import { DeckInfoEditor } from '../components/DeckInfoEditor.js';
import { DeckStage } from '../components/DeckStage.js';
import { Overview } from '../components/Overview.js';
import { SpeakerNotes } from '../components/SpeakerNotes.js';
import { useDeckFontWarmup } from '../hooks/useDeckFontWarmup.js';
import { useKeyboardNav } from '../hooks/useKeyboardNav.js';
import { useNotesSync } from '../hooks/useNotesSync.js';
import { useStageLayout } from '../hooks/useStageLayout.js';
import { AnnotationOverlay } from '../presenter/AnnotationOverlay.js';
import { Blackout } from '../presenter/Blackout.js';
import { LaserPointer } from '../presenter/LaserPointer.js';
import { Spotlight } from '../presenter/Spotlight.js';
import { Toolbar } from '../presenter/Toolbar.js';
import {
  usePresenter,
  usePresenterShortcuts,
} from '../presenter/usePresenter.js';
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

// Stable placeholder for the loading window before `deck` is fetched.
// Keeping the reference stable prevents `useNotesSync`'s manifest effect from
// re-running on every render.
const EMPTY_MANIFEST = {
  slides: [],
  dimensions: { width: 1920, height: 1080 },
} as unknown as DeckDetail['manifest'];

export function DeckViewerPage(): JSX.Element {
  const { deckId: rawDeckId = '' } = useParams<{ deckId: string }>();
  const deckId = decodeURIComponent(rawDeckId);
  const nav = useNavigate();

  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState<number>(1);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [speakerOpen, setSpeakerOpen] = useState(false);
  const [infoEditorOpen, setInfoEditorOpen] = useState(false);

  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const presenter = usePresenter();

  // Fetch deck detail.
  useEffect(() => {
    let cancelled = false;
    api
      .getDeck(deckId)
      .then((d) => {
        if (cancelled) return;
        setDeck(d);
        setCurrentIdx(readHashIndex(d.totalSlides));
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  // Load existing annotations once when the deck arrives.
  useEffect(() => {
    if (!deck) return;
    let cancelled = false;
    api
      .getAnnotations(deck.id)
      .then((res) => {
        if (cancelled) return;
        presenter.loadStrokes(res.annotations);
      })
      .catch(() => {
        // soft-fail — continue with empty annotations
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck?.id]);

  // Keep URL hash in sync.
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

  // External hash changes (back/forward, manual edit).
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
      toggleSpeakerView: () => setSpeakerOpen((v) => !v),
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

  // Esc closes overlays (already handled by presenter shortcut for tools).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (overviewOpen) setOverviewOpen(false);
        else if (speakerOpen) setSpeakerOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overviewOpen, speakerOpen]);

  const stageLayout = useStageLayout(
    stageHostRef,
    deck?.width ?? 1920,
    deck?.height ?? 1080,
  );

  // Pre-warm deck-level stylesheets (and their @import'd webfonts) into the
  // browser's HTTP cache so the first slide iframe doesn't pay the full
  // download cost. See the hook for the why.
  useDeckFontWarmup({
    deckId: deck?.id,
    manifest: deck?.manifest,
    storageToken: deck?.storageToken,
  });

  const slideStrokes = presenter.state.strokesByIdx[currentIdx] ?? [];
  useStrokeSync({
    deckId,
    slideIdx: currentIdx,
    strokes: slideStrokes,
  });

  // Speaker-notes sync — keep the local manifest mirror in sync after each
  // server PATCH so reopening the deck (or pressing Speaker again) shows the
  // freshest text without a full reload.
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
    [],
  );

  const notesSync = useNotesSync({
    deckId,
    manifest: deck?.manifest ?? EMPTY_MANIFEST,
    activeSlideIdx: currentIdx,
    onPersisted: onNotesPersisted,
  });
  const notesValue = notesSync.notes[currentIdx] ?? '';

  // Edit-mode lock for the speaker notes editor (see EditableNotes header
  // comment). Default false so a presenter who clicks the speaker panel
  // mid-talk doesn't accidentally trap nav keys.
  const [notesEditing, setNotesEditing] = useState(false);
  const exitNotesEdit = useCallback(() => {
    setNotesEditing(false);
    void notesSync.flush();
  }, [notesSync]);

  // Closing the speaker side panel (`S`) leaves Edit mode automatically and
  // flushes any pending edits — there's nothing visible to edit anymore.
  useEffect(() => {
    if (!speakerOpen && notesEditing) {
      setNotesEditing(false);
      void notesSync.flush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakerOpen]);

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
  const slideUrl = slide
    ? storageAssetUrl(deck.id, slide.file, deck.storageToken)
    : '';
  const preloadSlideUrls = [deck.manifest.slides[currentIdx - 2], deck.manifest.slides[currentIdx]]
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => storageAssetUrl(deck.id, s.file, deck.storageToken));

  const tool = presenter.state.tool;
  const blackoutColor = tool === 'blackout' ? '#000' : tool === 'whiteout' ? '#fff' : null;

  return (
    <div className="deck-viewer" data-tool={tool}>
      <div className="deck-viewer-toolbar">
        <button
          className="btn ghost"
          onClick={() => nav('/decks')}
          aria-label="back to library"
        >
          <ArrowLeft className="btn-icon" aria-hidden size={16} />
          Library
        </button>
        <h2 className="deck-title">{deck.title}</h2>
        {deck.manifest.offline ? (
          <span
            className={`deck-offline-badge${deck.manifest.offline.ready ? ' ready' : ' partial'}`}
            data-testid="deck-offline-badge"
            data-offline-ready={deck.manifest.offline.ready ? 'true' : 'false'}
            title={
              deck.manifest.offline.ready
                ? `Offline ready · ${deck.manifest.offline.mirroredAssets.length} mirrored assets · packed at ${deck.manifest.offline.mirroredAt}`
                : `Partial offline · ${deck.manifest.offline.mirroredAssets.length} mirrored, ${deck.manifest.offline.skippedUrls.length} skipped`
            }
          >
            <WifiOff className="btn-icon" aria-hidden size={12} />
            {deck.manifest.offline.ready ? 'Offline ready' : 'Partial offline'}
          </span>
        ) : null}
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
          onClick={() => setSpeakerOpen((v) => !v)}
          data-testid="speaker-button"
          aria-pressed={speakerOpen}
        >
          <StickyNote className="btn-icon" aria-hidden size={16} />
          Speaker (S)
        </button>
        <button
          className="btn ghost"
          onClick={() => setInfoEditorOpen(true)}
          data-testid="edit-info-button"
          title="Edit deck title, subtitle, author, description and slide labels"
        >
          <Pencil className="btn-icon" aria-hidden size={16} />
          Edit info
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
          className="btn primary"
          onClick={() =>
            nav(
              `/decks/${encodeURIComponent(deck.id)}/presenter#${currentIdx}`,
            )
          }
          data-testid="present-button"
          title="Open PowerPoint-style presenter view (with separate audience window)"
        >
          <Presentation className="btn-icon" aria-hidden size={16} />
          Present
        </button>
      </div>

      <div className={`deck-viewer-body${speakerOpen ? ' with-speaker' : ''}`}>
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
          />
          <LaserPointer hostRef={stageHostRef} active={tool === 'laser'} />
          <Spotlight
            hostRef={stageHostRef}
            active={tool === 'spotlight'}
            radius={presenter.state.spotlightRadius}
            onResize={presenter.nudgeSpotlightRadius}
          />
          <Blackout color={blackoutColor} />
          <Toolbar
            hostRef={stageHostRef}
            presenter={presenter}
            slideIdx={currentIdx}
          />
        </div>
        {speakerOpen && (
          <SpeakerNotes
            manifest={deck.manifest}
            deckId={deck.id}
            storageToken={deck.storageToken}
            currentIdx={currentIdx}
            editor={{
              value: notesValue,
              status: notesSync.status,
              errorMessage: notesSync.errorMessage,
              onChange: (v) => notesSync.setNote(currentIdx, v),
              onRetry: () => void notesSync.flush(),
              editing: notesEditing,
              onEnterEdit: () => setNotesEditing(true),
              onExitEdit: exitNotesEdit,
            }}
            onClose={() => setSpeakerOpen(false)}
          />
        )}
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

      {infoEditorOpen && (
        <DeckInfoEditor
          deckId={deck.id}
          manifest={deck.manifest}
          onPersisted={(persistedDeck, labels, manifestUpdatedAt) => {
            setDeck((d) => {
              if (!d) return d;
              return {
                ...d,
                ...persistedDeck,
                updatedAt: manifestUpdatedAt,
                manifest: {
                  ...d.manifest,
                  ...persistedDeck,
                  updatedAt: manifestUpdatedAt,
                  slides: d.manifest.slides.map((s) => ({
                    ...s,
                    label: labels[s.index] ?? s.label,
                  })),
                },
              };
            });
          }}
          onClose={() => setInfoEditorOpen(false)}
        />
      )}
    </div>
  );
}
