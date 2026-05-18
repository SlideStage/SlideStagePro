import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { Stroke } from '@slidestage/shared';
import {
  PEN_COLORS,
  SPOTLIGHT_DEFAULT_RADIUS,
  SPOTLIGHT_STEP,
  SPOTLIGHT_STORAGE_KEY,
  clampSpotlightRadius,
  type PenColor,
  type PresenterState,
  type Tool,
} from './types.js';

type Action =
  | { type: 'set-tool'; tool: Tool }
  | { type: 'set-color'; color: PenColor }
  | { type: 'load'; strokes: Record<number, Stroke[]> }
  | { type: 'append'; slideIdx: number; stroke: Stroke }
  | { type: 'remove'; slideIdx: number; strokeIdx: number }
  | { type: 'remove-cid'; slideIdx: number; cid: string }
  | { type: 'replace-slide'; slideIdx: number; strokes: Stroke[] }
  | { type: 'undo'; slideIdx: number }
  | { type: 'clear-slide'; slideIdx: number }
  | { type: 'set-spotlight-radius'; radius: number };

function readStoredSpotlightRadius(): number {
  if (typeof window === 'undefined') return SPOTLIGHT_DEFAULT_RADIUS;
  try {
    const raw = window.localStorage.getItem(SPOTLIGHT_STORAGE_KEY);
    if (!raw) return SPOTLIGHT_DEFAULT_RADIUS;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SPOTLIGHT_DEFAULT_RADIUS;
    return clampSpotlightRadius(n);
  } catch {
    return SPOTLIGHT_DEFAULT_RADIUS;
  }
}

function makeInitialState(): PresenterState {
  return {
    tool: 'mouse',
    penColor: PEN_COLORS[0],
    strokesByIdx: {},
    drafting: false,
    spotlightRadius: readStoredSpotlightRadius(),
  };
}

function reducer(state: PresenterState, action: Action): PresenterState {
  switch (action.type) {
    case 'set-tool':
      return { ...state, tool: action.tool };
    case 'set-color':
      return { ...state, penColor: action.color };
    case 'load':
      return { ...state, strokesByIdx: { ...action.strokes } };
    case 'append': {
      const cur = state.strokesByIdx[action.slideIdx] ?? [];
      return {
        ...state,
        strokesByIdx: {
          ...state.strokesByIdx,
          [action.slideIdx]: [...cur, action.stroke],
        },
      };
    }
    case 'remove': {
      const cur = state.strokesByIdx[action.slideIdx] ?? [];
      return {
        ...state,
        strokesByIdx: {
          ...state.strokesByIdx,
          [action.slideIdx]: cur.filter((_, i) => i !== action.strokeIdx),
        },
      };
    }
    case 'remove-cid': {
      const cur = state.strokesByIdx[action.slideIdx] ?? [];
      const next = cur.filter((s) => s.cid !== action.cid);
      if (next.length === cur.length) return state;
      return {
        ...state,
        strokesByIdx: {
          ...state.strokesByIdx,
          [action.slideIdx]: next,
        },
      };
    }
    case 'replace-slide': {
      const cur = state.strokesByIdx[action.slideIdx] ?? [];
      if (sameStrokes(cur, action.strokes)) return state;
      return {
        ...state,
        strokesByIdx: {
          ...state.strokesByIdx,
          [action.slideIdx]: action.strokes,
        },
      };
    }
    case 'undo': {
      const cur = state.strokesByIdx[action.slideIdx] ?? [];
      if (cur.length === 0) return state;
      return {
        ...state,
        strokesByIdx: {
          ...state.strokesByIdx,
          [action.slideIdx]: cur.slice(0, -1),
        },
      };
    }
    case 'clear-slide':
      return {
        ...state,
        strokesByIdx: {
          ...state.strokesByIdx,
          [action.slideIdx]: [],
        },
      };
    case 'set-spotlight-radius': {
      const next = clampSpotlightRadius(action.radius);
      if (next === state.spotlightRadius) return state;
      return { ...state, spotlightRadius: next };
    }
    default:
      return state;
  }
}

function sameStrokes(a: Stroke[], b: Stroke[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface PresenterApi {
  state: PresenterState;
  setTool: (tool: Tool) => void;
  setColor: (color: PenColor) => void;
  loadStrokes: (strokes: Record<number, Stroke[]>) => void;
  appendStroke: (slideIdx: number, stroke: Stroke) => void;
  removeStroke: (slideIdx: number, strokeIdx: number) => void;
  removeStrokeByCid: (slideIdx: number, cid: string) => void;
  replaceSlideStrokes: (slideIdx: number, strokes: Stroke[]) => void;
  undo: (slideIdx: number) => void;
  clearSlide: (slideIdx: number) => void;
  /**
   * Set the spotlight aperture in CSS pixels. Value will be clamped into
   * [MIN, MAX] and snapped to the STEP lattice.
   */
  setSpotlightRadius: (radius: number) => void;
  /**
   * Adjust the spotlight aperture by `delta` pixels. Negative shrinks,
   * positive grows. Convenience wrapper around setSpotlightRadius for
   * wheel / keyboard handlers.
   */
  nudgeSpotlightRadius: (delta: number) => void;
  /** "Drawing" tools draw strokes (pen + highlighter). */
  isDrawingTool: boolean;
  /** Tool that makes the overlay non-pointer-events (mouse/laser/spotlight/blackout/whiteout). */
  needsPointerCapture: boolean;
}

export function usePresenter(): PresenterApi {
  // `useReducer`'s lazy-init form so localStorage is only read once. Tests
  // that mount/unmount the hook would otherwise spam reads.
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState);

  // Persist spotlight radius whenever it changes. Skipping the initial
  // value avoids writing a redundant default on every fresh mount.
  const lastPersisted = useRef<number>(state.spotlightRadius);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (lastPersisted.current === state.spotlightRadius) return;
    lastPersisted.current = state.spotlightRadius;
    try {
      window.localStorage.setItem(
        SPOTLIGHT_STORAGE_KEY,
        String(state.spotlightRadius),
      );
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [state.spotlightRadius]);

  const setTool = useCallback((tool: Tool) => dispatch({ type: 'set-tool', tool }), []);
  const setColor = useCallback(
    (color: PenColor) => dispatch({ type: 'set-color', color }),
    [],
  );
  const loadStrokes = useCallback(
    (strokes: Record<number, Stroke[]>) =>
      dispatch({ type: 'load', strokes }),
    [],
  );
  const appendStroke = useCallback(
    (slideIdx: number, stroke: Stroke) =>
      dispatch({ type: 'append', slideIdx, stroke }),
    [],
  );
  const removeStroke = useCallback(
    (slideIdx: number, strokeIdx: number) =>
      dispatch({ type: 'remove', slideIdx, strokeIdx }),
    [],
  );
  const removeStrokeByCid = useCallback(
    (slideIdx: number, cid: string) =>
      dispatch({ type: 'remove-cid', slideIdx, cid }),
    [],
  );
  const replaceSlideStrokes = useCallback(
    (slideIdx: number, strokes: Stroke[]) =>
      dispatch({ type: 'replace-slide', slideIdx, strokes }),
    [],
  );
  const undo = useCallback(
    (slideIdx: number) => dispatch({ type: 'undo', slideIdx }),
    [],
  );
  const clearSlide = useCallback(
    (slideIdx: number) => dispatch({ type: 'clear-slide', slideIdx }),
    [],
  );
  const setSpotlightRadius = useCallback(
    (radius: number) => dispatch({ type: 'set-spotlight-radius', radius }),
    [],
  );
  // Reading the current radius via the ref keeps `nudgeSpotlightRadius`
  // stable across renders so consumers (wheel listeners, shortcut hook)
  // can capture it once without re-binding on every state tick.
  const spotlightRadiusRef = useRef(state.spotlightRadius);
  spotlightRadiusRef.current = state.spotlightRadius;
  const nudgeSpotlightRadius = useCallback(
    (delta: number) =>
      dispatch({
        type: 'set-spotlight-radius',
        radius: spotlightRadiusRef.current + delta,
      }),
    [],
  );

  const isDrawingTool =
    state.tool === 'pen' ||
    state.tool === 'highlighter' ||
    state.tool === 'eraser';
  const needsPointerCapture =
    state.tool === 'laser' ||
    state.tool === 'spotlight' ||
    isDrawingTool;

  return useMemo(
    () => ({
      state,
      setTool,
      setColor,
      loadStrokes,
      appendStroke,
      removeStroke,
      removeStrokeByCid,
      replaceSlideStrokes,
      undo,
      clearSlide,
      setSpotlightRadius,
      nudgeSpotlightRadius,
      isDrawingTool,
      needsPointerCapture,
    }),
    [
      state,
      setTool,
      setColor,
      loadStrokes,
      appendStroke,
      removeStroke,
      removeStrokeByCid,
      replaceSlideStrokes,
      undo,
      clearSlide,
      setSpotlightRadius,
      nudgeSpotlightRadius,
      isDrawingTool,
      needsPointerCapture,
    ],
  );
}

/**
 * Listens for the presenter shortcuts table from spec §7.1 / §11.2 and
 * dispatches the corresponding API calls. Coordinates with `useKeyboardNav`
 * by *only* handling tool-specific keys (Shift+L/P/H/E/S/M, B/W, 1-5,
 * Ctrl+Z, Shift+Delete). Slide-jump 1-9 and arrows are handled elsewhere.
 *
 * Returns `true` from the `isPenColorActive(key)` helper so the caller can
 * suppress a slide-jump when 1-5 should mean "set color" instead.
 */
export function usePresenterShortcuts(
  api: PresenterApi,
  currentSlideIdx: number,
): { isToolDigitContext: boolean } {
  const { state, setTool, setColor, undo, clearSlide, nudgeSpotlightRadius } =
    api;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      const k = e.key;

      // Ctrl+Z / Cmd+Z — undo last stroke
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z') && !e.shiftKey) {
        e.preventDefault();
        undo(currentSlideIdx);
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Shift+Delete / Shift+Backspace — clear current slide
      if (
        e.shiftKey &&
        (k === 'Delete' || k === 'Backspace')
      ) {
        e.preventDefault();
        clearSlide(currentSlideIdx);
        return;
      }

      // Shift+L/P/H/E/S/M — switch tool
      if (e.shiftKey) {
        const map: Record<string, Tool> = {
          L: 'laser',
          P: 'pen',
          H: 'highlighter',
          E: 'eraser',
          S: 'spotlight',
          M: 'mouse',
        };
        const next = map[k.toUpperCase()];
        if (next) {
          e.preventDefault();
          setTool(next);
          return;
        }
      }

      // [ / ] — shrink / grow the spotlight aperture while it's active.
      // PowerPoint uses the same bracket pair for "shrink/grow font", so
      // muscle memory transfers when the spotlight is the focused tool.
      if (state.tool === 'spotlight' && (k === '[' || k === ']')) {
        e.preventDefault();
        nudgeSpotlightRadius(k === ']' ? SPOTLIGHT_STEP : -SPOTLIGHT_STEP);
        return;
      }

      // B / W — blackout / whiteout (PPT convention, no shift)
      if (k === 'b' || k === 'B') {
        e.preventDefault();
        setTool(state.tool === 'blackout' ? 'mouse' : 'blackout');
        return;
      }
      if (k === 'w' || k === 'W') {
        e.preventDefault();
        setTool(state.tool === 'whiteout' ? 'mouse' : 'whiteout');
        return;
      }

      // Esc — drop back to mouse
      if (k === 'Escape') {
        if (state.tool !== 'mouse') {
          e.preventDefault();
          setTool('mouse');
        }
        return;
      }

      // 1-5 — pen color when drawing tool active
      if (
        (state.tool === 'pen' || state.tool === 'highlighter') &&
        /^[1-5]$/.test(k)
      ) {
        e.preventDefault();
        const idx = Number(k) - 1;
        const c = PEN_COLORS[idx];
        if (c) setColor(c);
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    state.tool,
    currentSlideIdx,
    setTool,
    setColor,
    undo,
    clearSlide,
    nudgeSpotlightRadius,
  ]);

  return {
    /** When true, navigation hooks should NOT use 1-5 for slide jumps. */
    isToolDigitContext:
      state.tool === 'pen' || state.tool === 'highlighter',
  };
}
