/**
 * Cross-window sync over BroadcastChannel. Spec §9.3 recommends BroadcastChannel
 * for same-origin presenter ↔ audience pairing — same browser, different
 * windows, zero backend hops.
 *
 * Two roles:
 *   - "presenter" → authoritative source. Owns navigation, tool, strokes, cursor.
 *   - "audience"  → mirror. Receives messages, renders, never sends authoritative
 *                   state back. (Joining an audience triggers a snapshot
 *                   request so it catches up to the presenter's current state.)
 *
 * The channel name is per-deck so two decks open simultaneously don't cross-talk.
 *
 * Messages are kept narrow on purpose. We don't sync individual stroke points
 * during a draft — we sync the *whole* committed strokes array on every
 * change ("strokes" message) and additionally broadcast a transient "draft"
 * stroke at ~30Hz while the presenter is mid-drag, so the audience can see
 * ink streaming in real time the same way PowerPoint's pen does.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Stroke } from '@slidestage/shared';
import type { PenColor, Tool } from './types.js';

export type Role = 'presenter' | 'audience';

export interface SnapshotState {
  slideIdx: number;
  tool: Tool;
  penColor: PenColor;
  strokesByIdx: Record<number, Stroke[]>;
  blackoutAt: { x: number; y: number } | null;
  pointerPos: { x: number; y: number } | null;
  /**
   * Current spotlight aperture (CSS pixels). Audience mirrors this so the
   * spotlight circle on the projection screen matches the presenter's.
   * Optional for back-compat: snapshots produced by older presenters that
   * predate this field will fall back to the default.
   */
  spotlightRadius?: number;
}

export type SyncMessage =
  /** A new participant just joined the channel. */
  | { type: 'hello'; role: Role }
  /** A new audience asks the presenter to push a full snapshot. */
  | { type: 'request-snapshot' }
  /** Presenter pushes a full snapshot (slide / tool / strokes / cursor). */
  | { type: 'snapshot'; state: SnapshotState }
  /** Presenter changed the active slide. */
  | { type: 'slide'; slideIdx: number }
  /** Presenter switched tools (incl. blackout/whiteout/spotlight). */
  | { type: 'tool'; tool: Tool }
  /** Presenter chose a new pen color (cosmetic on audience side). */
  | { type: 'color'; color: PenColor }
  /** Presenter committed a new stroke array for slide N (full replacement). */
  | { type: 'strokes'; slideIdx: number; strokes: Stroke[] }
  /** Presenter is mid-drag — render this transient stroke on the active slide. */
  | { type: 'draft'; slideIdx: number; stroke: Stroke | null }
  /** Presenter pointer moved (logical 1920×1080 coords). null = pointer left stage. */
  | { type: 'pointer'; pos: { x: number; y: number } | null }
  /** Presenter resized the spotlight aperture (CSS pixels). */
  | { type: 'spotlight-radius'; radius: number };

export interface PresentationSyncApi {
  /** Send a message. No-op if the channel hasn't opened. */
  send: (msg: SyncMessage) => void;
  /** Whether BroadcastChannel is available in this browser. */
  available: boolean;
}

/**
 * Open / close a BroadcastChannel keyed off the deck id, dispatching incoming
 * messages to the consumer's handler. The handler ref is read on each event
 * so callers can use stale-closure-free captures without re-opening the
 * channel on every render.
 */
export function usePresentationSync(opts: {
  deckId: string;
  role: Role;
  onMessage?: (msg: SyncMessage) => void;
  /** Disable sync entirely (e.g. fall back to single-window mode). */
  enabled?: boolean;
}): PresentationSyncApi {
  const { deckId, role, onMessage, enabled = true } = opts;

  const handlerRef = useRef<typeof onMessage>(onMessage);
  handlerRef.current = onMessage;

  const channelRef = useRef<BroadcastChannel | null>(null);
  const available =
    enabled && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined';

  useEffect(() => {
    if (!available) return;
    const ch = new BroadcastChannel(channelName(deckId));
    channelRef.current = ch;

    const onMsg = (ev: MessageEvent<SyncMessage>): void => {
      const data = ev.data;
      if (!data || typeof data !== 'object' || !('type' in data)) return;
      handlerRef.current?.(data);
    };
    ch.addEventListener('message', onMsg);

    // Announce ourselves so the other side can react (e.g. presenter
    // re-broadcasts a snapshot when an audience says hello).
    ch.postMessage({ type: 'hello', role } satisfies SyncMessage);

    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
      channelRef.current = null;
    };
  }, [available, deckId, role]);

  const send = useCallback((msg: SyncMessage) => {
    channelRef.current?.postMessage(msg);
  }, []);

  return useMemo(() => ({ send, available }), [send, available]);
}

/** Stable channel name. Exported so tests / debugging can join it directly. */
export function channelName(deckId: string): string {
  return `slidestage-deck::${deckId}`;
}
