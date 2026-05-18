/**
 * The end-to-end ingest pipeline (spec §5.1):
 *
 *   Upload → Validate → Unpack → Index → CDN-mount
 *
 * Pure functions; the HTTP layer (routes/decks.ts) handles request decoding
 * and persistence transactions.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Manifest } from '@slidestage/shared';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import { safeExtract } from './extract.js';
import { readAndValidateManifest } from './validate.js';

export interface IngestOptions {
  storageRoot: string;
  /**
   * Optional storage namespace under storageRoot. New uploads use the owner's
   * user id here so two users cannot clobber each other's deck files even when
   * they upload packages with the same manifest.id.
   */
  storagePrefix?: string;
  maxDecompressedBytes: number;
  maxFileBytes: number;
  maxSlides: number;
  /** Runs after manifest validation but before any final storage promotion. */
  beforePromote?: (manifest: Manifest) => Promise<void>;
}

export interface IngestResult {
  manifest: Manifest;
  storageRelative: string;
  storageAbsolute: string;
  backupRelative: string | null;
  backupAbsolute: string | null;
  totalBytes: number;
  fileCount: number;
  replacedExisting: boolean;
}

function safeStorageRelative(prefix: string | undefined, deckId: string): string {
  if (!prefix) return deckId;
  if (prefix.includes('\0') || prefix.includes('\\')) {
    throw new SlideStageError(
      ERROR_CODES.EINTERNAL,
      `Invalid storage prefix: ${prefix}`,
      500,
    );
  }
  const normalized = path.posix.normalize(prefix);
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized.startsWith('..') ||
    normalized.includes('/../')
  ) {
    throw new SlideStageError(
      ERROR_CODES.EINTERNAL,
      `Invalid storage prefix: ${prefix}`,
      500,
    );
  }
  return path.posix.join(normalized, deckId);
}

/**
 * Stages the upload into a temp dir, validates, then atomically promotes it
 * to `<storageRoot>/<deckId>`. Failures clean up the temp dir without
 * touching the previous deck (if any).
 */
export async function ingestArchive(
  archivePath: string,
  opts: IngestOptions,
): Promise<IngestResult> {
  const stagingDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'slidestage-ingest-'),
  );

  try {
    const stat = await fs.stat(archivePath);
    const stats = await safeExtract(archivePath, stagingDir, {
      maxDecompressedBytes: opts.maxDecompressedBytes,
      maxFileBytes: opts.maxFileBytes,
    });

    const manifest = await readAndValidateManifest(stagingDir, {
      maxSlides: opts.maxSlides,
    });
    await opts.beforePromote?.(manifest);

    const finalRel = safeStorageRelative(opts.storagePrefix, manifest.id);
    const finalAbs = path.join(opts.storageRoot, ...finalRel.split('/'));

    await fs.mkdir(path.dirname(finalAbs), { recursive: true });

    // Promote the staging dir atomically. If a previous version exists we
    // shuffle it aside to a backup name. The HTTP layer removes that backup
    // only after the DB transaction commits, or restores it if DB persistence
    // fails.
    const backupRel = `${finalRel}.replaced-${crypto.randomUUID()}`;
    const backupAbs = path.join(opts.storageRoot, ...backupRel.split('/'));
    let hadPrior = false;
    try {
      await fs.access(finalAbs);
      hadPrior = true;
    } catch {
      // pristine path, no prior deck
    }

    if (hadPrior) {
      await fs.rename(finalAbs, backupAbs);
    }
    try {
      await fs.rename(stagingDir, finalAbs);
    } catch (e) {
      if (hadPrior) {
        // best-effort restore
        try {
          await fs.rename(backupAbs, finalAbs);
        } catch {
          /* swallow */
        }
      }
      throw new SlideStageError(
        ERROR_CODES.EINTERNAL,
        `Failed to promote deck to storage: ${(e as Error).message}`,
        500,
      );
    }
    return {
      manifest,
      storageRelative: finalRel,
      storageAbsolute: finalAbs,
      backupRelative: hadPrior ? backupRel : null,
      backupAbsolute: hadPrior ? backupAbs : null,
      totalBytes: stats.totalBytes || stat.size,
      fileCount: stats.fileCount,
      replacedExisting: hadPrior,
    };
  } catch (err) {
    // Best-effort cleanup of the staging dir on any failure.
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function deleteDeckStorage(
  storageRoot: string,
  storageRelative: string,
): Promise<void> {
  const target = path.join(storageRoot, storageRelative);
  // Defensive: make sure we can't be tricked into rm'ing outside the root.
  const rootAbs = path.resolve(storageRoot);
  const targetAbs = path.resolve(target);
  if (!targetAbs.startsWith(rootAbs + path.sep) && targetAbs !== rootAbs) {
    throw new SlideStageError(
      ERROR_CODES.EINTERNAL,
      `Refusing to delete outside storage root: ${storageRelative}`,
      500,
    );
  }
  await fs.rm(targetAbs, { recursive: true, force: true });
}

export async function restoreDeckStorage(
  storageRoot: string,
  backupRelative: string,
  storageRelative: string,
): Promise<void> {
  const rootAbs = path.resolve(storageRoot);
  const backupAbs = path.resolve(path.join(storageRoot, backupRelative));
  const targetAbs = path.resolve(path.join(storageRoot, storageRelative));
  for (const candidate of [backupAbs, targetAbs]) {
    if (!candidate.startsWith(rootAbs + path.sep)) {
      throw new SlideStageError(
        ERROR_CODES.EINTERNAL,
        `Refusing to move storage outside root: ${storageRelative}`,
        500,
      );
    }
  }
  await fs.rm(targetAbs, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetAbs), { recursive: true });
  await fs.rename(backupAbs, targetAbs);
}
