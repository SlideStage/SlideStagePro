import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Eye, FileText, Plus, Presentation, Upload } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { DeckSummary } from "../api/types";
import { useSession, type SessionUser } from "../auth/client";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Empty } from "../components/Empty";
import { Spinner } from "../components/Spinner";
import { formatRelative, truncate } from "../lib/format";

export function Dashboard() {
  const { data } = useSession();
  const user = data?.user as SessionUser | undefined;

  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.decks
      .list({ limit: 5 })
      .then((res) => {
        if (cancelled) return;
        setDecks(res.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to load decks.");
        }
        setDecks([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <header className="page-header">
        <div className="page-header__heading">
          <h1>Welcome back{user?.name ? `, ${user.name.split(" ")[0]}` : ""}.</h1>
          <p>Manage your `.stage` decks, notes, and team access from here.</p>
        </div>
        <Link to="/decks/upload">
          <Button variant="primary" leadingIcon={<Upload size={14} aria-hidden />}>
            Upload deck
          </Button>
        </Link>
      </header>

      <Card
        title="Recent decks"
        description="The five most recently updated decks you own."
        actions={
          <Link to="/decks">
            <Button variant="ghost" size="sm">
              View all
            </Button>
          </Link>
        }
      >
        {error ? <div className="alert alert--error">{error}</div> : null}
        {!decks ? (
          <Spinner label="Loading decks…" />
        ) : decks.length === 0 ? (
          <Empty
            icon={<Presentation size={20} />}
            title="No decks yet"
            description="Upload your first `.stage` package to get started. It will appear here within seconds."
            action={
              <Link to="/decks/upload">
                <Button variant="primary" leadingIcon={<Plus size={14} aria-hidden />}>
                  Upload deck
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="card-grid">
            {decks.map((deck) => (
              <Card key={deck.id} className="deck-card">
                <Link
                  to={`/decks/${deck.id}`}
                  style={{ color: "inherit", textDecoration: "none" }}
                >
                  <div className="deck-card__title">
                    <FileText size={16} aria-hidden />
                    <span className="deck-card__title-text">{truncate(deck.title, 48)}</span>
                  </div>
                </Link>
                <div className="deck-card__meta">
                  <span>{deck.slideCount} slides</span>
                  <span>Updated {formatRelative(deck.updatedAt)}</span>
                </div>
                <div className="deck-card__actions">
                  <Link to={`/decks/${deck.id}`}>
                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon={<Eye size={13} aria-hidden />}
                    >
                      Open
                    </Button>
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
