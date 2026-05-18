import type { Stroke } from '@slidestage/shared';

export type Tool =
  | 'mouse'
  | 'laser'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'spotlight'
  | 'blackout'
  | 'whiteout';

export const PEN_COLORS = [
  '#FF3B30', // red
  '#FF9500', // orange
  '#FFCC00', // yellow
  '#0A84FF', // blue
  '#34C759', // green
] as const;
export type PenColor = (typeof PEN_COLORS)[number];

export const HIGHLIGHTER_ALPHA = 0.42;
export const HIGHLIGHTER_WIDTH = 18;
export const PEN_WIDTH = 4;

// Spotlight aperture (radius of the visible circle). User-adjustable at
// runtime via wheel / `[` `]` / toolbar slider — see usePresenter +
// Spotlight + Toolbar. Stepped in 16px increments so wheel scrolling and
// keyboard nudges land on the same lattice the slider can produce.
export const SPOTLIGHT_MIN_RADIUS = 80;
export const SPOTLIGHT_MAX_RADIUS = 480;
export const SPOTLIGHT_STEP = 16;
export const SPOTLIGHT_DEFAULT_RADIUS = 240;
export const SPOTLIGHT_STORAGE_KEY = 'slidestage.spotlight-radius';
/** @deprecated Use SPOTLIGHT_DEFAULT_RADIUS. Kept as alias for back-compat. */
export const SPOTLIGHT_RADIUS = SPOTLIGHT_DEFAULT_RADIUS;

/**
 * Clamp a candidate radius into [MIN, MAX] and snap to the STEP lattice
 * so wheel deltas / slider input always converge to the same set of
 * persistable values.
 */
export function clampSpotlightRadius(value: number): number {
  if (!Number.isFinite(value)) return SPOTLIGHT_DEFAULT_RADIUS;
  const snapped = Math.round(value / SPOTLIGHT_STEP) * SPOTLIGHT_STEP;
  return Math.max(
    SPOTLIGHT_MIN_RADIUS,
    Math.min(SPOTLIGHT_MAX_RADIUS, snapped),
  );
}

export function toHighlighterColor(color: PenColor): string {
  const hex = color.replace('#', '');
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${HIGHLIGHTER_ALPHA})`;
}

export interface PresenterState {
  tool: Tool;
  /** Active drawing color (1-5 keys), reused by pen and highlighter. */
  penColor: PenColor;
  /** Per-slide stroke arrays, keyed by 1-based slide index. */
  strokesByIdx: Record<number, Stroke[]>;
  /** True while user is mid-drag drawing a single stroke. */
  drafting: boolean;
  /**
   * Current spotlight aperture in CSS pixels (radius of the lit circle).
   * Hydrated from localStorage on mount so the preference survives reload.
   */
  spotlightRadius: number;
}
