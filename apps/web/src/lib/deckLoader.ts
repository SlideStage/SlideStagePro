import { loadDeck } from "@slidestage/core/deck/loadDeck";
import type { LoadedDeck } from "@slidestage/core/deck/types";
import { api } from "../api/client";

// Wraps the Pro API blob endpoint so the React tree can deal in `LoadedDeck`
// instances. The lite-preset `DeckViewer` accepts a `LoadedDeck` directly —
// no transport is wired up for v0, so `loadDeck` falls back to its `blob:`
// URL + srcdoc rendering path (see core/deck/types.d.ts §LoadedDeck).
export async function loadDeckFromServer(deckId: string): Promise<LoadedDeck> {
  const { bytes, filename } = await api.decks.blob(deckId);
  const file = new File([bytes], filename, { type: "application/zip" });
  // Inline mode 'auto' keeps oversized decks from blowing up the renderer,
  // matching the Lite web build's default.
  return loadDeck(file, { inlineMode: "auto" });
}
