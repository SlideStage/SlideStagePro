import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useDebouncedCallback } from "../lib/useDebouncedCallback";
import { Textarea } from "./Input";

type SaveState = "idle" | "saving" | "saved" | "error";

type Props = {
  deckId: string;
  slideIndex: number;
  /** Optional default text from the manifest, shown as placeholder. */
  manifestNote?: string | null;
};

// Server-backed notes panel. Each slide has its own draft kept in component
// state so the textarea stays responsive while we batch upserts to the API
// every 300ms.
export function NotesPanel({ deckId, slideIndex, manifestNote }: Props) {
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const latest = useRef<{ deckId: string; slideIndex: number }>({ deckId, slideIndex });

  useEffect(() => {
    latest.current = { deckId, slideIndex };
  });

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    api.notes
      .list(deckId)
      .then((res) => {
        if (cancelled) return;
        const next: Record<number, string> = {};
        for (const item of res.items) {
          next[item.slideIndex] = item.body;
        }
        setNotes(next);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status !== 404) {
          setError(err.message);
        }
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  const persist = useCallback(
    async (index: number, body: string) => {
      // Only upsert if it still matches the current targeted slide, but flush
      // older slides too — we want notes to land even when the user is fast.
      setSaveState("saving");
      try {
        await api.notes.upsert(latest.current.deckId, index, body);
        // Stale-save guard: don't overwrite a newer "saved" with an older one.
        if (latest.current.slideIndex === index) {
          setSaveState("saved");
        }
        setError(null);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to save notes.");
        }
        setSaveState("error");
      }
    },
    [],
  );

  const { debounced: debouncedSave, flush } = useDebouncedCallback(persist, 300);

  // Flush whenever the slide changes so the previous slide's pending draft
  // hits the server before we move on.
  useEffect(() => {
    flush();
  }, [slideIndex, flush]);

  // Reset the save indicator after the "saved" toast lingers a moment.
  useEffect(() => {
    if (saveState !== "saved") return;
    const t = setTimeout(() => setSaveState("idle"), 1500);
    return () => clearTimeout(t);
  }, [saveState]);

  const value = notes[slideIndex] ?? "";
  const placeholder = useMemo(
    () => manifestNote ?? "Type private notes for this slide. Saved automatically.",
    [manifestNote],
  );

  function onChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    setNotes((prev) => ({ ...prev, [slideIndex]: next }));
    debouncedSave(slideIndex, next);
  }

  return (
    <div className="stack" style={{ flex: 1, minHeight: 0 }}>
      <div className="row row--between">
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>Notes</h3>
        <span className="notes-status" aria-live="polite">
          {saveState === "saving" ? (
            <>
              <Loader2 size={12} aria-hidden /> Saving…
            </>
          ) : saveState === "saved" ? (
            <>
              <CheckCircle2 size={12} aria-hidden /> Saved
            </>
          ) : null}
        </span>
      </div>
      {error ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}
      <Textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={10}
        disabled={!loaded}
        style={{ flex: 1, resize: "none" }}
      />
      <div className="muted" style={{ fontSize: 11.5 }}>
        Slide {slideIndex + 1} · saves to <code>/api/decks/&lt;id&gt;/notes/{slideIndex}</code>
      </div>
    </div>
  );
}
