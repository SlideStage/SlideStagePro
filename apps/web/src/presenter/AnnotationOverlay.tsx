/**
 * Full-screen overlay sized to the wrapper element. Renders existing strokes
 * as SVG paths in logical (1920×1080-ish) coordinates so they keep crisp on
 * any zoom level — the parent wrapper supplies a transform that mirrors the
 * iframe stage's letterbox math.
 *
 * Handles pointer events for pen / highlighter / eraser tools. Other tools
 * (laser, spotlight, blackout, whiteout) are rendered by sibling components.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
/* eslint-disable react-hooks/exhaustive-deps */
import type { Stroke } from '@slidestage/shared';
import {
  HIGHLIGHTER_WIDTH,
  PEN_WIDTH,
  toHighlighterColor,
} from './types.js';
import type { PresenterApi } from './usePresenter.js';
import {
  viewportToStage,
  type StageLayout,
} from '../hooks/useStageLayout.js';

interface Props {
  width: number;
  height: number;
  layout: StageLayout;
  presenter: PresenterApi;
  slideIdx: number; // 1-based
  /** Optional ref to an element used as the bounding rect source (defaults to overlay's own). */
  hostRef?: { current: HTMLElement | null };
  /** When true, the overlay never captures pointer events and never accepts draws. */
  readOnly?: boolean;
  /** Notifies on draft (in-flight) stroke updates — used by presenter sync. */
  onDraftChange?: (stroke: Stroke | null) => void;
  /** External draft stroke to render on top (used by audience side). */
  externalDraft?: Stroke | null;
}

interface DraftStroke {
  pointerId: number;
  stroke: Stroke;
}

export function AnnotationOverlay({
  width,
  height,
  layout,
  presenter,
  slideIdx,
  hostRef,
  readOnly = false,
  onDraftChange,
  externalDraft = null,
}: Props): JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // We keep the in-progress stroke in a ref so pointer-move callbacks see
  // the latest points without waiting for a React re-render. A separate
  // "tick" counter forces SVG re-renders on each move.
  const draftRef = useRef<DraftStroke | null>(null);
  const [, setDraftTick] = useState(0);
  const draft = draftRef.current;
  const bumpDraft = (): void => setDraftTick((n) => (n + 1) % 1_000_000);

  const strokes = presenter.state.strokesByIdx[slideIdx] ?? [];
  const tool = presenter.state.tool;
  // Audience / mirror windows never accept pointer events, never draw.
  // Otherwise the overlay always captures pointer events when a non-default
  // tool is active so siblings (LaserPointer / Spotlight) can read
  // coordinates by listening on the host wrapper. Drawing handlers below
  // check `enabled` before recording a stroke.
  const captures = !readOnly && tool !== 'mouse';
  const enabled =
    !readOnly &&
    (tool === 'pen' || tool === 'highlighter' || tool === 'eraser');

  // Re-arm cursor based on tool.
  const cursor =
    tool === 'pen'
      ? 'crosshair'
      : tool === 'highlighter'
      ? 'crosshair'
      : tool === 'eraser'
      ? 'cell'
      : 'default';

  const getRect = useCallback((): DOMRect | null => {
    const node = hostRef?.current ?? overlayRef.current;
    return node?.getBoundingClientRect() ?? null;
  }, [hostRef]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      if (e.button !== 0) return;
      const rect = getRect();
      if (!rect) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      const [x, y] = viewportToStage(e.clientX, e.clientY, rect, layout);

      if (tool === 'eraser') {
        // Hit-test once at down; we also re-test on move below.
        const idx = hitTestStroke(strokes, x, y);
        if (idx >= 0) presenter.removeStroke(slideIdx, idx);
        return;
      }

      const stroke: Stroke = {
        tool: tool === 'highlighter' ? 'highlighter' : 'pen',
        color:
          tool === 'highlighter'
            ? toHighlighterColor(presenter.state.penColor)
            : presenter.state.penColor,
        width: tool === 'highlighter' ? HIGHLIGHTER_WIDTH : PEN_WIDTH,
        points: [[x, y]],
        cid:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      };
      draftRef.current = { pointerId: e.pointerId, stroke };
      onDraftChange?.(stroke);
      bumpDraft();
    },
    [enabled, getRect, layout, tool, strokes, presenter, slideIdx, onDraftChange],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const rect = getRect();
      if (!rect) return;
      const [x, y] = viewportToStage(e.clientX, e.clientY, rect, layout);

      if (tool === 'eraser') {
        if (e.buttons & 1) {
          const idx = hitTestStroke(strokes, x, y);
          if (idx >= 0) presenter.removeStroke(slideIdx, idx);
        }
        return;
      }

      const cur = draftRef.current;
      if (!cur || cur.pointerId !== e.pointerId) return;
      e.preventDefault();
      cur.stroke.points.push([x, y]);
      onDraftChange?.(cur.stroke);
      bumpDraft();
    },
    [enabled, getRect, layout, tool, strokes, presenter, slideIdx, onDraftChange],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      if (tool === 'eraser') return;
      const cur = draftRef.current;
      if (!cur || cur.pointerId !== e.pointerId) return;
      e.preventDefault();
      // Commit the draft into the presenter store.
      if (cur.stroke.points.length >= 2) {
        presenter.appendStroke(slideIdx, cur.stroke);
      } else if (cur.stroke.points.length === 1) {
        // A tap — duplicate the point so it renders as a tiny dot.
        const [x, y] = cur.stroke.points[0]!;
        presenter.appendStroke(slideIdx, {
          ...cur.stroke,
          points: [
            [x, y],
            [x + 0.5, y + 0.5],
          ],
        });
      }
      draftRef.current = null;
      onDraftChange?.(null);
      bumpDraft();
    },
    [enabled, tool, presenter, slideIdx, onDraftChange],
  );

  // Cancel any in-flight draft when the tool changes.
  useEffect(() => {
    if (!(tool === 'pen' || tool === 'highlighter')) {
      if (draftRef.current) {
        draftRef.current = null;
        onDraftChange?.(null);
        bumpDraft();
      }
    }
  }, [tool, onDraftChange]);

  const overlayStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: captures ? 'auto' : 'none',
    cursor,
  };

  // The SVG itself is in logical coordinates; we apply the same translate +
  // scale transform as DeckStage so 1920×1080 strokes line up exactly.
  const svgWrapperStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width,
    height,
    transform: `translate(${layout.offsetX}px, ${layout.offsetY}px) scale(${layout.scale})`,
    transformOrigin: 'top left',
    pointerEvents: 'none',
  };

  return (
    <div
      ref={overlayRef}
      className="annotation-overlay"
      style={overlayStyle}
      data-testid="annotation-overlay"
      data-tool={tool}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div style={svgWrapperStyle}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block' }}
        >
          {strokes.map((s, i) => (
            <path
              key={`${s.cid ?? i}`}
              d={pointsToPath(s.points)}
              stroke={s.color}
              strokeWidth={s.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              data-stroke-idx={i}
              data-tool={s.tool}
            />
          ))}
          {draft && (
            <path
              d={pointsToPath(draft.stroke.points)}
              stroke={draft.stroke.color}
              strokeWidth={draft.stroke.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              data-draft="true"
            />
          )}
          {externalDraft && externalDraft.points.length > 0 && (
            <path
              d={pointsToPath(externalDraft.points)}
              stroke={externalDraft.color}
              strokeWidth={externalDraft.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              data-draft="external"
            />
          )}
        </svg>
      </div>
    </div>
  );
}

function pointsToPath(points: [number, number][]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  let d = `M ${first![0]} ${first![1]}`;
  for (const [x, y] of rest) {
    d += ` L ${x} ${y}`;
  }
  return d;
}

/**
 * Returns the index of the most recent stroke whose polyline passes within
 * a tolerance of (x, y), or -1. Iterating from the end means "top" strokes
 * win — matches user expectation that the eraser hits what they see on top.
 */
function hitTestStroke(strokes: Stroke[], x: number, y: number): number {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]!;
    const tol = Math.max(s.width, 12); // px in logical space
    const tolSq = tol * tol;
    const pts = s.points;
    for (let j = 0; j < pts.length - 1; j++) {
      const a = pts[j]!;
      const b = pts[j + 1]!;
      if (segmentDistanceSq(x, y, a[0], a[1], b[0], b[1]) <= tolSq) {
        return i;
      }
    }
    // Single-point stroke: distance to point.
    if (pts.length === 1) {
      const [px, py] = pts[0]!;
      if ((x - px) ** 2 + (y - py) ** 2 <= tolSq) return i;
    }
  }
  return -1;
}

function segmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}
