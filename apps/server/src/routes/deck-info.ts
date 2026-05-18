/**
 * Deck info-editing route — Stage A.6 extension.
 *
 *   PATCH /api/decks/:id/info   body: DeckInfoPatchBody (see @slidestage/shared)
 *
 * Lets the deck owner update top-level manifest metadata (title / subtitle /
 * author / description) and each slide's display label without re-uploading
 * the package. The contract mirrors `routes/notes.ts`: every successful
 * patch fans out atomically to **four** places so a re-export immediately
 * reflects the change.
 *
 *   1. `Deck` row (title / subtitle / author / description columns)
 *   2. `Deck.manifest` JSON mirror in DB
 *   3. `<storageRoot>/<deckId>/manifest.json` on disk (atomic rename)
 *   4. `Slide.label` rows (one update per slide whose label changed)
 *
 * Disk writes happen *before* the DB transaction so a crash mid-patch never
 * leaves the DB ahead of disk. The original manifest text is captured first
 * and re-written if the DB transaction throws, keeping disk and DB in sync.
 */
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  ERROR_CODES,
  SlideStageError,
  deckInfoPatchBodySchema,
  type DeckInfoPatchResponse,
  type Manifest,
} from '@slidestage/shared';
import type { AppConfig } from '../config.js';
import { getPrisma } from '../db.js';
import { getUserId } from '../auth.js';
import { acquireDeckMutationLock } from '../deck-locks.js';

interface RouteDeps {
  config: AppConfig;
}

const paramsSchema = z.object({ id: z.string() });

async function atomicWriteFile(
  target: string,
  contents: string,
): Promise<void> {
  const tmp = `${target}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, contents, 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

type DeckField = 'title' | 'subtitle' | 'author' | 'description';

export async function registerDeckInfoRoute(
  app: FastifyInstance,
  { config }: RouteDeps,
): Promise<void> {
  const prisma = getPrisma();

  app.patch<{ Params: { id: string } }>(
    '/api/decks/:id/info',
    async (req, reply): Promise<DeckInfoPatchResponse> => {
      const userId = await getUserId(req, config);
      const { id } = paramsSchema.parse(req.params);
      const releaseDeckLock = await acquireDeckMutationLock(id);

      try {
      const deck = await prisma.deck.findUnique({ where: { id } });
      if (!deck || deck.ownerId !== userId) {
        reply.code(404);
        throw new SlideStageError(
          ERROR_CODES.EMISSINGFILE,
          `deck not found: ${id}`,
          404,
        );
      }

      const body = deckInfoPatchBodySchema.parse(req.body);
      const manifest = JSON.parse(deck.manifest) as Manifest;

      // Deck-level metadata — apply only when the key is present in the
      // patch (not just truthy) so callers can clear a field by sending
      // null explicitly. `title` cannot be cleared (schema guards against
      // empty strings + ZodOptional rejects null).
      const deckFieldsChanged: DeckField[] = [];
      if (body.title !== undefined && manifest.title !== body.title) {
        manifest.title = body.title;
        deckFieldsChanged.push('title');
      }
      if (body.subtitle !== undefined && manifest.subtitle !== body.subtitle) {
        manifest.subtitle = body.subtitle;
        deckFieldsChanged.push('subtitle');
      }
      if (body.author !== undefined && manifest.author !== body.author) {
        manifest.author = body.author;
        deckFieldsChanged.push('author');
      }
      if (
        body.description !== undefined &&
        manifest.description !== body.description
      ) {
        manifest.description = body.description;
        deckFieldsChanged.push('description');
      }

      // Per-slide labels. Indices outside [1, totalSlides] yield 400 — the
      // client should only send indices it already knows about.
      const slideLabelsChanged: number[] = [];
      if (body.slideLabels) {
        const total = manifest.slides.length;
        const labelEntries = Object.entries(body.slideLabels);
        if (labelEntries.length > total) {
          throw new SlideStageError(
            ERROR_CODES.ETOOLARGE,
            `slideLabels patch has ${labelEntries.length} entries; deck has ${total} slides`,
            413,
          );
        }
        for (const [key, value] of labelEntries) {
          const idx = Number(key);
          if (!Number.isInteger(idx) || idx < 1 || idx > total) {
            throw new SlideStageError(
              ERROR_CODES.EBADMANIFEST,
              `slideIdx ${key} is out of range (1..${total})`,
              400,
            );
          }
          const slot = manifest.slides[idx - 1];
          if (!slot) continue;
          // Treat null / empty string as "reset" — fall back to the slide
          // id so the manifest never carries an empty label (validates
          // against `z.string()`). Matches the upload-time normalization
          // performed in `apps/server/src/pipeline/manifest.ts`.
          const next =
            value === null || value === undefined || value === ''
              ? slot.id
              : value;
          if (slot.label !== next) {
            slot.label = next;
            slideLabelsChanged.push(idx);
          }
        }
      }

      // No-op patch: short-circuit without touching disk or DB. This keeps
      // the auto-save path quiet when the form is edited and reverted.
      if (deckFieldsChanged.length === 0 && slideLabelsChanged.length === 0) {
        return {
          ok: true,
          deckFieldsChanged: [],
          slideLabelsChanged: [],
          manifestUpdatedAt: manifest.updatedAt,
        };
      }

      const nowIso = new Date().toISOString();
      manifest.updatedAt = nowIso;

      const storageDir = path.join(config.storageRoot, deck.storageRoot);
      const manifestPath = path.join(storageDir, 'manifest.json');

      try {
        await fs.access(storageDir);
      } catch {
        throw new SlideStageError(
          ERROR_CODES.EMISSINGFILE,
          `deck storage missing on disk: ${deck.storageRoot}`,
          500,
        );
      }

      const manifestJson = JSON.stringify(manifest, null, 2);

      let originalManifestText: string | null = null;
      try {
        originalManifestText = await fs.readFile(manifestPath, 'utf8');
      } catch {
        originalManifestText = null;
      }

      await atomicWriteFile(manifestPath, manifestJson);

      try {
        await prisma.$transaction(async (tx) => {
          await tx.deck.update({
            where: { id: deck.id },
            data: {
              title: manifest.title,
              subtitle: manifest.subtitle,
              author: manifest.author,
              description: manifest.description,
              manifest: JSON.stringify(manifest),
            },
          });
          for (const slideIdx of slideLabelsChanged) {
            const slot = manifest.slides[slideIdx - 1];
            if (!slot) continue;
            await tx.slide.update({
              where: { deckId_idx: { deckId: deck.id, idx: slideIdx } },
              data: { label: slot.label ?? null },
            });
          }
        });
      } catch (err) {
        if (originalManifestText !== null) {
          await atomicWriteFile(manifestPath, originalManifestText).catch(
            () => {},
          );
        }
        throw err;
      }

      return {
        ok: true,
        deckFieldsChanged,
        slideLabelsChanged,
        manifestUpdatedAt: nowIso,
      };
      } finally {
        releaseDeckLock();
      }
    },
  );
}
