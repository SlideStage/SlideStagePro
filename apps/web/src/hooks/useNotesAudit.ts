/**
 * Speaker-notes audit-log fetching hook.
 *
 *   const { entries, hasMore, loading, error, loadMore, refresh } =
 *       useNotesAudit({ deckId, refreshKey });
 *
 * Pagination is cursor-based against `GET /api/decks/:id/notes/audit`.
 *
 * The hook is **lazy-first**: page 1 is only fetched when `enabled` flips
 * to `true` (typically when the History panel is expanded). This keeps the
 * deck viewer cheap for users who never look at history.
 *
 * Pass a monotonically-increasing `refreshKey` to force a re-fetch from
 * page 1 — the parent uses `notesSync.status === 'saved'` transitions as
 * the trigger so newly-saved edits appear without a manual reload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteEditEntry } from '@slidestage/shared';
import { api } from '../api/client.js';

const PAGE_SIZE = 20;

export interface NotesAuditApi {
  entries: NoteEditEntry[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** Manual refresh — discards the current list and re-fetches page 1. */
  refresh: () => void;
  /** Append the next page (no-op when `hasMore` is false). */
  loadMore: () => void;
}

export interface UseNotesAuditOptions {
  deckId: string;
  /** When false, the hook stays idle and never fetches. */
  enabled: boolean;
  /** Bumping this forces a refresh from page 1. */
  refreshKey?: unknown;
}

export function useNotesAudit({
  deckId,
  enabled,
  refreshKey,
}: UseNotesAuditOptions): NotesAuditApi {
  const [entries, setEntries] = useState<NoteEditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped on every refresh to make in-flight responses cancellable
  // (see "stale response" guard inside `fetchPage`).
  const generationRef = useRef(0);

  const fetchPage = useCallback(
    async (cursor?: number): Promise<void> => {
      const gen = ++generationRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.getNotesAudit(deckId, {
          cursor,
          limit: PAGE_SIZE,
        });
        if (gen !== generationRef.current) return;
        setEntries((prev) =>
          cursor === undefined ? res.entries : [...prev, ...res.entries],
        );
        setNextCursor(res.nextCursor);
      } catch (e) {
        if (gen !== generationRef.current) return;
        setError(e instanceof Error ? e.message : 'failed to load audit log');
      } finally {
        if (gen === generationRef.current) setLoading(false);
      }
    },
    [deckId],
  );

  const refresh = useCallback(() => {
    setEntries([]);
    setNextCursor(null);
    void fetchPage(undefined);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    void fetchPage(nextCursor);
  }, [fetchPage, nextCursor]);

  // First fetch when newly enabled, plus on deck/refresh-key change.
  useEffect(() => {
    if (!enabled) return;
    setEntries([]);
    setNextCursor(null);
    void fetchPage(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, deckId, refreshKey]);

  return {
    entries,
    hasMore: nextCursor !== null,
    loading,
    error,
    refresh,
    loadMore,
  };
}
