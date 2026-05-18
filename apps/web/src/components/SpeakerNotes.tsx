import type { Manifest } from '@slidestage/shared';
import { DeckStage } from './DeckStage.js';
import { EditableNotes } from './EditableNotes.js';
import { NotesHistory } from './NotesHistory.js';
import type { NotesSyncStatus } from '../hooks/useNotesSync.js';
import { storageAssetUrl } from '../utils/storageUrl.js';

export interface SpeakerNotesEditor {
  value: string;
  status: NotesSyncStatus;
  errorMessage: string | null;
  onChange: (value: string) => void;
  onRetry?: () => void;
  editing: boolean;
  onEnterEdit: () => void;
  onExitEdit: () => void;
}

interface Props {
  manifest: Manifest;
  deckId: string;
  /**
   * Short-lived `?t=` access token from the deck detail response. Required so
   * the embedded `<DeckStage>` preview iframe (which runs sandboxed, opaque
   * origin) can fetch `/storage/...` subresources without the session cookie.
   */
  storageToken: string;
  currentIdx: number;
  editor: SpeakerNotesEditor;
  onClose: () => void;
}

export function SpeakerNotes({
  manifest,
  deckId,
  storageToken,
  currentIdx,
  editor,
  onClose,
}: Props): JSX.Element {
  const current = manifest.slides[currentIdx - 1];
  const next = manifest.slides[currentIdx];
  const nextSlideUrl = next
    ? storageAssetUrl(deckId, next.file, storageToken)
    : null;

  return (
    <aside
      className="speaker-panel"
      role="complementary"
      aria-label="speaker notes"
      data-testid="speaker-panel"
    >
      <header>
        <h2>Speaker view</h2>
        <button className="btn ghost" onClick={onClose} aria-label="close speaker view">
          Close (S)
        </button>
      </header>
      <div className="speaker-grid">
        <div className="speaker-now">
          <div className="speaker-label muted">
            Current ({currentIdx} / {manifest.totalSlides})
          </div>
          <div className="speaker-current">
            <strong>{current?.label ?? `Slide ${currentIdx}`}</strong>
          </div>
        </div>
        <div className="speaker-next">
          <div className="speaker-label muted">Next</div>
          {next && nextSlideUrl ? (
            <div className="speaker-next-preview">
              <DeckStage
                src={nextSlideUrl}
                width={manifest.dimensions.width}
                height={manifest.dimensions.height}
                className="mini"
                noScripts
              />
              <span className="speaker-next-label">
                <span className="muted">#{next.index}</span> {next.label || next.id}
              </span>
            </div>
          ) : (
            <div className="muted">— end of deck —</div>
          )}
        </div>
      </div>
      <div className="speaker-notes" data-testid="speaker-notes">
        <EditableNotes
          slideIdx={currentIdx}
          value={editor.value}
          status={editor.status}
          errorMessage={editor.errorMessage}
          onChange={editor.onChange}
          onRetry={editor.onRetry}
          variant="panel"
          editing={editor.editing}
          onEnterEdit={editor.onEnterEdit}
          onExitEdit={editor.onExitEdit}
        />
      </div>
      <NotesHistory deckId={deckId} refreshKey={editor.status} variant="panel" />
    </aside>
  );
}
