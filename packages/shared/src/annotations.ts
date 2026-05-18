/**
 * Annotation protocol — spec §8.
 *
 * Stroke coordinates are always in logical stage space (manifest.dimensions),
 * not viewport pixels. This keeps annotations anchored across resolutions.
 */

import { z } from 'zod';

export const MAX_STROKES_PER_SLIDE = 1_000;
export const MAX_POINTS_PER_STROKE = 5_000;
export const MAX_STROKE_COLOR_LENGTH = 64;
export const MAX_STROKE_CID_LENGTH = 128;
export const MAX_STROKE_WIDTH = 256;
export const MAX_STROKE_COORDINATE = 100_000;

const coordinateSchema = z
  .number()
  .finite()
  .min(-MAX_STROKE_COORDINATE)
  .max(MAX_STROKE_COORDINATE);

export const strokeSchema = z
  .object({
    tool: z.enum(['pen', 'highlighter']),
    color: z.string().min(1).max(MAX_STROKE_COLOR_LENGTH),
    width: z.number().finite().positive().max(MAX_STROKE_WIDTH),
    points: z.array(
      z.tuple([coordinateSchema, coordinateSchema])
    ).min(1).max(MAX_POINTS_PER_STROKE),
    /** optional client-side id used for dedup in multi-device sync (§8.6) */
    cid: z.string().max(MAX_STROKE_CID_LENGTH).optional(),
  })
  .strict();

export type Stroke = z.infer<typeof strokeSchema>;

/** spec §8.2: a single slide's annotation set is just an array of strokes */
export type SlideAnnotations = Stroke[];

/** spec §8.2: a deck's annotations keyed by 0-based slide index */
export type DeckAnnotations = Record<number, SlideAnnotations>;

/* REST request/response schemas (spec §8.4) */

export const annotationsPutBodySchema = z
  .object({ strokes: z.array(strokeSchema).max(MAX_STROKES_PER_SLIDE) })
  .strict();

export const annotationsPatchBodySchema = z
  .union([
    z.object({ append: z.array(strokeSchema).max(MAX_STROKES_PER_SLIDE) }).strict(),
    z.object({ remove: z.array(z.number().int().nonnegative()).max(MAX_STROKES_PER_SLIDE) }).strict(),
  ]);

export type AnnotationsPutBody = z.infer<typeof annotationsPutBodySchema>;
export type AnnotationsPatchBody = z.infer<typeof annotationsPatchBodySchema>;
