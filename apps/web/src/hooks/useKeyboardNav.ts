import { useEffect } from 'react';

interface NavApi {
  goto: (idx: number) => void;
  next: () => void;
  prev: () => void;
  first: () => void;
  last: () => void;
  total: number;
  toggleOverview: () => void;
  toggleSpeakerView: () => void;
  toggleFullscreen: () => void;
  /** When true, digit keys 1-9 are owned by the presenter (pen color), skip slide jump. */
  digitsOwnedByTool?: boolean;
}

/**
 * Implements the keyboard table from spec §11.2. Stage A scope: navigation,
 * overview toggle, speaker view toggle, fullscreen. Tool shortcuts (Shift+L,
 * etc.) are intentionally out of scope until Stage B.
 */
export function useKeyboardNav(api: NavApi): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // Don't fight inputs.
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
      // Multi-key combos
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (k) {
        case 'ArrowRight':
        case ' ':
        case 'PageDown':
          e.preventDefault();
          api.next();
          return;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          api.prev();
          return;
        case 'Home':
          e.preventDefault();
          api.first();
          return;
        case 'End':
          e.preventDefault();
          api.last();
          return;
        case 'o':
        case 'O':
          if (!e.shiftKey) {
            e.preventDefault();
            api.toggleOverview();
          }
          return;
        case 's':
        case 'S':
          if (!e.shiftKey) {
            e.preventDefault();
            api.toggleSpeakerView();
          }
          return;
        case 'f':
        case 'F':
          if (!e.shiftKey) {
            e.preventDefault();
            api.toggleFullscreen();
          }
          return;
      }

      // 1..9 jump (suppressed when a drawing tool owns 1-5).
      if (/^[1-9]$/.test(k) && !api.digitsOwnedByTool) {
        const n = Number(k);
        if (n <= api.total) {
          e.preventDefault();
          api.goto(n);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api]);
}
