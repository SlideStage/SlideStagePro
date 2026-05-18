/**
 * Validates an unpacked .stage directory against the spec:
 *  1. manifest.json present, parses, matches Zod schema (§3).
 *  2. Every slide.file actually exists on disk under the unpack root (§5.4).
 *  3. Thumbnails (when declared) exist on disk too.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  ERROR_CODES,
  SlideStageError,
  MAX_MANIFEST_JSON_BYTES,
  isSafeManifestPath,
  type Manifest,
  manifestSchema,
} from '@slidestage/shared';

function resolvePackagePath(
  unpackDir: string,
  relativePath: string,
  field: string,
): string {
  if (!isSafeManifestPath(relativePath)) {
    throw new SlideStageError(
      ERROR_CODES.EBADMANIFEST,
      `${field} must be a relative package path without traversal`,
    );
  }
  const rootAbs = path.resolve(unpackDir);
  const targetAbs = path.resolve(rootAbs, ...relativePath.split('/'));
  if (targetAbs !== rootAbs && !targetAbs.startsWith(rootAbs + path.sep)) {
    throw new SlideStageError(
      ERROR_CODES.EBADMANIFEST,
      `${field} resolves outside the package root`,
    );
  }
  return targetAbs;
}

export async function readAndValidateManifest(
  unpackDir: string,
  opts: { maxSlides: number },
): Promise<Manifest> {
  const manifestPath = path.join(unpackDir, 'manifest.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    throw new SlideStageError(
      ERROR_CODES.ENOMANIFEST,
      'manifest.json missing from package root',
    );
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_JSON_BYTES) {
    throw new SlideStageError(
      ERROR_CODES.ETOOLARGE,
      `manifest.json exceeds limit ${MAX_MANIFEST_JSON_BYTES}`,
      413,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SlideStageError(
      ERROR_CODES.EBADMANIFEST,
      `manifest.json is not valid JSON: ${(e as Error).message}`,
    );
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new SlideStageError(
      ERROR_CODES.EBADMANIFEST,
      `manifest.json failed schema validation: ${issues}`,
    );
  }
  const manifest = result.data;

  if (manifest.slides.length > opts.maxSlides) {
    throw new SlideStageError(
      ERROR_CODES.ETOOLARGE,
      `Deck has ${manifest.slides.length} slides; max allowed is ${opts.maxSlides}`,
      413,
    );
  }

  // All slide files must actually exist on disk.
  for (const s of manifest.slides) {
    const slideAbs = resolvePackagePath(
      unpackDir,
      s.file,
      `slides[${s.index - 1}].file`,
    );
    try {
      const stat = await fs.stat(slideAbs);
      if (!stat.isFile()) {
        throw new Error('not a regular file');
      }
    } catch (e) {
      throw new SlideStageError(
        ERROR_CODES.EMISSINGFILE,
        `slides[${s.index - 1}].file -> ${s.file} not found in package`,
      );
    }
    if (s.thumbnail) {
      const thumbAbs = resolvePackagePath(
        unpackDir,
        s.thumbnail,
        `slides[${s.index - 1}].thumbnail`,
      );
      try {
        const stat = await fs.stat(thumbAbs);
        if (!stat.isFile()) {
          s.thumbnail = null;
        }
      } catch {
        // Per spec §3.2, missing thumbnails are tolerable; null it instead of failing.
        s.thumbnail = null;
      }
    }
  }

  for (const asset of manifest.assets.files) {
    resolvePackagePath(unpackDir, asset.path, `assets.files[].path`);
  }
  for (const font of manifest.fonts) {
    for (const file of font.files ?? []) {
      resolvePackagePath(unpackDir, file, `fonts[].files[]`);
    }
  }

  // Spec §3.11: when `offline.mirroredAssets[]` is present, every recorded
  // path must already exist in the package. A missing entry means the
  // mirror metadata is lying about what's bundled — reject the deck so the
  // viewer never 404s on an "offline ready" reference.
  const mirroredAssets = manifest.offline?.mirroredAssets ?? [];
  for (let i = 0; i < mirroredAssets.length; i += 1) {
    const asset = mirroredAssets[i];
    if (!asset) continue;
    const targetAbs = resolvePackagePath(
      unpackDir,
      asset.path,
      `offline.mirroredAssets[${i}].path`,
    );
    try {
      const stat = await fs.stat(targetAbs);
      if (!stat.isFile()) {
        throw new Error('not a regular file');
      }
    } catch {
      throw new SlideStageError(
        ERROR_CODES.EMISSINGFILE,
        `offline.mirroredAssets[${i}].path -> ${asset.path} not found in package`,
      );
    }
  }

  return manifest;
}
