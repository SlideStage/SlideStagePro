/**
 * Renders a 14px red dot following the pointer plus an 800ms trail when the
 * pointer is held down. Coordinates with the host wrapper's bounding rect to
 * match the iframe stage exactly. Mounts a window-level pointermove listener
 * so it doesn't interfere with the iframe's pointer-events.
 */

import { useEffect, useRef, useState } from 'react';
import type { StageLayout } from '../hooks/useStageLayout.js';

interface Props {
  hostRef: { current: HTMLElement | null };
  /** When false, component renders nothing. */
  active: boolean;
  /**
   * If provided, the dot is rendered at this logical-coord position instead
   * of being driven by local pointer events. `null` clears the dot.
   * Used by the audience window to mirror the presenter's cursor.
   */
  externalLogicalPos?: { x: number; y: number } | null;
  /** Stage layout used to convert logical coordinates to viewport coordinates. */
  layout?: StageLayout;
  /** Notifies on each local pointer-pos change in logical coords (presenter only). */
  onPointerPos?: (pos: { x: number; y: number } | null) => void;
}

interface Trail {
  id: number;
  x: number;
  y: number;
  born: number;
}

const TRAIL_LIFETIME_MS = 800;

export function LaserPointer({
  hostRef,
  active,
  externalLogicalPos = undefined,
  layout,
  onPointerPos,
}: Props): JSX.Element | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [trails, setTrails] = useState<Trail[]>([]);
  const downRef = useRef(false);
  const trailIdRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const isMirror = externalLogicalPos !== undefined;

  // Local pointer mode (presenter / standalone viewer).
  useEffect(() => {
    if (!active || isMirror) {
      if (!isMirror) setPos(null);
      setTrails([]);
      return;
    }
    const node = hostRef.current;
    if (!node) return;

    function updatePos(ev: PointerEvent): void {
      const rect = node!.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        setPos(null);
        onPointerPos?.(null);
        return;
      }
      setPos({ x, y });
      if (layout && layout.scale > 0) {
        onPointerPos?.({
          x: (x - layout.offsetX) / layout.scale,
          y: (y - layout.offsetY) / layout.scale,
        });
      } else {
        onPointerPos?.({ x, y });
      }
      if (downRef.current) {
        const trail: Trail = {
          id: trailIdRef.current++,
          x,
          y,
          born: performance.now(),
        };
        setTrails((prev) => [...prev, trail]);
      }
    }

    function onDown(ev: PointerEvent): void {
      if (ev.button !== 0) return;
      downRef.current = true;
      updatePos(ev);
    }
    function onUp(): void {
      downRef.current = false;
    }
    function onLeave(): void {
      setPos(null);
      onPointerPos?.(null);
      downRef.current = false;
    }

    node.addEventListener('pointermove', updatePos);
    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointerleave', onLeave);

    // Periodically expire old trail dots.
    function tick(): void {
      const now = performance.now();
      setTrails((prev) =>
        prev.filter((t) => now - t.born < TRAIL_LIFETIME_MS),
      );
      rafRef.current = window.requestAnimationFrame(tick);
    }
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      node.removeEventListener('pointermove', updatePos);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointerleave', onLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active, hostRef, isMirror, layout, onPointerPos]);

  // External (audience-mirror) mode: map logical coordinates via layout.
  useEffect(() => {
    if (!isMirror) return;
    if (!active || !externalLogicalPos || !layout) {
      setPos(null);
      return;
    }
    const x = externalLogicalPos.x * layout.scale + layout.offsetX;
    const y = externalLogicalPos.y * layout.scale + layout.offsetY;
    setPos({ x, y });
  }, [isMirror, active, externalLogicalPos, layout]);

  // Always run the trail-expiry tick on the audience side as well so the
  // trail (if we ever broadcast trails) decays.
  useEffect(() => {
    if (!isMirror || !active) return;
    function tick(): void {
      const now = performance.now();
      setTrails((prev) =>
        prev.filter((t) => now - t.born < TRAIL_LIFETIME_MS),
      );
      rafRef.current = window.requestAnimationFrame(tick);
    }
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isMirror, active]);

  if (!active) return null;

  return (
    <div
      className="laser-overlay"
      data-testid="laser-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {trails.map((t) => {
        const age = performance.now() - t.born;
        const alpha = Math.max(0, 1 - age / TRAIL_LIFETIME_MS);
        return (
          <span
            key={t.id}
            className="laser-trail"
            style={{
              position: 'absolute',
              left: t.x - 6,
              top: t.y - 6,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: `rgba(255, 59, 48, ${alpha * 0.6})`,
              pointerEvents: 'none',
              boxShadow: `0 0 12px rgba(255, 59, 48, ${alpha * 0.8})`,
            }}
          />
        );
      })}
      {pos && (
        <span
          className="laser-dot"
          data-testid="laser-dot"
          style={{
            position: 'absolute',
            left: pos.x - 7,
            top: pos.y - 7,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#FF3B30',
            boxShadow: '0 0 16px rgba(255, 59, 48, 0.9)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
