/**
 * Speaker-notes editor sync hook.
 *
 * Mirrors the strokes-sync model in `apps/web/src/presenter/useStrokeSync.ts`:
 *
 *   • local edits stage into a `pending` map (keyed by 1-based slide index)
 *   • after 800 ms of idle typing they PATCH to the backend
 *   • on slide change → flush whatever's pending immediately
 *   • on unmount → flush again so a fast `Esc` / route change doesn't lose work
 *
 * The component receiving this api is responsible for showing the status
 * pill (Saving… / Saved ✓ / Failed ↻).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest } from '@slidestage/shared';
import { api } from '../api/client.js';

const FLUSH_DELAY_MS = 800;
const SAVED_DECAY_MS = 1800;

export type NotesSyncStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface NotesSyncOptions {
  deckId: string;
  manifest: Manifest;
  /** 1-based active slide. Used to flush pending edits on slide change. */
  activeSlideIdx: number;
  /** Called after a successful PATCH with the new full notes map. */
  onPersisted?: (
    newNotesByIdx: Record<number, string | null>,
    manifestUpdatedAt: string,
  ) => void;
}

export interface NotesSyncApi {
  /** Notes map that already reflects unsaved pending edits. Keys 1-based. */
  notes: Record<number, string | null>;
  status: NotesSyncStatus;
  errorMessage: string | null;
  /** Local edit. Empty string clears the note (server normalizes to null). */
  setNote: (slideIdx: number, value: string) => void;
  /** Force a flush right now. Resolves once persistence is done. */
  flush: () => Promise<void>;
}

function notesFromManifest(manifest: Manifest): Record<number, string | null> {
  const out: Record<number, string | null> = {};
  for (const s of manifest.slides) out[s.index] = s.notes ?? null;
  return out;
}

export function useNotesSync(opts: NotesSyncOptions): NotesSyncApi {
  const { deckId, manifest, activeSlideIdx, onPersisted } = opts;

  // Authoritative server-side notes (last known good).
  const [serverNotes, setServerNotes] = useState<Record<number, string | null>>(
    () => notesFromManifest(manifest),
  );

  // Pending local-only edits awaiting flush. `''` means "clear".
  const [pending, setPending] = useState<Record<number, string>>({});
  const pendingRef = useRef<Record<number, string>>({});
  pendingRef.current = pending;

  const [status, setStatus] = useState<NotesSyncStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const onPersistedRef = useRef(onPersisted);
  onPersistedRef.current = onPersisted;

  // Pull `manifest.slides[].notes` into the local mirror whenever the
  // manifest reference changes (parent passed a new manifest after fetching
  // the deck or after a successful PATCH). This is *append-only* relative to
  // pending edits — the user's in-flight typing is preserved.
  useEffect(() => {
    setServerNotes(notesFromManifest(manifest));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  // When the active deck changes (different deckId), drop any pending edits
  // — they belonged to the old deck — and reset the status pill.
  useEffect(() => {
    setPending({});
    pendingRef.current = {};
    setStatus('idle');
    setErrorMessage(null);
  }, [deckId]);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const clearSavedDecay = useCallback(() => {
    if (savedDecayRef.current) {
      clearTimeout(savedDecayRef.current);
      savedDecayRef.current = null;
    }
  }, []);

  const flushNow = useCallback(async (): Promise<void> => {
    clearFlushTimer();
    if (inflightRef.current) {
      // Coalesce concurrent flushes — wait for the current request, then if
      // there are still pending edits the post-flight effect schedules
      // another flush automatically.
      await inflightRef.current;
      return;
    }
    const snapshot = pendingRef.current;
    if (Object.keys(snapshot).length === 0) {
      return;
    }
    setPending({});
    pendingRef.current = {};
    setStatus('saving');
    setErrorMessage(null);

    const work = (async (): Promise<void> => {
      try {
        const resp = await api.updateNotes(deckId, snapshot);
        // Merge snapshot into serverNotes.
        setServerNotes((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(snapshot)) {
            const idx = Number(k);
            next[idx] = v === '' ? null : v;
          }
          onPersistedRef.current?.(next, resp.manifestUpdatedAt);
          return next;
        });
        setStatus('saved');
        clearSavedDecay();
        savedDecayRef.current = setTimeout(() => {
          setStatus((s) => (s === 'saved' ? 'idle' : s));
          savedDecayRef.current = null;
        }, SAVED_DECAY_MS);
      } catch (err) {
        // Re-merge unsent edits with whatever the user typed during the
        // request so we don't drop their work.
        setPending((curr) => {
          const next = { ...snapshot, ...curr };
          pendingRef.current = next;
          return next;
        });
        setStatus('error');
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save notes',
        );
      }
    })();
    inflightRef.current = work;
    try {
      await work;
    } finally {
      inflightRef.current = null;
    }
  }, [deckId, clearFlushTimer, clearSavedDecay]);

  const setNote = useCallback(
    (slideIdx: number, value: string): void => {
      setPending((prev) => {
        const next = { ...prev, [slideIdx]: value };
        pendingRef.current = next;
        return next;
      });
      setStatus('dirty');
      setErrorMessage(null);
      clearFlushTimer();
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        void flushNow();
      }, FLUSH_DELAY_MS);
    },
    [clearFlushTimer, flushNow],
  );

  // Flush pending edits when the active slide changes — protects against
  // navigation losing in-flight typing on the previous slide.
  useEffect(() => {
    return () => {
      if (Object.keys(pendingRef.current).length > 0) {
        void flushNow();
      }
    };
  }, [activeSlideIdx, flushNow]);

  // Final flush on unmount.
  useEffect(() => {
    return () => {
      clearFlushTimer();
      clearSavedDecay();
      if (Object.keys(pendingRef.current).length > 0) {
        void flushNow();
      }
    };
  }, [clearFlushTimer, clearSavedDecay, flushNow]);

  // If a flush left more pending edits behind (e.g. user kept typing during
  // the request), kick a new debounce.
  useEffect(() => {
    if (status === 'saving') return;
    if (Object.keys(pending).length === 0) return;
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      void flushNow();
    }, FLUSH_DELAY_MS);
  }, [pending, status, flushNow]);

  // Effective notes shown to the editor: server view + pending overrides.
  const notes = useMemo(() => {
    const out: Record<number, string | null> = { ...serverNotes };
    for (const [k, v] of Object.entries(pending)) {
      out[Number(k)] = v === '' ? null : v;
    }
    return out;
  }, [serverNotes, pending]);

  return { notes, status, errorMessage, setNote, flush: flushNow };
}
