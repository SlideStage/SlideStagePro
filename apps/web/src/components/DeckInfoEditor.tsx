/**
 * Deck info editor — a modal-style dialog that lets the deck owner edit
 * top-level metadata (title / subtitle / author / description) and each
 * slide's display label. All edits debounce-save via `useDeckInfoSync`
 * (800 ms idle) so the dialog can be closed without an explicit "Save"
 * step: the same hook will also flush on unmount.
 *
 * Layout:
 *   ┌─ DECK INFO ────────────────── × ┐
 *   │  Title*  [ ………………………… ]        │
 *   │  Subtitle [ ………………………… ]       │
 *   │  Author   [ ………………………… ]       │
 *   │  Description (textarea)         │
 *   │                                 │
 *   ├─ SLIDE LABELS ──────────────────┤
 *   │  #1 Welcome      [ ……………… ]    │
 *   │  #2 Demo         [ ……………… ]    │
 *   │  …                              │
 *   └─────────────────────────────────┘
 *
 * The save-status pill (Saving… / Saved ✓ / Failed ↻) is reused verbatim
 * from the notes editor for consistency.
 */

import { useCallback, useEffect, useRef } from 'react';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';
import type { Manifest } from '@slidestage/shared';
import { useDeckInfoSync, type DeckInfoSyncStatus } from '../hooks/useDeckInfoSync.js';

interface Props {
  deckId: string;
  manifest: Manifest;
  /** Called whenever a successful PATCH lands, so the parent can refresh its deck state. */
  onPersisted?: (
    deck: {
      title: string;
      subtitle: string | null;
      author: string | null;
      description: string | null;
    },
    labels: Record<number, string>,
    manifestUpdatedAt: string,
  ) => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<DeckInfoSyncStatus, string> = {
  idle: '',
  dirty: 'Editing…',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Failed',
};

export function DeckInfoEditor({
  deckId,
  manifest,
  onPersisted,
  onClose,
}: Props): JSX.Element {
  const sync = useDeckInfoSync({ deckId, manifest, onPersisted });
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the title field on open so keyboard users can immediately start typing.
  useEffect(() => {
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, []);

  // Esc closes the dialog (after flushing — flush happens automatically on
  // unmount via the sync hook).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSaveAndClose = useCallback(async () => {
    await sync.flush();
    onClose();
  }, [sync, onClose]);

  return (
    <div
      className="deck-info-backdrop"
      data-testid="deck-info-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deck-info-heading"
      onClick={(e) => {
        // Click outside the panel closes (with flush).
        if (e.target === e.currentTarget) void handleSaveAndClose();
      }}
    >
      <div className="deck-info-panel">
        <header className="deck-info-header">
          <h2 id="deck-info-heading">Deck info</h2>
          <StatusPill
            status={sync.status}
            errorMessage={sync.errorMessage}
            onRetry={() => void sync.flush()}
          />
          <button
            type="button"
            className="deck-info-close"
            onClick={() => void handleSaveAndClose()}
            aria-label="Close deck info editor"
            data-testid="deck-info-close"
          >
            <X className="btn-icon" aria-hidden size={18} />
          </button>
        </header>

        <section className="deck-info-section">
          <h3>Basic info</h3>
          <label className="deck-info-field">
            <span>
              Title<span className="deck-info-required" aria-hidden> *</span>
            </span>
            <input
              ref={titleInputRef}
              type="text"
              value={sync.deck.title}
              onChange={(e) => sync.setDeckField('title', e.currentTarget.value)}
              data-testid="deck-info-title"
              maxLength={200}
              required
            />
          </label>
          <label className="deck-info-field">
            <span>Subtitle</span>
            <input
              type="text"
              value={sync.deck.subtitle ?? ''}
              onChange={(e) => {
                const next = e.currentTarget.value;
                sync.setDeckField('subtitle', next === '' ? null : next);
              }}
              data-testid="deck-info-subtitle"
              maxLength={200}
            />
          </label>
          <label className="deck-info-field">
            <span>Author</span>
            <input
              type="text"
              value={sync.deck.author ?? ''}
              onChange={(e) => {
                const next = e.currentTarget.value;
                sync.setDeckField('author', next === '' ? null : next);
              }}
              data-testid="deck-info-author"
              maxLength={120}
            />
          </label>
          <label className="deck-info-field">
            <span>Description</span>
            <textarea
              rows={3}
              value={sync.deck.description ?? ''}
              onChange={(e) => {
                const next = e.currentTarget.value;
                sync.setDeckField('description', next === '' ? null : next);
              }}
              data-testid="deck-info-description"
              maxLength={2000}
            />
          </label>
        </section>

        <section className="deck-info-section">
          <h3>Slide labels</h3>
          <p className="deck-info-hint muted">
            Labels show up in the Overview and the up-next preview. Leave a row
            empty to fall back to the slide id.
          </p>
          <ul className="deck-info-slides">
            {manifest.slides.map((s) => (
              <li
                key={s.index}
                className="deck-info-slide-row"
                data-slide-idx={s.index}
              >
                <span className="deck-info-slide-idx">#{s.index}</span>
                <input
                  type="text"
                  value={sync.labels[s.index] ?? ''}
                  onChange={(e) =>
                    sync.setSlideLabel(
                      s.index,
                      e.currentTarget.value === ''
                        ? null
                        : e.currentTarget.value,
                    )
                  }
                  placeholder={s.id}
                  data-testid={`deck-info-label-${s.index}`}
                  maxLength={160}
                />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

interface StatusPillProps {
  status: DeckInfoSyncStatus;
  errorMessage: string | null;
  onRetry: () => void;
}
function StatusPill({
  status,
  errorMessage,
  onRetry,
}: StatusPillProps): JSX.Element | null {
  if (status === 'idle') return null;
  return (
    <span
      className={`deck-info-status status-${status}`}
      data-testid="deck-info-status"
      data-status={status}
      aria-live="polite"
    >
      {status === 'saving' && (
        <Loader2 className="deck-info-status-icon spin" aria-hidden size={14} />
      )}
      {status === 'saved' && (
        <Check className="deck-info-status-icon" aria-hidden size={14} />
      )}
      {status === 'error' && (
        <button
          type="button"
          className="deck-info-status-retry"
          onClick={onRetry}
          title={errorMessage ?? 'retry save'}
          data-testid="deck-info-status-retry"
        >
          <RotateCcw className="deck-info-status-icon" aria-hidden size={14} />
        </button>
      )}
      <span>{status === 'error' ? errorMessage ?? 'Failed' : STATUS_LABEL[status]}</span>
    </span>
  );
}
