/**
 * Speaker-notes editor — used in two layouts:
 *
 *   • `panel`  — stacked inside the SpeakerNotes side panel of DeckViewerPage
 *                (full-height read-only `<pre>` until Edit mode toggles a
 *                full-height textarea)
 *   • `strip`  — flat strip at the bottom of PresenterViewPage
 *                (capped textarea height once Edit mode is on)
 *
 * The component is *controlled*: it forwards every keystroke to the parent's
 * `onChange` (which writes into the `useNotesSync` pending map) and renders
 * whatever value the parent passes back. That makes it cheap to embed twice on
 * the same page (e.g. potential split-screen layouts) without state drift.
 *
 * Edit-mode rationale:
 *   When a presenter is mid-talk and accidentally clicks the notes area, the
 *   rendered textarea steals focus and arrow keys / Space stop advancing slides
 *   (see `useKeyboardNav`'s "don't fight inputs" guard). To prevent that the
 *   editor starts **locked** — nav shortcuts pass through, and a deliberate
 *   Edit press swaps to a real textarea. `Esc` (or "Done") leaves Edit
 *   mode and triggers an immediate flush via the parent's `onExitEdit`.
 *
 * Status pill semantics:
 *   idle: empty (component renders the label only)
 *   dirty: "Editing..." muted
 *   saving: "Saving..." muted
 *   saved: "Saved" success
 *   error: "Failed <msg>" + clickable retry that calls `onRetry()`
 */

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { Check, LockKeyhole, Pencil, RotateCcw } from 'lucide-react';
import type { NotesSyncStatus } from '../hooks/useNotesSync.js';

export interface EditableNotesProps {
  slideIdx: number;
  value: string;
  status: NotesSyncStatus;
  errorMessage?: string | null;
  onChange: (value: string) => void;
  onRetry?: () => void;
  variant?: 'panel' | 'strip';
  /** Whether the editor is in Edit mode (textarea active). */
  editing: boolean;
  /** Called when the user enters Edit mode. */
  onEnterEdit: () => void;
  /** Called when the user leaves Edit mode (Done button or Esc). */
  onExitEdit: () => void;
  /** Optional read-only override — used by audience window mirror eventually. */
  readOnly?: boolean;
}

export function EditableNotes({
  slideIdx,
  value,
  status,
  errorMessage,
  onChange,
  onRetry,
  variant = 'strip',
  editing,
  onEnterEdit,
  onExitEdit,
  readOnly = false,
}: EditableNotesProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleInput = useCallback(
    (e: FormEvent<HTMLTextAreaElement>) => {
      onChange((e.target as HTMLTextAreaElement).value);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onExitEdit();
      }
    },
    [onExitEdit],
  );

  // Auto-focus the textarea when entering Edit mode so users can start typing
  // without an extra click; auto-blur when leaving so nav shortcuts work.
  useEffect(() => {
    if (!textareaRef.current) return;
    if (editing) {
      textareaRef.current.focus();
      // Move caret to the end of any existing text.
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    } else {
      textareaRef.current.blur();
    }
  }, [editing]);

  return (
    <div
      className={`editable-notes editable-notes-${variant}`}
      data-status={status}
      data-editing={editing ? 'true' : 'false'}
      data-testid="editable-notes"
    >
      <div className="editable-notes-head">
        <span className="muted small editable-notes-head-left">
          SPEAKER NOTES · slide {slideIdx}
          {!editing && !readOnly ? (
            <span
              className="editable-notes-lock-hint"
              data-testid="notes-lock-hint"
              aria-label="editor is locked, click Edit to type"
            >
              <LockKeyhole className="inline-icon" aria-hidden size={14} />
              Read only · click Edit
            </span>
          ) : null}
        </span>
        <span className="editable-notes-head-right">
          <StatusPill
            status={status}
            errorMessage={errorMessage ?? null}
            onRetry={onRetry}
          />
          {readOnly ? null : editing ? (
            <button
              type="button"
              className="btn ghost small"
              onClick={onExitEdit}
              data-testid="notes-edit-toggle"
              data-state="editing"
              title="Exit Edit mode (Esc)"
            >
              <Check className="btn-icon" aria-hidden size={14} />
              Done
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost small"
              onClick={onEnterEdit}
              data-testid="notes-edit-toggle"
              data-state="locked"
              title="Edit speaker notes"
            >
              <Pencil className="btn-icon" aria-hidden size={14} />
              Edit
            </button>
          )}
        </span>
      </div>
      {editing && !readOnly ? (
        <textarea
          ref={textareaRef}
          className="editable-notes-textarea"
          data-testid="editable-notes-textarea"
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type your speaker notes here. Saved automatically."
          spellCheck={false}
          rows={variant === 'strip' ? 3 : 8}
        />
      ) : (
        <pre
          className="editable-notes-readonly"
          data-testid="editable-notes-readonly"
        >
          {value.length > 0 ? value : (
            <span className="muted">
              No speaker notes for this slide.
              {readOnly ? '' : ' Press Edit to add some.'}
            </span>
          )}
        </pre>
      )}
    </div>
  );
}

interface StatusPillProps {
  status: NotesSyncStatus;
  errorMessage: string | null;
  onRetry?: () => void;
}

function StatusPill({
  status,
  errorMessage,
  onRetry,
}: StatusPillProps): JSX.Element | null {
  if (status === 'idle') return null;
  if (status === 'dirty') {
    return (
      <span
        className="editable-notes-pill muted"
        data-testid="notes-status"
        data-state="dirty"
      >
        Editing…
      </span>
    );
  }
  if (status === 'saving') {
    return (
      <span
        className="editable-notes-pill muted"
        data-testid="notes-status"
        data-state="saving"
      >
        Saving…
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span
        className="editable-notes-pill success"
        data-testid="notes-status"
        data-state="saved"
      >
        <Check className="inline-icon" aria-hidden size={14} />
        Saved
      </span>
    );
  }
  return (
    <span
      className="editable-notes-pill error"
      data-testid="notes-status"
      data-state="error"
      role="alert"
    >
      Failed{errorMessage ? `: ${errorMessage}` : ''}
      {onRetry ? (
        <button
          type="button"
          className="link"
          onClick={onRetry}
          data-testid="notes-retry"
        >
          <RotateCcw className="inline-icon" aria-hidden size={12} />
          retry
        </button>
      ) : null}
    </span>
  );
}
