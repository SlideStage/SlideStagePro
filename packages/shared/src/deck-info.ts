/**
 * Deck info-editing protocol — lets the owner update the manifest's top-level
 * metadata (title / subtitle / author / description) and each slide's
 * display label without re-uploading the package.
 *
 *   PATCH /api/decks/:id/info
 *   body  → DeckInfoPatchBody
 *   resp  → DeckInfoPatchResponse
 *
 * Wire-format rules:
 *   - All fields are optional. A field that's *absent* from the body is
 *     left untouched; a field present but `null` (subtitle / author /
 *     description / a slide's label) clears that field. `title` is the
 *     only field that must remain a non-empty string — the manifest
 *     schema enforces `z.string().min(1)`.
 *   - `slideLabels` maps 1-based slide index → new label (or null to
 *     reset the label to the slide id). Indices outside [1, totalSlides]
 *     are rejected.
 *   - Sparse patches are encouraged — the form sends only the fields that
 *     have changed (debounced auto-save, see useDeckInfoSync).
 */

import { z } from 'zod';
import {
  MAX_MANIFEST_AUTHOR_LENGTH,
  MAX_MANIFEST_DESCRIPTION_LENGTH,
  MAX_MANIFEST_SUBTITLE_LENGTH,
  MAX_MANIFEST_TITLE_LENGTH,
  MAX_SLIDE_LABEL_LENGTH,
} from './manifest.js';

export const MAX_DECK_INFO_PATCH_ENTRIES = 500;

const optionalSubtitle = z
  .string()
  .max(MAX_MANIFEST_SUBTITLE_LENGTH)
  .nullable()
  .optional();
const optionalAuthor = z
  .string()
  .max(MAX_MANIFEST_AUTHOR_LENGTH)
  .nullable()
  .optional();
const optionalDescription = z
  .string()
  .max(MAX_MANIFEST_DESCRIPTION_LENGTH)
  .nullable()
  .optional();

export const deckInfoPatchBodySchema = z
  .object({
    title: z.string().min(1).max(MAX_MANIFEST_TITLE_LENGTH).optional(),
    subtitle: optionalSubtitle,
    author: optionalAuthor,
    description: optionalDescription,
    slideLabels: z
      .record(
        z.string().regex(/^\d+$/, 'slide index must be a positive integer'),
        z.string().max(MAX_SLIDE_LABEL_LENGTH).nullable(),
      )
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      body.slideLabels &&
      Object.keys(body.slideLabels).length > MAX_DECK_INFO_PATCH_ENTRIES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slideLabels'],
        message: `slideLabels must contain at most ${MAX_DECK_INFO_PATCH_ENTRIES} entries`,
      });
    }
  });

export type DeckInfoPatchBody = z.infer<typeof deckInfoPatchBodySchema>;

export interface DeckInfoPatchResponse {
  ok: true;
  /**
   * Names of the deck-level fields that ended up changing on disk. The
   * client uses this to know what to merge into its local state.
   */
  deckFieldsChanged: Array<'title' | 'subtitle' | 'author' | 'description'>;
  /** 1-based slide indices whose label ended up changing. */
  slideLabelsChanged: number[];
  /** Echo of the new manifest's `updatedAt` so the UI can refresh state. */
  manifestUpdatedAt: string;
}
