import type { Manifest } from '@slidestage/shared';
import { X } from 'lucide-react';
import { DeckStage } from './DeckStage.js';
import { storageAssetUrl } from '../utils/storageUrl.js';

interface Props {
  manifest: Manifest;
  deckId: string;
  /**
   * Short-lived `?t=` access token from the deck detail response. Required so
   * the thumbnail iframes (which run sandboxed at opaque origin) can fetch
   * `/storage/...` subresources without the session cookie.
   */
  storageToken: string;
  currentIdx: number;
  onPick: (idx1Based: number) => void;
  onClose: () => void;
}

export function Overview({
  manifest,
  deckId,
  storageToken,
  currentIdx,
  onPick,
  onClose,
}: Props): JSX.Element {
  return (
    <div
      className="overview-backdrop"
      role="dialog"
      aria-label="Slide overview"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="overview"
    >
      <div className="overview-panel">
        <header className="overview-header">
          <h2>{manifest.title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="close overview">
            <X className="btn-icon" aria-hidden size={16} />
            Close (Esc)
          </button>
        </header>
        <div className="overview-grid">
          {manifest.slides.map((s) => {
            const isActive = s.index === currentIdx;
            const slideUrl = storageAssetUrl(deckId, s.file, storageToken);
            return (
              <button
                key={s.id}
                className={`overview-cell${isActive ? ' active' : ''}`}
                onClick={() => onPick(s.index)}
                data-testid={`overview-cell-${s.index}`}
              >
                <div className="overview-thumb">
                  <DeckStage
                    src={slideUrl}
                    width={manifest.dimensions.width}
                    height={manifest.dimensions.height}
                    className="mini"
                    noScripts
                  />
                </div>
                <div className="overview-cell-label">
                  <span className="idx">#{s.index}</span>
                  <span>{s.label || s.id}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
