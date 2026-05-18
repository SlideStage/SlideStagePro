/**
 * Speaker-notes editing protocol (Stage A.5).
 *
 * Per spec §9.1, the canonical source for a slide's notes is
 * `manifest.slides[i].notes`. Owner-side edits flow through this schema:
 *
 *   PATCH /api/decks/:id/notes
 *   body  → NotesPatchBody
 *   resp  → NotesPatchResponse
 *
 * The keys in `notes` are **1-based slide indices** to match manifest.slides[].index
 * (the rest of the codebase already uses 1-based indices on the wire — see
 * apps/web for hash-based slide ids and apps/server/src/routes/decks.ts).
 *
 * A null/empty value clears the note for that slide. Slide indices missing
 * from the patch are left untouched, so the client can send sparse updates.
 */

import { z } from 'zod';
import { MAX_SLIDE_NOTES_LENGTH } from './manifest.js';

export const MAX_NOTES_PATCH_ENTRIES = 500;

export const notesPatchBodySchema = z
  .object({
    notes: z.record(
      z.string().regex(/^\d+$/, 'slide index must be a positive integer'),
      z.string().max(MAX_SLIDE_NOTES_LENGTH).nullable(),
    ),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.keys(body.notes).length > MAX_NOTES_PATCH_ENTRIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message: `notes must contain at most ${MAX_NOTES_PATCH_ENTRIES} entries`,
      });
    }
  });

export type NotesPatchBody = z.infer<typeof notesPatchBodySchema>;

export interface NotesPatchResponse {
  ok: true;
  /** count of slide notes that ended up changing on disk */
  updated: number;
  /** echo of the new manifest's `updatedAt` so the UI can refresh local state */
  manifestUpdatedAt: string;
}

/**
 * One entry in the speaker-notes audit log.
 *
 *   GET /api/decks/:id/notes/audit  →  { entries: NoteEditEntry[] }
 *
 * `previousNotes` / `newNotes` are kept verbatim (including the empty
 * string that the PATCH route normalizes to `null`). Most-recent first.
 */
export interface NoteEditEntry {
  id: number;
  deckId: string;
  userId: string;
  slideIdx: number;
  previousNotes: string | null;
  newNotes: string | null;
  /** ISO timestamp. */
  editedAt: string;
}

export interface NotesAuditResponse {
  entries: NoteEditEntry[];
  /** Pass back as `?cursor=<value>` to fetch the next page; null = end. */
  nextCursor: number | null;
}

/**
 * Default page size for `GET /notes/audit`. Mirrors a sensible "first
 * screen" — large enough that small decks fit in one shot, small enough
 * that the response stays cheap on long-lived decks.
 */
export const NOTES_AUDIT_DEFAULT_LIMIT = 50;
export const NOTES_AUDIT_MAX_LIMIT = 200;
