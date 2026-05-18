/**
 * Tiny shared hook used by every viewer page that needs to fetch a deck and,
 * optionally, its current annotations. Splitting it out keeps DeckViewerPage,
 * PresenterViewPage, and AudienceViewPage focused on layout instead of plumbing.
 */

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import type { Stroke } from '@slidestage/shared';
import { api, type DeckDetail } from '../api/client.js';

export function useDeckLoader(deckId: string): {
  deck: DeckDetail | null;
  error: string | null;
  setDeck: Dispatch<SetStateAction<DeckDetail | null>>;
} {
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDeck(null);
    setError(null);
    api
      .getDeck(deckId)
      .then((d) => {
        if (!cancelled) setDeck(d);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  return { deck, error, setDeck };
}

export function useInitialAnnotations(
  deckId: string | null,
  apply: (strokes: Record<number, Stroke[]>) => void,
): void {
  useEffect(() => {
    if (!deckId) return;
    let cancelled = false;
    api
      .getAnnotations(deckId)
      .then((res) => {
        if (cancelled) return;
        apply(res.annotations);
      })
      .catch(() => {
        // Soft-fail; viewers continue with empty annotations.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);
}
