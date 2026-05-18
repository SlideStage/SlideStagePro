/**
 * Annotation API (spec §8.4). Strokes are stored as a JSON-stringified array
 * keyed by (deckId, userId, slideIdx) — exactly the table layout in
 * Prisma. We keep responses tiny because they're polled often during a talk.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ERROR_CODES,
  SlideStageError,
  MAX_STROKES_PER_SLIDE,
  annotationsPatchBodySchema,
  annotationsPutBodySchema,
} from '@slidestage/shared';
import type { Stroke } from '@slidestage/shared';
import type { AppConfig } from '../config.js';
import { getPrisma } from '../db.js';
import { getUserId } from '../auth.js';

const slideParamsSchema = z.object({
  id: z.string(),
  slideIdx: z.coerce.number().int().min(1),
});

interface OwnedDeckInfo {
  totalSlides: number;
}

export async function registerAnnotationRoutes(
  app: FastifyInstance,
  { config }: { config: AppConfig },
): Promise<void> {
  const prisma = getPrisma();

  async function ensureDeckOwned(
    deckId: string,
    userId: string,
  ): Promise<OwnedDeckInfo> {
    const deck = await prisma.deck.findUnique({
      where: { id: deckId },
      select: { ownerId: true, totalSlides: true },
    });
    if (!deck || deck.ownerId !== userId) {
      throw new SlideStageError(
        ERROR_CODES.EMISSINGFILE,
        `deck not found: ${deckId}`,
        404,
      );
    }
    return { totalSlides: deck.totalSlides };
  }

  function ensureSlideInDeck(slideIdx: number, totalSlides: number): void {
    if (slideIdx > totalSlides) {
      throw new SlideStageError(
        ERROR_CODES.EBADMANIFEST,
        `slideIdx ${slideIdx} is out of range (1..${totalSlides})`,
        400,
      );
    }
  }

  /* ---------- GET /api/decks/:id/annotations ---------- */

  app.get<{ Params: { id: string } }>(
    '/api/decks/:id/annotations',
    async (req) => {
      const userId = await getUserId(req, config);
      const deck = await ensureDeckOwned(req.params.id, userId);
      const rows = await prisma.annotation.findMany({
        where: {
          deckId: req.params.id,
          userId,
          slideIdx: { gte: 1, lte: deck.totalSlides },
        },
      });
      const out: Record<number, Stroke[]> = {};
      for (const r of rows) {
        out[r.slideIdx] = JSON.parse(r.strokes) as Stroke[];
      }
      return { annotations: out };
    },
  );

  /* ---------- GET /api/decks/:id/annotations/:slideIdx ---------- */

  app.get<{ Params: { id: string; slideIdx: string } }>(
    '/api/decks/:id/annotations/:slideIdx',
    async (req) => {
      const userId = await getUserId(req, config);
      const { id, slideIdx } = slideParamsSchema.parse(req.params);
      const deck = await ensureDeckOwned(id, userId);
      ensureSlideInDeck(slideIdx, deck.totalSlides);
      const row = await prisma.annotation.findUnique({
        where: { deckId_userId_slideIdx: { deckId: id, userId, slideIdx } },
      });
      return { strokes: row ? (JSON.parse(row.strokes) as Stroke[]) : [] };
    },
  );

  /* ---------- POST /api/decks/:id/annotations/:slideIdx (replace) ---------- */

  app.post<{ Params: { id: string; slideIdx: string } }>(
    '/api/decks/:id/annotations/:slideIdx',
    async (req) => {
      const userId = await getUserId(req, config);
      const { id, slideIdx } = slideParamsSchema.parse(req.params);
      const deck = await ensureDeckOwned(id, userId);
      ensureSlideInDeck(slideIdx, deck.totalSlides);
      const body = annotationsPutBodySchema.parse(req.body);
      await prisma.annotation.upsert({
        where: { deckId_userId_slideIdx: { deckId: id, userId, slideIdx } },
        create: {
          deckId: id,
          userId,
          slideIdx,
          strokes: JSON.stringify(body.strokes),
        },
        update: { strokes: JSON.stringify(body.strokes) },
      });
      return { ok: true, count: body.strokes.length };
    },
  );

  /* ---------- PATCH /api/decks/:id/annotations/:slideIdx (append/remove) -- */

  app.patch<{ Params: { id: string; slideIdx: string } }>(
    '/api/decks/:id/annotations/:slideIdx',
    async (req) => {
      const userId = await getUserId(req, config);
      const { id, slideIdx } = slideParamsSchema.parse(req.params);
      const deck = await ensureDeckOwned(id, userId);
      ensureSlideInDeck(slideIdx, deck.totalSlides);
      const body = annotationsPatchBodySchema.parse(req.body);

      const existingRow = await prisma.annotation.findUnique({
        where: { deckId_userId_slideIdx: { deckId: id, userId, slideIdx } },
      });
      const existing: Stroke[] = existingRow
        ? (JSON.parse(existingRow.strokes) as Stroke[])
        : [];

      let next: Stroke[];
      if ('append' in body) {
        next = [...existing, ...body.append];
      } else {
        const removeSet = new Set(body.remove);
        next = existing.filter((_, i) => !removeSet.has(i));
      }
      if (next.length > MAX_STROKES_PER_SLIDE) {
        throw new SlideStageError(
          ERROR_CODES.ETOOLARGE,
          `annotations exceed ${MAX_STROKES_PER_SLIDE} strokes for slide ${slideIdx}`,
          413,
        );
      }

      await prisma.annotation.upsert({
        where: { deckId_userId_slideIdx: { deckId: id, userId, slideIdx } },
        create: {
          deckId: id,
          userId,
          slideIdx,
          strokes: JSON.stringify(next),
        },
        update: { strokes: JSON.stringify(next) },
      });
      return { ok: true, count: next.length };
    },
  );

  /* ---------- DELETE /api/decks/:id/annotations/:slideIdx ---------- */

  app.delete<{ Params: { id: string; slideIdx: string } }>(
    '/api/decks/:id/annotations/:slideIdx',
    async (req, reply) => {
      const userId = await getUserId(req, config);
      const { id, slideIdx } = slideParamsSchema.parse(req.params);
      const deck = await ensureDeckOwned(id, userId);
      ensureSlideInDeck(slideIdx, deck.totalSlides);
      await prisma.annotation.deleteMany({
        where: { deckId: id, userId, slideIdx },
      });
      reply.code(204).send();
    },
  );
}
