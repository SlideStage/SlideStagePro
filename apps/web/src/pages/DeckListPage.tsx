import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Plus, Trash2, WifiOff } from 'lucide-react';
import { api, type DeckListItem } from '../api/client.js';
import { storageAssetUrl } from '../utils/storageUrl.js';

export function DeckListPage(): JSX.Element {
  const [decks, setDecks] = useState<DeckListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const { decks } = await api.listDecks();
      setDecks(decks);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleDelete(id: string): Promise<void> {
    if (!confirm(`Delete deck "${id}"? This cannot be undone.`)) return;
    await api.deleteDeck(id);
    await refresh();
  }

  async function handleExport(id: string): Promise<void> {
    try {
      await api.exportDeck(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'export failed';
      window.alert(`Export failed: ${msg}`);
    }
  }

  return (
    <div className="page deck-list-page">
      <div className="page-header">
        <h1>Library</h1>
        <Link to="/decks/upload" className="btn primary" data-testid="upload-link">
          <Plus className="btn-icon" aria-hidden size={16} />
          Upload .stage
        </Link>
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : decks.length === 0 ? (
        <div className="empty" data-testid="empty-library">
          <p>No decks yet.</p>
          <p>
            <Link to="/decks/upload">Upload your first .stage package</Link>
          </p>
        </div>
      ) : (
        <ul className="deck-grid" data-testid="deck-grid">
          {decks.map((d) => (
            <li key={d.id} className="deck-card">
              <Link
                to={`/decks/${encodeURIComponent(d.id)}`}
                className="deck-card-body"
                data-testid={`deck-card-${d.id}`}
              >
                <div className="deck-card-thumb">
                  {d.coverThumbnail ? (
                    <img
                      className="deck-card-cover"
                      src={storageAssetUrl(d.id, d.coverThumbnail, d.storageToken)}
                      alt={`${d.title} cover`}
                      loading="lazy"
                    />
                  ) : (
                    <span className="deck-card-id">#{d.id}</span>
                  )}
                </div>
                <div className="deck-card-meta">
                  <h3>{d.title}</h3>
                  {d.subtitle && <p className="muted">{d.subtitle}</p>}
                  <p className="muted small">
                    {d.totalSlides} slides · {d.width}×{d.height} ·{' '}
                    {(d.sizeBytes / 1024).toFixed(1)} KB
                  </p>
                  {d.offline ? (
                    <p
                      className={`deck-offline-badge${d.offline.ready ? ' ready' : ' partial'}`}
                      data-testid={`deck-card-offline-${d.id}`}
                      data-offline-ready={d.offline.ready ? 'true' : 'false'}
                      title={
                        d.offline.ready
                          ? `Offline ready · ${d.offline.mirroredAssets} mirrored assets`
                          : `Partial offline · ${d.offline.mirroredAssets} mirrored, ${d.offline.skippedUrls} skipped`
                      }
                    >
                      <WifiOff className="btn-icon" aria-hidden size={12} />
                      {d.offline.ready
                        ? 'Offline ready'
                        : `Partial offline (${d.offline.skippedUrls} skipped)`}
                    </p>
                  ) : null}
                </div>
              </Link>
              <div className="deck-card-actions">
                <button
                  className="btn ghost"
                  onClick={() => void handleExport(d.id)}
                  aria-label={`export ${d.title}`}
                  data-testid={`deck-card-export-${d.id}`}
                  title="Download as .stage (incl. edited notes)"
                >
                  <Download className="btn-icon" aria-hidden size={16} />
                  Export
                </button>
                <button
                  className="btn ghost danger"
                  onClick={() => void handleDelete(d.id)}
                  aria-label={`delete ${d.title}`}
                >
                  <Trash2 className="btn-icon" aria-hidden size={16} />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
