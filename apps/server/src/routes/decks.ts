/**
 * REST routes for deck CRUD + manifest fetch.
 *
 * Endpoints:
 *   POST   /api/decks                   multipart upload .stage
 *   GET    /api/decks                   list decks owned by current user
 *   GET    /api/decks/:id               fetch deck metadata (incl. manifest)
 *   GET    /api/decks/:id/manifest      raw manifest.json
 *   DELETE /api/decks/:id               remove deck + storage
 */

import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import type { Manifest } from '@slidestage/shared';
import type { AppConfig } from '../config.js';
import { getPrisma } from '../db.js';
import { FixedWindowRateLimiter, ipRateLimitKey } from '../rate-limit.js';
import {
  ingestArchive,
  deleteDeckStorage,
  restoreDeckStorage,
  type IngestResult,
} from '../pipeline/index.js';
import { getUserId } from '../auth.js';
import { signStorageToken } from '../storage-token.js';

interface RouteDeps {
  config: AppConfig;
}

const UPLOAD_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const UPLOAD_USER_MAX = 30;
const UPLOAD_IP_MAX = 100;

export async function registerDeckRoutes(
  app: FastifyInstance,
  { config }: RouteDeps,
): Promise<void> {
  const prisma = getPrisma();
  const uploadUserLimiter = new FixedWindowRateLimiter({
    label: 'upload user',
    max: UPLOAD_USER_MAX,
    windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS,
  });
  const uploadIpLimiter = new FixedWindowRateLimiter({
    label: 'upload IP',
    max: UPLOAD_IP_MAX,
    windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS,
  });

  /* --------------------------- POST /api/decks --------------------------- */

  app.post('/api/decks', async (req, reply) => {
    const userId = await getUserId(req, config);
    uploadUserLimiter.hit(userId);
    uploadIpLimiter.hit(ipRateLimitKey(req));

    if (!req.isMultipart()) {
      throw new SlideStageError(
        ERROR_CODES.EBADMANIFEST,
        'Expected multipart/form-data with a "file" field containing the .stage archive',
        415,
      );
    }

    const part = await req.file({
      limits: { fileSize: config.maxUploadBytes },
    });
    if (!part) {
      throw new SlideStageError(
        ERROR_CODES.EUNZIP,
        'No file part found in upload',
        400,
      );
    }

    const tmpFile = path.join(
      os.tmpdir(),
      `slidestage-upload-${crypto.randomUUID()}.zip`,
    );

    try {
      await streamPipeline(part.file, createWriteStream(tmpFile));
      if (part.file.truncated) {
        throw new SlideStageError(
          ERROR_CODES.ETOOLARGE,
          `Upload exceeds maxUploadBytes=${config.maxUploadBytes}`,
          413,
        );
      }

      let result: IngestResult | null = null;
      try {
        result = await ingestArchive(tmpFile, {
          storageRoot: config.storageRoot,
          storagePrefix: userId,
          maxDecompressedBytes: config.maxDecompressedBytes,
          maxFileBytes: config.maxFileBytes,
          maxSlides: config.maxSlides,
          beforePromote: async (manifest) => {
            const existing = await prisma.deck.findUnique({
              where: { id: manifest.id },
              select: { ownerId: true },
            });
            if (existing && existing.ownerId !== userId) {
              throw new SlideStageError(
                ERROR_CODES.EBADMANIFEST,
                `deck id already exists: ${manifest.id}`,
                409,
              );
            }
          },
        });

        const ingestResult = result;
        const m = ingestResult.manifest;
        let previousStorageRoot: string | null = null;
        await prisma.$transaction(async (tx) => {
          const existing = await tx.deck.findUnique({
            where: { id: m.id },
            select: { ownerId: true, storageRoot: true },
          });
          if (existing && existing.ownerId !== userId) {
            throw new SlideStageError(
              ERROR_CODES.EBADMANIFEST,
              `deck id already exists: ${m.id}`,
              409,
            );
          }

          previousStorageRoot = existing?.storageRoot ?? null;
          // Wipe stale slide rows on re-upload so order/labels can change.
          await tx.slide.deleteMany({ where: { deckId: m.id } });
          const deckData = {
            schemaVer: m.schema,
            title: m.title,
            subtitle: m.subtitle,
            author: m.author,
            description: m.description,
            totalSlides: m.totalSlides,
            width: m.dimensions.width,
            height: m.dimensions.height,
            manifest: JSON.stringify(m),
            storageRoot: ingestResult.storageRelative,
            sizeBytes: ingestResult.totalBytes,
          };
          if (existing) {
            await tx.deck.update({
              where: { id: m.id },
              data: deckData,
            });
          } else {
            await tx.deck.create({
              data: {
                id: m.id,
                ownerId: userId,
                ...deckData,
              },
            });
          }
          await tx.slide.createMany({
            data: m.slides.map((s) => ({
              deckId: m.id,
              idx: s.index,
              slideId: s.id,
              label: s.label ?? null,
              filePath: s.file,
              thumbPath: s.thumbnail ?? null,
              notes: s.notes ?? null,
            })),
          });
        });

        if (
          previousStorageRoot &&
          previousStorageRoot !== ingestResult.storageRelative
        ) {
          await deleteDeckStorage(config.storageRoot, previousStorageRoot).catch(
            () => {},
          );
        }
        if (ingestResult.backupRelative) {
          await deleteDeckStorage(
            config.storageRoot,
            ingestResult.backupRelative,
          ).catch(() => {});
        }

        reply.code(201).send({
          id: m.id,
          manifest: m,
          storageRoot: ingestResult.storageRelative,
        });
      } catch (err) {
        if (result?.backupRelative) {
          await restoreDeckStorage(
            config.storageRoot,
            result.backupRelative,
            result.storageRelative,
          ).catch(() => {});
        } else if (result) {
          await deleteDeckStorage(config.storageRoot, result.storageRelative).catch(
            () => {},
          );
        }
        throw err;
      }
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
    }
  });

  /* --------------------------- GET /api/decks ---------------------------- */

  app.get('/api/decks', async (req) => {
    const userId = await getUserId(req, config);
    const rows = await prisma.deck.findMany({
      where: { ownerId: userId },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        title: true,
        subtitle: true,
        author: true,
        totalSlides: true,
        width: true,
        height: true,
        sizeBytes: true,
        uploadedAt: true,
        updatedAt: true,
        manifest: true,
        slides: {
          orderBy: { idx: 'asc' },
          take: 1,
          select: { thumbPath: true },
        },
      },
    });
    return {
      decks: rows.map(({ slides, manifest, ...deck }) => {
        // Surface a compact `offline` summary on the list endpoint so the
        // library UI can render a badge without paying the cost of shipping
        // the whole manifest. Falls back to `null` for legacy decks that
        // were uploaded before the mirror feature shipped.
        let offline: {
          ready: boolean;
          mirroredAt: string;
          mirroredAssets: number;
          skippedUrls: number;
        } | null = null;
        try {
          const parsed = JSON.parse(manifest) as Manifest;
          if (parsed.offline) {
            offline = {
              ready: parsed.offline.ready,
              mirroredAt: parsed.offline.mirroredAt,
              mirroredAssets: parsed.offline.mirroredAssets.length,
              skippedUrls: parsed.offline.skippedUrls.length,
            };
          }
        } catch {
          // ignore manifest parse error — falls back to offline=null.
        }
        return {
          ...deck,
          coverThumbnail: slides[0]?.thumbPath ?? null,
          storageToken: signStorageToken(deck.id, userId, config.storageToken),
          offline,
        };
      }),
    };
  });

  /* ------------------------- GET /api/decks/:id -------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/decks/:id',
    async (req, reply) => {
      const userId = await getUserId(req, config);
      const deck = await prisma.deck.findUnique({ where: { id: req.params.id } });
      if (!deck || deck.ownerId !== userId) {
        reply.code(404);
        return { error: 'deck not found' };
      }
      const manifest = JSON.parse(deck.manifest) as Manifest;
      return {
        id: deck.id,
        title: deck.title,
        subtitle: deck.subtitle,
        author: deck.author,
        totalSlides: deck.totalSlides,
        width: deck.width,
        height: deck.height,
        sizeBytes: deck.sizeBytes,
        coverThumbnail: manifest.slides[0]?.thumbnail ?? null,
        uploadedAt: deck.uploadedAt,
        updatedAt: deck.updatedAt,
        manifest,
        storageRoot: deck.storageRoot,
        storageToken: signStorageToken(deck.id, userId, config.storageToken),
      };
    },
  );

  /* -------------------- GET /api/decks/:id/manifest --------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/decks/:id/manifest',
    async (req, reply) => {
      const userId = await getUserId(req, config);
      const deck = await prisma.deck.findUnique({ where: { id: req.params.id } });
      if (!deck || deck.ownerId !== userId) {
        reply.code(404);
        return { error: 'deck not found' };
      }
      reply.header('Content-Type', 'application/json; charset=utf-8');
      return JSON.parse(deck.manifest);
    },
  );

  /* ------------------------ DELETE /api/decks/:id ----------------------- */

  app.delete<{ Params: { id: string } }>(
    '/api/decks/:id',
    async (req, reply) => {
      const userId = await getUserId(req, config);
      const deck = await prisma.deck.findUnique({ where: { id: req.params.id } });
      if (!deck || deck.ownerId !== userId) {
        reply.code(404);
        return { error: 'deck not found' };
      }
      await prisma.deck.delete({ where: { id: req.params.id } });
      await deleteDeckStorage(config.storageRoot, deck.storageRoot).catch(
        () => {},
      );
      reply.code(204).send();
    },
  );
}
