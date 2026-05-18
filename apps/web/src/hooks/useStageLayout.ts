import { useEffect, useRef, useState, type RefObject } from 'react';

export interface StageLayout {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Wrapper width in viewport pixels. Useful for pointer math. */
  containerWidth: number;
  containerHeight: number;
}

/**
 * Computes the letterbox transform that fits a logical (logicalW × logicalH)
 * canvas inside the element pointed to by `containerRef`. Recomputes on
 * resize via ResizeObserver. The same hook is used by DeckStage *and* the
 * annotation overlay so coordinates always agree.
 *
 * The hook tolerates `containerRef.current` being `null` on first render
 * (e.g. when a parent renders a loading state before mounting the host
 * element). It mirrors the ref into local state via a render-time effect
 * so the ResizeObserver effect re-runs once the element actually attaches.
 */
export function useStageLayout(
  containerRef: RefObject<HTMLElement | null>,
  logicalW: number,
  logicalH: number,
): StageLayout {
  const [layout, setLayout] = useState<StageLayout>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    containerWidth: logicalW,
    containerHeight: logicalH,
  });
  const lastSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const [observedEl, setObservedEl] = useState<HTMLElement | null>(
    () => containerRef.current,
  );

  // Sync ref → state on every render. setState bails out when the value
  // is identity-equal, so this never causes an extra render once attached.
  useEffect(() => {
    if (containerRef.current !== observedEl) {
      setObservedEl(containerRef.current);
    }
  });

  useEffect(() => {
    if (!observedEl) return;
    const el = observedEl;

    function recalc(): void {
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      if (vw <= 0 || vh <= 0) return;
      if (lastSizeRef.current.w === vw && lastSizeRef.current.h === vh) {
        // Avoid re-renders if nothing changed.
        return;
      }
      lastSizeRef.current = { w: vw, h: vh };
      const scale = Math.min(vw / logicalW, vh / logicalH);
      const offsetX = (vw - logicalW * scale) / 2;
      const offsetY = (vh - logicalH * scale) / 2;
      setLayout({
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        offsetX: Number.isFinite(offsetX) ? offsetX : 0,
        offsetY: Number.isFinite(offsetY) ? offsetY : 0,
        containerWidth: vw,
        containerHeight: vh,
      });
    }

    // Force a recompute when (re)attaching to a new element — the cached
    // dimensions in lastSizeRef belong to a previous element and would
    // otherwise short-circuit the first call when sizes happen to match.
    lastSizeRef.current = { w: 0, h: 0 };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    window.addEventListener('resize', recalc);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recalc);
    };
  }, [observedEl, logicalW, logicalH]);

  return layout;
}

/**
 * Convert a viewport-pixel point to logical (manifest.dimensions) coordinates.
 * `clientX/Y` come straight from a PointerEvent; pass the wrapper's bounding
 * rect so we don't read it on every pointer move.
 */
export function viewportToStage(
  clientX: number,
  clientY: number,
  wrapperRect: { left: number; top: number },
  layout: StageLayout,
): [number, number] {
  const x = clientX - wrapperRect.left - layout.offsetX;
  const y = clientY - wrapperRect.top - layout.offsetY;
  return [x / layout.scale, y / layout.scale];
}
