import { useCallback, useEffect, useRef } from 'react';
import type { Stroke } from '@slidestage/shared';
import { api } from '../api/client.js';

const FLUSH_DEBOUNCE_MS = 800;

interface SyncOptions {
  deckId: string;
  slideIdx: number;
  /** Current authoritative array of strokes for this slide. */
  strokes: Stroke[];
}

/**
 * Pushes the current strokes array up to `/api/decks/:deckId/annotations/:slideIdx`
 * with debouncing. We use POST (replace) rather than PATCH for simplicity — the
 * spec also lists POST as the canonical "replace this slide's strokes" call.
 *
 * The most recent flush wins per slide; we keep a per-slide pending timer so
 * switching slides forces an immediate flush on the slide we're leaving.
 */
export function useStrokeSync({ deckId, slideIdx, strokes }: SyncOptions): void {
  // Seed each slide with the empty-state serialization so the in-memory placeholder
  // shown before the initial GET resolves is treated as "already in sync"
  // — otherwise the unmount cleanup (and React 18 StrictMode's dev-only
  // mount/unmount/mount simulation) would POST `[]` to the server and
  // clobber the saved annotations of whichever slide is initially active.
  const emptySerialized = JSON.stringify([]);
  const lastSerializedBySlideRef = useRef<Map<number, string>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<unknown> | null>(null);

  const getLastSerialized = useCallback(
    (idx: number): string => lastSerializedBySlideRef.current.get(idx) ?? emptySerialized,
    [emptySerialized],
  );

  const flush = useCallback(
    async (idx: number, payload: Stroke[]) => {
      const serialized = JSON.stringify(payload);
      lastSerializedBySlideRef.current.set(idx, serialized);
      try {
        const p = api.putSlideAnnotations(deckId, idx, payload);
        inFlightRef.current = p;
        await p;
      } catch (e) {
        // Network failed — log and try again on next debounce tick.
        // eslint-disable-next-line no-console
        console.warn('Stroke sync failed:', e);
        lastSerializedBySlideRef.current.delete(idx);
      } finally {
        inFlightRef.current = null;
      }
    },
    [deckId],
  );

  // Debounced sync: whenever strokes for this slide changes, schedule a flush.
  useEffect(() => {
    const serialized = JSON.stringify(strokes);
    if (getLastSerialized(slideIdx) === serialized) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush(slideIdx, strokes);
    }, FLUSH_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [strokes, slideIdx, flush, getLastSerialized]);

  // Flush immediately when the slide changes — the strokes array we still
  // hold in `strokes` belongs to the *new* slide already, so we use a ref
  // to capture the previous slide's data on the way out.
  const prevSlideRef = useRef<{ idx: number; strokes: Stroke[] } | null>(null);
  useEffect(() => {
    if (prevSlideRef.current && prevSlideRef.current.idx !== slideIdx) {
      // Different slide — flush prev right now if it actually diverged from
      // what we last persisted (skip no-op writes that would otherwise
      // clobber another tab's work).
      const prev = prevSlideRef.current;
      const prevSerialized = JSON.stringify(prev.strokes);
      if (prevSerialized !== getLastSerialized(prev.idx)) {
        void flush(prev.idx, prev.strokes);
      }
    }
    prevSlideRef.current = { idx: slideIdx, strokes };
  }, [slideIdx, strokes, flush, getLastSerialized]);

  // On unmount, force-flush any pending changes — but only when the
  // in-memory state actually diverged from what we last saved. Without this
  // guard the dev-mode StrictMode unmount/remount would push the empty
  // placeholder over the network and erase slide-1's annotations every
  // time the viewer is opened.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (prevSlideRef.current) {
        const { idx, strokes: s } = prevSlideRef.current;
        const serialized = JSON.stringify(s);
        if (serialized !== getLastSerialized(idx)) {
          void flush(idx, s);
        }
      }
    };
  }, [flush, getLastSerialized]);
}
