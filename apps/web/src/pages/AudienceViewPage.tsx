/**
 * Big-screen / projection view. Pure mirror of whatever the presenter window
 * pushes over BroadcastChannel — slide index, tool (incl. blackout/whiteout/
 * spotlight), strokes, in-flight ink, laser cursor.
 *
 * No toolbar. No counter. No keyboard shortcuts other than Esc to close
 * full-screen. Pointer events are disabled across the entire stage so an
 * accidental click on the projection screen never alters state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DeckStage } from '../components/DeckStage.js';
import { useDeckFontWarmup } from '../hooks/useDeckFontWarmup.js';
import { useStageLayout } from '../hooks/useStageLayout.js';
import { useDeckLoader, useInitialAnnotations } from '../hooks/useDeckLoader.js';
import { AnnotationOverlay } from '../presenter/AnnotationOverlay.js';
import { Blackout } from '../presenter/Blackout.js';
import { LaserPointer } from '../presenter/LaserPointer.js';
import { Spotlight } from '../presenter/Spotlight.js';
import { SPOTLIGHT_DEFAULT_RADIUS } from '../presenter/types.js';
import { usePresenter } from '../presenter/usePresenter.js';
import {
  usePresentationSync,
  type SyncMessage,
} from '../presenter/usePresentationSync.js';
import type { Stroke } from '@slidestage/shared';
import { sandboxForCompat } from '../utils/iframeSandbox.js';
import { storageAssetUrl } from '../utils/storageUrl.js';

export function AudienceViewPage(): JSX.Element {
  const { deckId: rawDeckId = '' } = useParams<{ deckId: string }>();
  const deckId = decodeURIComponent(rawDeckId);

  const { deck, error } = useDeckLoader(deckId);
  const presenter = usePresenter();
  const [currentIdx, setCurrentIdx] = useState<number>(1);
  const [externalDraft, setExternalDraft] = useState<{
    slideIdx: number;
    stroke: Stroke;
  } | null>(null);
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [presenterAlive, setPresenterAlive] = useState(false);
  const [spotlightRadius, setSpotlightRadius] = useState<number>(
    SPOTLIGHT_DEFAULT_RADIUS,
  );

  const stageHostRef = useRef<HTMLDivElement | null>(null);

  // Best-effort initial annotations: even if the presenter never sends a
  // snapshot (e.g. user opens the audience link directly without a presenter
  // window), the stored strokes still show up.
  useInitialAnnotations(deck ? deck.id : null, presenter.loadStrokes);

  const handleMessage = useCallback(
    (msg: SyncMessage) => {
      switch (msg.type) {
        case 'hello':
          if (msg.role === 'presenter') setPresenterAlive(true);
          break;
        case 'snapshot':
          presenter.loadStrokes(msg.state.strokesByIdx);
          presenter.setTool(msg.state.tool);
          presenter.setColor(msg.state.penColor);
          setCurrentIdx(msg.state.slideIdx);
          if (typeof msg.state.spotlightRadius === 'number') {
            setSpotlightRadius(msg.state.spotlightRadius);
          }
          setPresenterAlive(true);
          break;
        case 'slide':
          setCurrentIdx(msg.slideIdx);
          break;
        case 'tool':
          presenter.setTool(msg.tool);
          break;
        case 'color':
          presenter.setColor(msg.color);
          break;
        case 'strokes':
          presenter.replaceSlideStrokes(msg.slideIdx, msg.strokes);
          break;
        case 'draft':
          setExternalDraft(
            msg.stroke ? { slideIdx: msg.slideIdx, stroke: msg.stroke } : null,
          );
          break;
        case 'pointer':
          setPointerPos(msg.pos);
          break;
        case 'spotlight-radius':
          setSpotlightRadius(msg.radius);
          break;
        default:
          break;
      }
    },
    [presenter],
  );

  const sync = usePresentationSync({
    deckId,
    role: 'audience',
    onMessage: handleMessage,
  });

  // Once the deck loads, ask the presenter for a fresh snapshot. This
  // covers the case where this audience window was opened *after* the
  // presenter had already changed slides / drawn strokes — the "hello"
  // alone might race with the presenter's own snapshot trigger.
  useEffect(() => {
    if (!deck) return;
    sync.send({ type: 'request-snapshot' });
  }, [deck, sync]);

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
    return <div className="audience-view audience-loading">Loading deck…</div>;
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
  const draftForCurrent =
    externalDraft && externalDraft.slideIdx === currentIdx
      ? externalDraft.stroke
      : null;

  return (
    <div className="audience-view" data-testid="audience-view" data-tool={tool}>
      <div
        className="presenter-host audience-host"
        ref={stageHostRef}
        data-testid="audience-host"
      >
        <DeckStage
          src={slideUrl}
          width={deck.width}
          height={deck.height}
          testId="audience-stage-wrapper"
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
          readOnly
          externalDraft={draftForCurrent}
        />
        <LaserPointer
          hostRef={stageHostRef}
          active={tool === 'laser'}
          layout={stageLayout}
          externalLogicalPos={pointerPos}
        />
        <Spotlight
          hostRef={stageHostRef}
          active={tool === 'spotlight'}
          layout={stageLayout}
          externalLogicalPos={pointerPos}
          radius={spotlightRadius}
        />
        <Blackout color={blackoutColor} />
      </div>
      <div
        className={`audience-status ${presenterAlive ? 'live' : 'idle'}`}
        data-testid="audience-presenter-status"
      >
        <span className="status-dot" aria-hidden />
        {presenterAlive ? 'Linked' : 'Waiting for presenter…'}
      </div>
    </div>
  );
}
