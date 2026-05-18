/**
 * Spotlight: dims everything except a circle of `radius` around the cursor.
 * Implemented as a fixed div with a radial-gradient mask that follows pointer
 * coordinates relative to the host wrapper.
 *
 * The aperture is user-adjustable at runtime:
 *   - Mouse wheel on the host while spotlight is active (preventDefault).
 *   - `[` / `]` keyboard shortcut (handled in usePresenterShortcuts).
 *   - Toolbar slider (handled in Toolbar).
 *
 * Whenever the radius changes we surface a transient "240px" pill in the
 * upper-center of the host so the presenter sees the new value land — fades
 * out after 600ms of idle.
 */

import { useEffect, useRef, useState } from 'react';
import {
  SPOTLIGHT_DEFAULT_RADIUS,
  SPOTLIGHT_STEP,
  clampSpotlightRadius,
} from './types.js';
import type { StageLayout } from '../hooks/useStageLayout.js';

const PILL_VISIBLE_MS = 600;

interface Props {
  hostRef: { current: HTMLElement | null };
  active: boolean;
  /** Current aperture in CSS pixels. Falls back to the default. */
  radius?: number;
  /**
   * Called when the user nudges the aperture via the wheel. Negative
   * delta shrinks; positive grows. Omit on audience-mirror views to
   * make the spotlight read-only over there.
   */
  onResize?: (delta: number) => void;
  /** When provided, drives the spotlight from a remote presenter (logical coords). */
  externalLogicalPos?: { x: number; y: number } | null;
  layout?: StageLayout;
  onPointerPos?: (pos: { x: number; y: number } | null) => void;
}

export function Spotlight({
  hostRef,
  active,
  radius = SPOTLIGHT_DEFAULT_RADIUS,
  onResize,
  externalLogicalPos = undefined,
  layout,
  onPointerPos,
}: Props): JSX.Element | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const isMirror = externalLogicalPos !== undefined;
  const safeRadius = clampSpotlightRadius(radius);

  useEffect(() => {
    if (!active || isMirror) {
      if (!isMirror) setPos(null);
      return;
    }
    const node = hostRef.current;
    if (!node) return;

    function onMove(ev: PointerEvent): void {
      const rect = node!.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      setPos({ x, y });
      if (layout && layout.scale > 0) {
        onPointerPos?.({
          x: (x - layout.offsetX) / layout.scale,
          y: (y - layout.offsetY) / layout.scale,
        });
      } else {
        onPointerPos?.({ x, y });
      }
    }
    function onLeave(): void {
      setPos(null);
      onPointerPos?.(null);
    }
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);
    return () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
    };
  }, [active, hostRef, isMirror, layout, onPointerPos]);

  // Wheel-to-resize. Attached non-passively so we can preventDefault the
  // page scroll while the spotlight owns the cursor — otherwise scrolling
  // the deck stage would also move the page underneath the spotlight.
  useEffect(() => {
    if (!active || isMirror || !onResize) return;
    const node = hostRef.current;
    if (!node) return;
    function onWheel(ev: WheelEvent): void {
      ev.preventDefault();
      // Each notch on a standard wheel reports deltaY ≈ ±100. Map every
      // notch to exactly one STEP (16px) so users get the same lattice
      // as the slider / bracket keys. We treat horizontal deltas the
      // same — trackpad two-finger flicks on macOS sometimes split a
      // gesture into both axes.
      const raw = ev.deltaY !== 0 ? ev.deltaY : ev.deltaX;
      if (raw === 0) return;
      const delta = raw > 0 ? -SPOTLIGHT_STEP : SPOTLIGHT_STEP;
      onResize!(delta);
    }
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
    };
  }, [active, hostRef, isMirror, onResize]);

  useEffect(() => {
    if (!isMirror) return;
    if (!active || !externalLogicalPos || !layout) {
      setPos(null);
      return;
    }
    setPos({
      x: externalLogicalPos.x * layout.scale + layout.offsetX,
      y: externalLogicalPos.y * layout.scale + layout.offsetY,
    });
  }, [isMirror, active, externalLogicalPos, layout]);

  // ── Size-change pill ─────────────────────────────────────────────
  // Show the new radius in a fading badge whenever it changes (skip the
  // initial mount). 600ms is short enough to feel responsive while still
  // letting the eye land on the number.
  const [pillVisible, setPillVisible] = useState(false);
  const pillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRadiusRef = useRef<number>(safeRadius);
  useEffect(() => {
    if (!active) {
      setPillVisible(false);
      return;
    }
    if (lastRadiusRef.current === safeRadius) return;
    lastRadiusRef.current = safeRadius;
    setPillVisible(true);
    if (pillTimerRef.current) clearTimeout(pillTimerRef.current);
    pillTimerRef.current = setTimeout(() => setPillVisible(false), PILL_VISIBLE_MS);
  }, [safeRadius, active]);
  useEffect(() => {
    return () => {
      if (pillTimerRef.current) clearTimeout(pillTimerRef.current);
    };
  }, []);

  if (!active) return null;

  // When pointer hasn't moved yet, place the spotlight in the center of the
  // host so the user can already see something.
  const node = hostRef.current;
  const center = node
    ? { x: node.clientWidth / 2, y: node.clientHeight / 2 }
    : { x: 0, y: 0 };
  const p = pos ?? center;

  return (
    <>
      <div
        className="spotlight-overlay"
        data-testid="spotlight-overlay"
        data-spotlight-radius={safeRadius}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: `radial-gradient(circle ${safeRadius}px at ${p.x}px ${p.y}px, transparent 0%, transparent 70%, rgba(0,0,0,0.85) 100%)`,
          transition: 'background 60ms linear',
        }}
      />
      <div
        className={`spotlight-size-pill${pillVisible ? ' visible' : ''}`}
        data-testid="spotlight-size-pill"
        data-visible={pillVisible ? 'true' : 'false'}
        aria-live="polite"
      >
        {safeRadius}px
      </div>
    </>
  );
}
