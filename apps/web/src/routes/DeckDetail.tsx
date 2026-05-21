import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import type { LoadedDeck, ManifestSlide } from "@slidestage/core/deck/types";
import { DeckViewer } from "@slidestage/lite-preset/viewer/DeckViewer";
import { api, ApiError } from "../api/client";
import type { DeckDetail as DeckDetailResponse } from "../api/types";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Modal } from "../components/Modal";
import { NotesPanel } from "../components/NotesPanel";
import { Spinner } from "../components/Spinner";
import { loadDeckFromServer } from "../lib/deckLoader";
import { formatAbsolute, formatRelative, truncate } from "../lib/format";

type ManifestSummary = {
  slides: ManifestSlide[];
  title: string;
};

function extractManifestSummary(detail: DeckDetailResponse): ManifestSummary {
  const manifest = detail.manifest as Partial<{ slides: ManifestSlide[]; title: string }> | null;
  const slides = Array.isArray(manifest?.slides) ? manifest!.slides : [];
  const title = typeof manifest?.title === "string" ? manifest.title : detail.title;
  return { slides, title };
}

export function DeckDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<DeckDetailResponse | null>(null);
  const [deck, setDeck] = useState<LoadedDeck | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deckRef = useRef<LoadedDeck | null>(null);

  // Fetch metadata + blob in parallel.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDeck(null);
    deckRef.current?.revoke();
    deckRef.current = null;

    (async () => {
      try {
        const [meta, loaded] = await Promise.all([
          api.decks.get(id),
          loadDeckFromServer(id),
        ]);
        if (cancelled) {
          loaded.revoke();
          return;
        }
        setDetail(meta);
        setDeck(loaded);
        deckRef.current = loaded;
        setCurrentIndex(0);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError((err as Error)?.message ?? "Failed to load deck.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Release transport / blob URLs when the route unmounts.
  useEffect(() => {
    return () => {
      deckRef.current?.revoke();
      deckRef.current = null;
    };
  }, []);

  const summary = useMemo(() => (detail ? extractManifestSummary(detail) : null), [detail]);

  const slides: ManifestSlide[] = useMemo(() => {
    if (deck) return deck.manifest.slides;
    if (summary) return summary.slides;
    return [];
  }, [deck, summary]);

  const safeIndex = slides.length > 0 ? Math.min(currentIndex, slides.length - 1) : 0;
  const currentSlide = slides[safeIndex];

  const onNavigate = useCallback(
    (index: number) => {
      if (!Number.isFinite(index)) return;
      setCurrentIndex(Math.max(0, Math.min(slides.length - 1, Math.floor(index))));
    },
    [slides.length],
  );

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await api.decks.delete(id);
      navigate("/decks", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Delete failed.");
      }
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  if (loading && !detail) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: 320 }}>
        <Spinner label="Loading deck…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack">
        <Link to="/decks">
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<ArrowLeft size={13} aria-hidden />}
          >
            Back to decks
          </Button>
        </Link>
        <div className="alert alert--error">{error}</div>
      </div>
    );
  }

  if (!detail) return null;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Link to="/decks">
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<ArrowLeft size={13} aria-hidden />}
        >
          All decks
        </Button>
      </Link>

      <header className="page-header">
        <div className="page-header__heading">
          <h1>{truncate(detail.title, 80)}</h1>
          <div className="deck-detail__meta">
            <span>
              <strong>{slides.length}</strong> slides
            </span>
            <span>
              Updated <strong>{formatRelative(detail.updatedAt)}</strong>
            </span>
            <span>
              <span className="tag">{detail.visibility}</span>
            </span>
            <span className="mono">{detail.fingerprint.slice(0, 18)}…</span>
          </div>
        </div>
        <Button
          variant="ghost"
          leadingIcon={<Trash2 size={14} aria-hidden />}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </header>

      <div className="deck-detail__grid">
        <aside className="deck-detail__rail" aria-label="Slide navigator">
          {slides.length === 0 ? (
            <div style={{ padding: 12, color: "var(--color-text-muted)", fontSize: 12.5 }}>
              No slides in manifest.
            </div>
          ) : (
            slides.map((slide, index) => (
              <button
                key={slide.id || index}
                className={`slide-thumb ${index === safeIndex ? "is-active" : ""}`}
                onClick={() => onNavigate(index)}
                type="button"
              >
                <span className="slide-thumb__index">{index + 1}</span>
                <span className="slide-thumb__label">
                  {truncate(slide.label || `Slide ${index + 1}`, 32)}
                </span>
              </button>
            ))
          )}
        </aside>

        <div className="deck-detail__viewer">
          {deck ? (
            <DeckViewer
              deck={deck}
              currentIndex={safeIndex}
              showOverview={showOverview}
              showNotes={showNotes}
              onNavigate={onNavigate}
              onCloseOverview={() => setShowOverview(false)}
              onToggleOverview={() => setShowOverview((v) => !v)}
              onCloseNotes={() => setShowNotes(false)}
              onToggleNotes={() => setShowNotes((v) => !v)}
              onCloseDeck={() => navigate("/decks")}
            />
          ) : (
            <div className="deck-detail__viewer-empty">
              <Spinner label="Loading slides…" />
            </div>
          )}
        </div>

        <aside className="deck-detail__notes" aria-label="Notes">
          {id ? (
            <NotesPanel
              deckId={id}
              slideIndex={safeIndex}
              manifestNote={currentSlide?.notes ?? null}
            />
          ) : null}
        </aside>
      </div>

      {detail.currentVersion ? (
        <Card padded title="Current version" description="The active `.stage` blob backing this deck.">
          <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
            <div className="muted">
              <strong style={{ color: "var(--color-text)" }}>SHA-256</strong>
              <div className="mono">{detail.currentVersion.sha256.slice(0, 28)}…</div>
            </div>
            <div className="muted">
              <strong style={{ color: "var(--color-text)" }}>Created</strong>
              <div>{formatAbsolute(detail.currentVersion.createdAt)}</div>
            </div>
          </div>
        </Card>
      ) : null}

      <Modal
        open={confirmDelete}
        onClose={() => (deleting ? undefined : setConfirmDelete(false))}
        title="Delete this deck?"
        description={`"${truncate(detail.title, 60)}" will be permanently removed.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deleting}>
              Delete deck
            </Button>
          </>
        }
      />
    </div>
  );
}
