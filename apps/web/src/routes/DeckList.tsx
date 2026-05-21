import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Eye, Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { DeckSummary } from "../api/types";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Empty } from "../components/Empty";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { formatRelative, truncate } from "../lib/format";

const PAGE_SIZE = 20;

export function DeckList() {
  const [items, setItems] = useState<DeckSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeckSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadPage = useCallback(
    async (nextCursor?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.decks.list({
          limit: PAGE_SIZE,
          cursor: nextCursor ?? undefined,
        });
        setItems((prev) => (nextCursor ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor ?? null);
        setHasMore(Boolean(res.nextCursor));
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to load decks.");
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.decks.delete(pendingDelete.id);
      setItems((prev) => prev.filter((d) => d.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Delete failed.");
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <header className="page-header">
        <div className="page-header__heading">
          <h1>Decks</h1>
          <p>Every deck you have access to. Owners can delete; admins see everyone&apos;s.</p>
        </div>
        <Link to="/decks/upload">
          <Button variant="primary" leadingIcon={<Plus size={14} aria-hidden />}>
            Upload deck
          </Button>
        </Link>
      </header>

      <Card padded={false}>
        {error ? (
          <div className="alert alert--error" style={{ margin: 12 }}>
            {error}
          </div>
        ) : null}
        {loading && items.length === 0 ? (
          <div style={{ padding: 32, display: "grid", placeItems: "center" }}>
            <Spinner label="Loading decks…" />
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 24 }}>
            <Empty
              title="No decks yet"
              description="Upload a `.stage` package to populate this list."
              action={
                <Link to="/decks/upload">
                  <Button variant="primary" leadingIcon={<Plus size={14} aria-hidden />}>
                    Upload deck
                  </Button>
                </Link>
              }
            />
          </div>
        ) : (
          <div className="table-wrap" style={{ border: "none", borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Slides</th>
                  <th>Updated</th>
                  <th>Visibility</th>
                  <th style={{ width: 1 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((deck) => (
                  <tr key={deck.id}>
                    <td>
                      <Link
                        to={`/decks/${deck.id}`}
                        style={{ fontWeight: 500, color: "inherit" }}
                      >
                        {truncate(deck.title, 64)}
                      </Link>
                    </td>
                    <td>{deck.slideCount}</td>
                    <td>{formatRelative(deck.updatedAt)}</td>
                    <td>
                      <span className="tag">{deck.visibility}</span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <Link to={`/decks/${deck.id}`}>
                          <Button
                            variant="ghost"
                            size="sm"
                            leadingIcon={<Eye size={13} aria-hidden />}
                          >
                            Open
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<Trash2 size={13} aria-hidden />}
                          onClick={() => setPendingDelete(deck)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {hasMore && items.length > 0 ? (
        <div className="row row--end">
          <Button
            variant="secondary"
            size="sm"
            loading={loading}
            onClick={() => void loadPage(cursor)}
          >
            Load more
          </Button>
        </div>
      ) : null}

      <Modal
        open={!!pendingDelete}
        onClose={() => (deleting ? undefined : setPendingDelete(null))}
        title="Delete this deck?"
        description={
          pendingDelete
            ? `"${truncate(pendingDelete.title, 60)}" will be permanently removed, along with its notes and annotations. This cannot be undone.`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={confirmDelete}
              loading={deleting}
            >
              Delete deck
            </Button>
          </>
        }
      />
    </div>
  );
}
