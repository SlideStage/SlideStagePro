/**
 * Foldable "Edit history" panel for speaker notes.
 *
 *   <NotesHistory deckId={deck.id} refreshKey={notesSync.status} />
 *
 * Wraps `useNotesAudit`. The panel uses native `<details>` for the
 * collapsed/expanded toggle so keyboard a11y is free.
 *
 * Visual style is intentionally compact: most decks accumulate dozens of
 * edits over a single rehearsal; we want the list to read like a git log,
 * not a screen-filling table. Each row shows:
 *
 *   slide N  ·  short preview of `newNotes`  ·  by <userId> · <relative ts>
 *
 * `previousNotes` is exposed via a hover title for forensic spot-checks
 * without bloating the row.
 */

import { useEffect, useMemo, useState } from 'react';
import type { NoteEditEntry } from '@slidestage/shared';
import { History } from 'lucide-react';
import { useNotesAudit } from '../hooks/useNotesAudit.js';

interface Props {
  deckId: string;
  /** Bump this to force the hook to refetch (we use sync status changes). */
  refreshKey?: unknown;
  /** Layout hint: `panel` for the speaker side panel; `strip` is more compact. */
  variant?: 'panel' | 'strip';
}

export function NotesHistory({
  deckId,
  refreshKey,
  variant = 'panel',
}: Props): JSX.Element {
  // `<details>`'s `open` is initially controlled — we mirror it as state so
  // the hook can be `enabled` only when the user actually opens the panel.
  const [open, setOpen] = useState(false);
  const audit = useNotesAudit({
    deckId,
    enabled: open,
    refreshKey,
  });

  return (
    <details
      className={`notes-history notes-history-${variant}`}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      data-testid="notes-history"
    >
      <summary className="notes-history-summary">
        <History className="inline-icon" aria-hidden size={14} />
        <span>History</span>
        {audit.entries.length > 0 ? (
          <span className="muted small">
            ({audit.entries.length}
            {audit.hasMore ? '+' : ''})
          </span>
        ) : null}
      </summary>
      <NotesHistoryBody audit={audit} open={open} />
    </details>
  );
}

interface BodyProps {
  audit: ReturnType<typeof useNotesAudit>;
  open: boolean;
}

function NotesHistoryBody({ audit, open }: BodyProps): JSX.Element {
  if (!open) return <></>;
  if (audit.loading && audit.entries.length === 0) {
    return <div className="muted small">Loading…</div>;
  }
  if (audit.error) {
    return (
      <div className="alert error">
        Failed to load history: {audit.error}
        <button
          type="button"
          className="link"
          onClick={audit.refresh}
          style={{ marginLeft: 8 }}
        >
          retry
        </button>
      </div>
    );
  }
  if (audit.entries.length === 0) {
    return (
      <div className="muted small">No edits yet — start typing in Edit mode.</div>
    );
  }
  return (
    <ul className="notes-history-list" data-testid="notes-history-list">
      {audit.entries.map((entry) => (
        <NotesHistoryItem key={entry.id} entry={entry} />
      ))}
      {audit.hasMore ? (
        <li className="notes-history-more">
          <button
            type="button"
            className="btn ghost small"
            onClick={audit.loadMore}
            disabled={audit.loading}
            data-testid="notes-history-load-more"
          >
            {audit.loading ? 'Loading…' : 'Load more'}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function NotesHistoryItem({ entry }: { entry: NoteEditEntry }): JSX.Element {
  const preview = useMemo(
    () => buildPreview(entry.previousNotes, entry.newNotes),
    [entry.previousNotes, entry.newNotes],
  );
  const tooltip = useMemo(
    () =>
      `Before:\n${entry.previousNotes ?? '(empty)'}\n\nAfter:\n${entry.newNotes ?? '(empty)'}`,
    [entry.previousNotes, entry.newNotes],
  );
  const ts = useRelativeTimestamp(entry.editedAt);

  return (
    <li className="notes-history-row" title={tooltip}>
      <span className="notes-history-slide">slide {entry.slideIdx}</span>
      <span className="notes-history-preview">{preview}</span>
      <span className="muted small">
        {entry.userId} · {ts}
      </span>
    </li>
  );
}

function buildPreview(prev: string | null, next: string | null): string {
  if (next === null || next === '') {
    return prev !== null && prev !== ''
      ? `cleared note (was: ${truncate(prev, 40)})`
      : 'cleared note';
  }
  return truncate(next, 80);
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Minimal "x ago" formatter — close enough for a side-panel timeline; we
 * deliberately avoid pulling in a dayjs/intl-relative-time dependency just
 * for this. Resolution is good to the second for fresh edits and to the
 * minute/hour after that.
 */
function useRelativeTimestamp(iso: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
