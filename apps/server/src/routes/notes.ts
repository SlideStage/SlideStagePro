/**
 * Speaker-notes editing route — Stage A.5 extension.
 *
 *   PATCH /api/decks/:id/notes  body: NotesPatchBody (see @slidestage/shared)
 *
 * Per spec §9.1, `manifest.slides[].notes` is the canonical source. Edits flow
 * through this endpoint and atomically update **four** places:
 *
 *   1. `Slide.notes` rows (one per slide)
 *   2. `Deck.manifest` JSON (full manifest mirror in DB)
 *   3. `<storageRoot>/<deckId>/manifest.json` on disk
 *   4. `<storageRoot>/<deckId>/speaker-notes.json` on disk (redundant copy)
 *
 * Disk writes use a temp-file + rename so a crash mid-write never leaves the
 * manifest half-written. DB writes happen only after disk is consistent.
 */
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  ERROR_CODES,
  SlideStageError,
  NOTES_AUDIT_DEFAULT_LIMIT,
  NOTES_AUDIT_MAX_LIMIT,
  notesPatchBodySchema,
  type Manifest,
  type NotesAuditResponse,
  type NotesPatchResponse,
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

export async function registerNotesRoute(
  app: FastifyInstance,
  { config }: RouteDeps,
): Promise<void> {
  const prisma = getPrisma();

  app.patch<{ Params: { id: string } }>(
    '/api/decks/:id/notes',
    async (req, reply): Promise<NotesPatchResponse> => {
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

      const body = notesPatchBodySchema.parse(req.body);
      const manifest = JSON.parse(deck.manifest) as Manifest;

      let updatedCount = 0;
      const total = manifest.slides.length;
      const noteEntries = Object.entries(body.notes);
      if (noteEntries.length > total) {
        throw new SlideStageError(
          ERROR_CODES.ETOOLARGE,
          `notes patch has ${noteEntries.length} entries; deck has ${total} slides`,
          413,
        );
      }
      // Collect (slideIdx, previousNotes, newNotes) tuples for the audit log.
      // Only slides whose value actually changed are recorded, mirroring the
      // semantics of `updatedCount`.
      const auditDiffs: Array<{
        slideIdx: number;
        previousNotes: string | null;
        newNotes: string | null;
      }> = [];
      for (const [key, value] of noteEntries) {
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
        // Treat empty string as cleared notes (null) so the manifest stays
        // shaped like the producer's output.
        const normalized =
          value === null || value === undefined || value === ''
            ? null
            : value;
        if (slot.notes !== normalized) {
          auditDiffs.push({
            slideIdx: idx,
            previousNotes: slot.notes ?? null,
            newNotes: normalized,
          });
          slot.notes = normalized;
          updatedCount += 1;
        }
      }

      const nowIso = new Date().toISOString();
      manifest.updatedAt = nowIso;

      const storageDir = path.join(config.storageRoot, deck.storageRoot);
      const manifestPath = path.join(storageDir, 'manifest.json');
      const notesPath = path.join(storageDir, 'speaker-notes.json');

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
      const notesArray = manifest.slides.map((s) => s.notes ?? '');
      const notesJson = JSON.stringify(notesArray, null, 2);

      let originalManifestText: string | null = null;
      let originalNotesText: string | null = null;
      try {
        originalManifestText = await fs.readFile(manifestPath, 'utf8');
      } catch {
        originalManifestText = null;
      }
      try {
        originalNotesText = await fs.readFile(notesPath, 'utf8');
      } catch {
        originalNotesText = null;
      }

      await atomicWriteFile(manifestPath, manifestJson);
      try {
        await atomicWriteFile(notesPath, notesJson);
      } catch (err) {
        if (originalManifestText !== null) {
          await atomicWriteFile(manifestPath, originalManifestText).catch(
            () => {},
          );
        }
        throw err;
      }

      try {
        await prisma.$transaction(async (tx) => {
          await tx.deck.update({
            where: { id: deck.id },
            data: { manifest: JSON.stringify(manifest) },
          });
          for (const slide of manifest.slides) {
            await tx.slide.update({
              where: { deckId_idx: { deckId: deck.id, idx: slide.index } },
              data: { notes: slide.notes ?? null },
            });
          }
          if (auditDiffs.length > 0) {
            await tx.noteEdit.createMany({
              data: auditDiffs.map((d) => ({
                deckId: deck.id,
                userId,
                slideIdx: d.slideIdx,
                previousNotes: d.previousNotes,
                newNotes: d.newNotes,
              })),
            });
          }
        });
      } catch (err) {
        if (originalManifestText !== null) {
          await atomicWriteFile(manifestPath, originalManifestText).catch(
            () => {},
          );
        }
        if (originalNotesText !== null) {
          await atomicWriteFile(notesPath, originalNotesText).catch(() => {});
        } else {
          await fs.rm(notesPath, { force: true }).catch(() => {});
        }
        throw err;
      }

      return {
        ok: true,
        updated: updatedCount,
        manifestUpdatedAt: nowIso,
      };
      } finally {
        releaseDeckLock();
      }
    },
  );

  // Audit log — owner-only. Cursor-paginated; newest first.
  //
  //   GET /api/decks/:id/notes/audit?cursor=<lastId>&limit=<n>
  //
  // Cursor is the `id` of the last entry from the previous page (the table
  // is autoincrement, so this gives a strict monotonic boundary).
  // `limit` is clamped to [1, NOTES_AUDIT_MAX_LIMIT].
  const auditQuerySchema = z.object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(NOTES_AUDIT_MAX_LIMIT)
      .optional(),
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/api/decks/:id/notes/audit',
    async (req, reply): Promise<NotesAuditResponse> => {
      const userId = await getUserId(req, config);
      const { id } = paramsSchema.parse(req.params);
      const { cursor, limit } = auditQuerySchema.parse(req.query);
      const pageSize = limit ?? NOTES_AUDIT_DEFAULT_LIMIT;

      const deck = await prisma.deck.findUnique({ where: { id } });
      if (!deck || deck.ownerId !== userId) {
        reply.code(404);
        throw new SlideStageError(
          ERROR_CODES.EMISSINGFILE,
          `deck not found: ${id}`,
          404,
        );
      }

      // Take +1 to know cheaply whether more pages exist.
      const rows = await prisma.noteEdit.findMany({
        where: {
          deckId: deck.id,
          ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: pageSize + 1,
      });

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const lastRow = page[page.length - 1];
      const nextCursor = hasMore && lastRow ? lastRow.id : null;

      return {
        entries: page.map((r) => ({
          id: r.id,
          deckId: r.deckId,
          userId: r.userId,
          slideIdx: r.slideIdx,
          previousNotes: r.previousNotes,
          newNotes: r.newNotes,
          editedAt: r.editedAt.toISOString(),
        })),
        nextCursor,
      };
    },
  );
}
