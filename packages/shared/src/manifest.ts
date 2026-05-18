/**
 * .stage manifest.json schema (v1.0)
 *
 * Mirrors slidestage-platform-spec.md §3 verbatim. The platform validates
 * uploaded packages against the Zod schemas exported here; the inferred
 * TypeScript types are reused on both server and web.
 */

import { z } from 'zod';

/* ----------------------------------------------------------------------- */
/*  Constants                                                               */
/* ----------------------------------------------------------------------- */

export const SUPPORTED_SCHEMA_VERSIONS = ['slidestage@1.0'] as const;
export const PLATFORM_SCHEMA_VERSION = '1.0';
export const PLATFORM_PACKER_NAME = 'slidestage-platform';
export const MAX_MANIFEST_TITLE_LENGTH = 200;
export const MAX_MANIFEST_SUBTITLE_LENGTH = 300;
export const MAX_MANIFEST_AUTHOR_LENGTH = 200;
export const MAX_MANIFEST_DESCRIPTION_LENGTH = 4_000;
export const MAX_SLIDE_LABEL_LENGTH = 200;
export const MAX_SLIDE_NOTES_LENGTH = 20_000;
export const MAX_MANIFEST_PATH_LENGTH = 512;
export const MAX_MANIFEST_ASSET_FILES = 2_000;
export const MAX_MANIFEST_FONTS = 200;
export const MAX_MANIFEST_FONT_FILES = 20;
export const MAX_MANIFEST_TOKEN_KEYS = 500;
export const MAX_MANIFEST_JSON_BYTES = 1_000_000;

export const ARCHITECTURE_KINDS = [
  'multi-file',
  'multi-file-flat',
  'single-file-deckstage',
  'single-file-html',
] as const;

export const CAPABILITIES = [
  'keyboard-nav',
  'thumbnail-preview',
  'speaker-notes',
  'annotation-overlay',
  'auto-advance',
  'transitions',
] as const;

export const TRUST_CAPABILITIES = [
  'same-origin-storage',
  'broadcast-channel',
  'window-open',
] as const;

export const ASSET_TYPES = [
  'image',
  'font',
  'style',
  'script',
  'audio',
  'video',
  'other',
] as const;

/** spec §3.1: id must be slug-style, allow CJK and -_, max 64 chars */
export const ID_REGEX = /^[a-z0-9\-_\u4e00-\u9fff]{1,64}$/i;
const TRUST_CAPABILITY_SET = new Set<string>(TRUST_CAPABILITIES);

export function isSafeManifestPath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  return value.split('/').every((segment) => {
    return segment.length > 0 && segment !== '.' && segment !== '..';
  });
}

export const manifestPathSchema = z
  .string()
  .min(1)
  .max(MAX_MANIFEST_PATH_LENGTH)
  .refine(isSafeManifestPath, 'must be a relative package path without traversal');

/* ----------------------------------------------------------------------- */
/*  Sub-schemas                                                             */
/* ----------------------------------------------------------------------- */

export const slideSchema = z
  .object({
    index: z.number().int().min(1),
    id: z.string().min(1).max(128),
    label: z.string().max(MAX_SLIDE_LABEL_LENGTH),
    file: manifestPathSchema,
    thumbnail: manifestPathSchema.nullable().optional().default(null),
    notes: z.string().max(MAX_SLIDE_NOTES_LENGTH).nullable().optional().default(null),
    duration: z.number().positive().optional(),
    transition: z.string().optional(),
  })
  .strict();

export const fontSchema = z
  .object({
    family: z.string(),
    weights: z.array(z.number().int()).default([]),
    source: z.enum(['google', 'self-hosted', 'system']),
    url: z.string().url().optional(),
    files: z.array(manifestPathSchema).max(MAX_MANIFEST_FONT_FILES).optional(),
  })
  .strict();

export const assetFileSchema = z
  .object({
    path: manifestPathSchema,
    size: z.number().int().nonnegative(),
    type: z.enum(ASSET_TYPES),
  })
  .strict();

export const assetIndexSchema = z
  .object({
    totalSize: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    files: z.array(assetFileSchema).max(MAX_MANIFEST_ASSET_FILES),
  })
  .strict();

export const runtimeHintsSchema = z
  .object({
    presenterTools: z.enum(['platform', 'local', 'none']),
    fallbackEntry: z.string().nullable(),
    capabilities: z.array(z.enum(CAPABILITIES)).default([]),
  })
  .strict();

export const platformContractSchema = z
  .object({
    minSchemaVersion: z.string(),
    compatibleArchitectures: z.array(z.enum(ARCHITECTURE_KINDS)),
  })
  .strict();

export function normalizeTrustCapabilities(
  values: readonly string[] = [],
): TrustCapability[] {
  return Array.from(
    new Set(values.filter((value): value is TrustCapability => TRUST_CAPABILITY_SET.has(value))),
  ).sort();
}

export const compatSchema = z
  .object({
    requires: z
      .array(z.string())
      .optional()
      .default([])
      .transform((values) => normalizeTrustCapabilities(values)),
    notes: z.string().max(1024).optional(),
  })
  .passthrough();

export const provenanceSchema = z
  .object({
    sourceKind: z.string().min(1).max(128).optional(),
    conversionMode: z.string().min(1).max(64).optional(),
    sourceEntry: z.string().min(1).max(MAX_MANIFEST_PATH_LENGTH).optional(),
    converter: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(64).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Spec §3.11: optional record of the offline-mirror pass.
 *
 * Servers and players treat this as informational metadata: when present,
 * `offline.ready === true` means slide HTML / CSS have been statically
 * rewritten to point at `assets/_mirror/...` paths and the runtime should
 * not issue any external network request for the mirrored resources.
 * `ready === false` is legal and means the pass ran but had partial
 * coverage — the runtime falls back to its normal external-resource
 * handling.
 */
export const OFFLINE_SKIPPED_REASONS = [
  'unreachable',
  'blocked-by-policy',
  'too-large',
  'unsupported-scheme',
  'budget-exhausted',
  'manual-skip',
] as const;

export const offlinePolicySchema = z
  .object({
    includeScripts: z.boolean(),
    includeIframes: z.boolean(),
    maxAssetBytes: z.number().int().nonnegative(),
    maxTotalBytes: z.number().int().nonnegative(),
    allowedHosts: z.array(z.string().min(1)).optional(),
    blockedHosts: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export const offlineMirroredAssetSchema = z
  .object({
    originalUrl: z.string().min(1),
    path: manifestPathSchema,
    contentHash: z.string().min(1).max(128),
    contentType: z.string().min(1).max(256),
    bytes: z.number().int().nonnegative(),
    fetchedAt: z.string().min(1),
    referencedBy: z.array(z.number().int().nonnegative()).default([]),
  })
  .passthrough();

export const offlineSkippedUrlSchema = z
  .object({
    url: z.string().min(1),
    reason: z.enum(OFFLINE_SKIPPED_REASONS),
    detail: z.string().max(1024).optional(),
  })
  .passthrough();

export const offlineSchema = z
  .object({
    ready: z.boolean(),
    mirroredAt: z.string().min(1),
    mirrorTool: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(64).optional(),
      })
      .passthrough(),
    policy: offlinePolicySchema.optional(),
    mirroredAssets: z.array(offlineMirroredAssetSchema).default([]),
    skippedUrls: z.array(offlineSkippedUrlSchema).default([]),
  })
  .passthrough();

export const packStatsSchema = z
  .object({
    packedAt: z.string(),
    packerVersion: z.string(),
  })
  .strict();

/* ----------------------------------------------------------------------- */
/*  Top-level manifest                                                      */
/* ----------------------------------------------------------------------- */

export const manifestSchema = z
  .object({
    schema: z.enum(SUPPORTED_SCHEMA_VERSIONS),
    id: z.string().regex(ID_REGEX, 'invalid manifest.id'),
    version: z.string(),

    title: z.string().min(1).max(MAX_MANIFEST_TITLE_LENGTH),
    subtitle: z.string().max(MAX_MANIFEST_SUBTITLE_LENGTH).nullable(),
    author: z.string().max(MAX_MANIFEST_AUTHOR_LENGTH).nullable(),
    description: z.string().max(MAX_MANIFEST_DESCRIPTION_LENGTH).nullable(),

    createdAt: z.string(),
    updatedAt: z.string(),

    architecture: z.enum(ARCHITECTURE_KINDS),
    dimensions: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    totalSlides: z.number().int().min(1),

    slides: z.array(slideSchema).min(1),

    fonts: z.array(fontSchema).max(MAX_MANIFEST_FONTS).default([]),
    tokens: z.record(z.string(), z.unknown()).default({}),

    assets: assetIndexSchema,

    runtime: runtimeHintsSchema,
    platform: platformContractSchema,
    provenance: provenanceSchema.optional(),
    compat: compatSchema.optional(),
    offline: offlineSchema.optional(),
    stats: packStatsSchema,
  })
  // Allow unknown forward-compatible top-level fields (spec §12.3).
  .passthrough()
  .superRefine((m, ctx) => {
    if (m.slides.length !== m.totalSlides) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `totalSlides (${m.totalSlides}) does not match slides.length (${m.slides.length})`,
        path: ['totalSlides'],
      });
    }
    if (Object.keys(m.tokens).length > MAX_MANIFEST_TOKEN_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `tokens must contain at most ${MAX_MANIFEST_TOKEN_KEYS} keys`,
        path: ['tokens'],
      });
    }
    m.slides.forEach((s, i) => {
      if (s.index !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `slides[${i}].index must equal ${i + 1}, got ${s.index}`,
          path: ['slides', i, 'index'],
        });
      }
      if (s.file.includes('..') || s.file.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `slides[${i}].file must not contain ".." or absolute paths`,
          path: ['slides', i, 'file'],
        });
      }
      // Spec §3.2: slides should live under slides/ unless architecture
      // is "multi-file-flat" (root-level html files) or single-file-html.
      const flatLayout =
        m.architecture === 'multi-file-flat' ||
        m.architecture === 'single-file-html';
      if (!flatLayout && !s.file.startsWith('slides/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `slides[${i}].file must start with "slides/" for architecture=${m.architecture}`,
          path: ['slides', i, 'file'],
        });
      }
    });
    if (m.platform.minSchemaVersion) {
      const min = m.platform.minSchemaVersion;
      // We currently support up to v1.0; reject if the manifest demands higher.
      if (compareSemver(min, PLATFORM_SCHEMA_VERSION) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `manifest requires platform schema >= ${min}, but platform supports ${PLATFORM_SCHEMA_VERSION}`,
          path: ['platform', 'minSchemaVersion'],
        });
      }
    }
  });

/* ----------------------------------------------------------------------- */
/*  Helpers                                                                 */
/* ----------------------------------------------------------------------- */

/** Returns >0 if a > b, <0 if a < b, 0 otherwise. Handles "1.0" / "1.2.3". */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* ----------------------------------------------------------------------- */
/*  Inferred types                                                          */
/* ----------------------------------------------------------------------- */

export type ArchitectureKind = (typeof ARCHITECTURE_KINDS)[number];
export type Capability = (typeof CAPABILITIES)[number];
export type TrustCapability = (typeof TRUST_CAPABILITIES)[number];
export type AssetType = (typeof ASSET_TYPES)[number];
export type Slide = z.infer<typeof slideSchema>;
export type Font = z.infer<typeof fontSchema>;
export type AssetFile = z.infer<typeof assetFileSchema>;
export type AssetIndex = z.infer<typeof assetIndexSchema>;
export type RuntimeHints = z.infer<typeof runtimeHintsSchema>;
export type PlatformContract = z.infer<typeof platformContractSchema>;
export type ManifestCompat = z.infer<typeof compatSchema>;
export type ManifestProvenance = z.infer<typeof provenanceSchema>;
export type OfflinePolicy = z.infer<typeof offlinePolicySchema>;
export type OfflineMirroredAsset = z.infer<typeof offlineMirroredAssetSchema>;
export type OfflineSkippedUrl = z.infer<typeof offlineSkippedUrlSchema>;
export type OfflineSkippedReason = (typeof OFFLINE_SKIPPED_REASONS)[number];
export type ManifestOffline = z.infer<typeof offlineSchema>;
export type PackStats = z.infer<typeof packStatsSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
