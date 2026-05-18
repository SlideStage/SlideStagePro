/**
 * Floating presenter toolbar with the nine-tool set + color swatches.
 *
 * Two layout modes:
 *   - "auto-hide" (default, regular deck viewer): bottom-center horizontal
 *     bar that's hidden until the cursor enters the lower 40% of the host,
 *     then auto-fades after 2s of inactivity (spec §7.2).
 *   - "right-dock" (presenter view): right-edge vertical strip. Collapsed
 *     to a discreet "Tools" handle by default; hovering the handle expands
 *     the full toolbar with labels. It collapses after the cursor leaves,
 *     including while drawing, so slide content is not permanently covered.
 */

import { useEffect, useRef, useState } from 'react';
import {
  CircleDot,
  Eraser,
  Highlighter,
  MousePointer2,
  PanelRightOpen,
  PenLine,
  RotateCcw,
  Spotlight,
  Square,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  PEN_COLORS,
  SPOTLIGHT_MAX_RADIUS,
  SPOTLIGHT_MIN_RADIUS,
  SPOTLIGHT_STEP,
  toHighlighterColor,
  type PenColor,
  type Tool,
} from './types.js';
import type { PresenterApi } from './usePresenter.js';

export type ToolbarMode = 'auto-hide' | 'right-dock';

interface Props {
  hostRef: { current: HTMLElement | null };
  presenter: PresenterApi;
  /** Currently active slide (1-based). Used by clear/undo. */
  slideIdx: number;
  /**
   * Layout mode. `auto-hide` matches spec §7.2 and is used by the regular
   * deck viewer. `right-dock` is the presenter-view variant: right-edge
   * vertical strip that collapses to a handle and expands on hover/click.
   */
  mode?: ToolbarMode;
}

const TOOLS: Array<{
  id: Tool;
  label: string;
  icon: LucideIcon;
  shortcut: string;
}> = [
  { id: 'mouse', label: 'Pointer', icon: MousePointer2, shortcut: 'Shift+M / Esc' },
  { id: 'laser', label: 'Laser', icon: CircleDot, shortcut: 'Shift+L' },
  { id: 'pen', label: 'Pen', icon: PenLine, shortcut: 'Shift+P' },
  { id: 'highlighter', label: 'Highlighter', icon: Highlighter, shortcut: 'Shift+H' },
  { id: 'eraser', label: 'Eraser', icon: Eraser, shortcut: 'Shift+E' },
  { id: 'spotlight', label: 'Spotlight', icon: Spotlight, shortcut: 'Shift+S' },
  { id: 'blackout', label: 'Black', icon: Square, shortcut: 'B' },
  { id: 'whiteout', label: 'White', icon: Square, shortcut: 'W' },
];

const REVEAL_RATIO = 0.6;
const HIDE_AFTER_MS = 2000;
const DOCK_COLLAPSE_DELAY_MS = 450;

export function Toolbar({
  hostRef,
  presenter,
  slideIdx,
  mode = 'auto-hide',
}: Props): JSX.Element {
  const isDock = mode === 'right-dock';
  // For auto-hide mode: starts visible (so first-time users see it), then
  // auto-hides on inactivity. For dock mode: starts collapsed so it doesn't
  // block the slide.
  const [visible, setVisible] = useState(!isDock);
  const [expanded, setExpanded] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { state, setTool, setColor, setSpotlightRadius, undo, clearSlide } =
    presenter;
  const isDrawing =
    state.tool === 'pen' || state.tool === 'highlighter' || state.tool === 'eraser';
  const activeDrawingColor = getDisplayedColor(state.tool, state.penColor);
  const isSpotlight = state.tool === 'spotlight';

  // ── Auto-hide mode (regular deck viewer) ─────────────────────────
  useEffect(() => {
    if (isDock) return;
    const node = hostRef.current;
    if (!node) return;

    function bumpVisible(): void {
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    }
    function onMove(ev: PointerEvent): void {
      const rect = node!.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      if (y / rect.height >= REVEAL_RATIO) bumpVisible();
    }
    function onLeave(): void {
      if (!isDrawing) setVisible(false);
    }
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);
    bumpVisible();
    return () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [hostRef, isDrawing, isDock]);

  // Auto-hide: lock visible while a drawing tool is active.
  useEffect(() => {
    if (!isDock && isDrawing) setVisible(true);
  }, [isDrawing, isDock]);

  // ── Dock mode (presenter view) ───────────────────────────────────
  const dockHoveredRef = useRef(false);

  // Auto-collapse handler used by pointerleave and keyboard tool switches.
  function scheduleCollapse(): void {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = setTimeout(() => {
      setExpanded(false);
    }, DOCK_COLLAPSE_DELAY_MS);
  }
  function cancelCollapse(): void {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }

  useEffect(() => {
    if (!isDock) return;
    if (!dockHoveredRef.current) {
      scheduleCollapse();
    }
  }, [isDock, state.tool]);

  useEffect(() => {
    return () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, []);

  // ── Render ───────────────────────────────────────────────────────
  if (isDock) {
    const dockExpanded = expanded;
    const activeTool = TOOLS.find((t) => t.id === state.tool);
    const ActiveToolIcon = activeTool?.icon;
    const showActiveToolPill = !dockExpanded && state.tool !== 'mouse';
    return (
      <div
        className={`presenter-toolbar dock-right ${
          dockExpanded ? 'expanded' : 'collapsed'
        }${isDrawing ? ' has-active-drawing-tool' : ''}`}
        data-testid="presenter-toolbar"
        data-mode="right-dock"
        data-expanded={dockExpanded ? 'true' : 'false'}
        role="toolbar"
        aria-label="Presenter tools"
        onPointerEnter={() => {
          dockHoveredRef.current = true;
          cancelCollapse();
          setExpanded(true);
        }}
        onPointerLeave={() => {
          dockHoveredRef.current = false;
          scheduleCollapse();
        }}
      >
        <button
          type="button"
          className="toolbar-handle"
          data-testid="toolbar-handle"
          aria-label="Show presenter tools"
          aria-expanded={dockExpanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <PanelRightOpen className="toolbar-handle-icon" aria-hidden size={18} />
          <span className="toolbar-handle-label">Tools</span>
        </button>
        {showActiveToolPill && activeTool && ActiveToolIcon && (
          <div
            className="active-tool-pill"
            data-testid="active-tool-pill"
            aria-live="polite"
          >
            <ActiveToolIcon
              className={`active-tool-pill-icon tool-icon-${activeTool.id}`}
              aria-hidden
              size={16}
            />
            <span>{activeTool.label}</span>
            {(state.tool === 'pen' || state.tool === 'highlighter') && (
              <span
                className="active-tool-pill-color"
                aria-label={`active color ${activeDrawingColor}`}
                style={{ background: activeDrawingColor }}
              />
            )}
          </div>
        )}
        <div className="presenter-toolbar-inner dock-inner">
          {TOOLS.map((t) => {
            const isActive = state.tool === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                className={`tool-btn${isActive ? ' active' : ''}`}
                onClick={() =>
                  setTool(isActive && t.id !== 'mouse' ? 'mouse' : t.id)
                }
                title={`${t.label} (${t.shortcut})`}
                aria-pressed={isActive}
                aria-label={`${t.label} — ${t.shortcut}`}
                data-testid={`tool-${t.id}`}
              >
                <Icon className={`tool-icon tool-icon-${t.id}`} aria-hidden size={18} />
                <span className="tool-label">{t.label}</span>
              </button>
            );
          })}

          <div className="toolbar-sep" />

          <div className="color-swatch-row">
            {PEN_COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                className={`color-swatch${
                  state.penColor === c ? ' active' : ''
                }${
                  !(state.tool === 'pen' || state.tool === 'highlighter')
                    ? ' dim'
                    : ''
                }`}
                onClick={() => setColor(c)}
                title={`${c} (${i + 1})`}
                aria-label={`drawing color ${c}`}
                data-testid={`color-${i + 1}`}
                style={{ background: getDisplayedColor(state.tool, c) }}
              />
            ))}
          </div>

          {isSpotlight && (
            <>
              <div className="toolbar-sep" />
              <SpotlightSizeControl
                value={state.spotlightRadius}
                onChange={setSpotlightRadius}
                layout="dock"
              />
            </>
          )}

          <div className="toolbar-sep" />

          <button
            type="button"
            className="tool-btn"
            onClick={() => undo(slideIdx)}
            title="Undo last stroke (Ctrl+Z)"
            aria-label="Undo (Ctrl+Z)"
            data-testid="tool-undo"
          >
            <RotateCcw className="tool-icon" aria-hidden size={18} />
            <span className="tool-label">Undo</span>
          </button>
          <button
            type="button"
            className="tool-btn danger"
            onClick={() => clearSlide(slideIdx)}
            title="Clear annotations on this slide (Shift+Delete)"
            aria-label="Clear slide (Shift+Delete)"
            data-testid="tool-clear"
          >
            <Trash2 className="tool-icon" aria-hidden size={18} />
            <span className="tool-label">Clear</span>
          </button>
        </div>
      </div>
    );
  }

  // Regular auto-hide (bottom) mode.
  return (
    <div
      className={`presenter-toolbar${visible ? '' : ' hidden'}`}
      data-testid="presenter-toolbar"
      data-mode="auto-hide"
      role="toolbar"
      aria-label="Presenter tools"
    >
      <div className="presenter-toolbar-inner">
        {TOOLS.map((t) => {
          const isActive = state.tool === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              className={`tool-btn${isActive ? ' active' : ''}`}
              onClick={() => setTool(isActive && t.id !== 'mouse' ? 'mouse' : t.id)}
              title={`${t.label} (${t.shortcut})`}
              aria-pressed={isActive}
              data-testid={`tool-${t.id}`}
            >
              <Icon className={`tool-icon tool-icon-${t.id}`} aria-hidden size={18} />
            </button>
          );
        })}

        <div className="toolbar-sep" />

        {(state.tool === 'pen' || state.tool === 'highlighter') &&
          PEN_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              className={`color-swatch${state.penColor === c ? ' active' : ''}`}
              onClick={() => setColor(c)}
              title={`${c} (${i + 1})`}
              aria-label={`drawing color ${c}`}
              data-testid={`color-${i + 1}`}
              style={{ background: getDisplayedColor(state.tool, c) }}
            />
          ))}

        {isSpotlight && (
          <SpotlightSizeControl
            value={state.spotlightRadius}
            onChange={setSpotlightRadius}
            layout="bar"
          />
        )}

        <div className="toolbar-sep" />

        <button
          type="button"
          className="tool-btn"
          onClick={() => undo(slideIdx)}
          title="Undo last stroke (Ctrl+Z)"
          data-testid="tool-undo"
        >
          <RotateCcw className="tool-icon" aria-hidden size={18} />
        </button>
        <button
          type="button"
          className="tool-btn danger"
          onClick={() => clearSlide(slideIdx)}
          title="Clear annotations on this slide (Shift+Delete)"
          data-testid="tool-clear"
        >
          <Trash2 className="tool-icon" aria-hidden size={18} />
        </button>
      </div>
    </div>
  );
}

function getDisplayedColor(tool: Tool, color: PenColor): string {
  return tool === 'highlighter' ? toHighlighterColor(color) : color;
}

/**
 * Slider that adjusts the spotlight aperture. Only rendered when the
 * spotlight tool is active. Two layouts:
 *   - `dock` — fills the dock column with a labelled stack (label / slider
 *     / numeric badge).
 *   - `bar`  — compact horizontal control for the auto-hide bottom bar.
 *
 * The native <input type="range"> keeps keyboard interaction (←/→) free
 * for free; we just expose data-testid hooks for e2e.
 */
interface SpotlightSizeControlProps {
  value: number;
  onChange: (next: number) => void;
  layout: 'dock' | 'bar';
}
function SpotlightSizeControl({
  value,
  onChange,
  layout,
}: SpotlightSizeControlProps): JSX.Element {
  return (
    <div
      className={`spotlight-size-control spotlight-size-control-${layout}`}
      data-testid="spotlight-size-control"
    >
      {layout === 'dock' && (
        <div className="spotlight-size-label" aria-hidden>
          Size
        </div>
      )}
      <input
        type="range"
        min={SPOTLIGHT_MIN_RADIUS}
        max={SPOTLIGHT_MAX_RADIUS}
        step={SPOTLIGHT_STEP}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="spotlight-size-slider"
        aria-label={`Spotlight size, currently ${value} pixels`}
        data-testid="spotlight-size-slider"
      />
      <div
        className="spotlight-size-value"
        data-testid="spotlight-size-value"
        aria-hidden
      >
        {value}
        <span className="spotlight-size-unit">px</span>
      </div>
    </div>
  );
}
