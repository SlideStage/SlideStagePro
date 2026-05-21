import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { parseManifest } from "@slidestage/core/deck/manifestSchema";
import { normalizePackagePath } from "@slidestage/core/deck/pathSafety";
import type { Manifest } from "@slidestage/core/deck/types";

export type DeckPipelineErrorCode =
  | "UPLOAD_TOO_LARGE"
  | "INVALID_STAGE_ZIP"
  | "INVALID_MANIFEST"
  | "UNSAFE_PATH";

export class DeckPipelineError extends Error {
  override readonly name = "DeckPipelineError";
  readonly code: DeckPipelineErrorCode;
  readonly details: unknown;
  constructor(code: DeckPipelineErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface DeckPipelineInput {
  bytes: Buffer;
  maxBytes: number;
}

export interface DeckPipelineResult {
  manifest: Manifest;
  sha256: string;
  /** `"sha256-<hex>"` — the deck-version fingerprint used as the API identifier. */
  fingerprint: string;
  sizeBytes: number;
  slideCount: number;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Run the upload pipeline described in `docs/API_CONTRACT.md` §3 (POST /api/decks).
 * Order is strictly preserved; the first failing step throws `DeckPipelineError`
 * and downstream steps are not attempted.
 */
export function runDeckPipeline(input: DeckPipelineInput): DeckPipelineResult {
  const { bytes, maxBytes } = input;

  // 1. Reject if file > UPLOAD_MAX_BYTES.
  if (bytes.byteLength > maxBytes) {
    throw new DeckPipelineError(
      "UPLOAD_TOO_LARGE",
      `Upload exceeds the configured limit of ${maxBytes} bytes`,
      { sizeBytes: bytes.byteLength, maxBytes },
    );
  }

  // 2. Hash the upload buffer → sha256.
  const sha256 = sha256Hex(bytes);
  const fingerprint = `sha256-${sha256}`;

  // 3. Load the zip (via fflate, the same parser @slidestage/core uses).
  //    Wrap in try/catch to map fflate's generic error to the contract code.
  let rawEntries: Record<string, Uint8Array>;
  try {
    rawEntries = unzipSync(new Uint8Array(bytes));
  } catch (err) {
    throw new DeckPipelineError(
      "INVALID_STAGE_ZIP",
      "Upload is not a readable .stage ZIP",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  // 5. (interleaved here for early failure) Validate every internal path with
  //    pathSafety.normalizePackagePath — this throws on traversal / NUL /
  //    absolute paths. We normalize the keys as we filter directory entries.
  const entries = new Map<string, Uint8Array>();
  for (const [rawPath, value] of Object.entries(rawEntries)) {
    if (rawPath.endsWith("/")) continue; // directory marker
    let normalized: string;
    try {
      normalized = normalizePackagePath(rawPath);
    } catch (err) {
      throw new DeckPipelineError(
        "UNSAFE_PATH",
        `Zip entry has an unsafe path: ${rawPath}`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    entries.set(normalized, value);
  }

  // 4. Read & validate manifest.json with manifestSchema.parseManifest.
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) {
    throw new DeckPipelineError(
      "INVALID_STAGE_ZIP",
      "manifest.json is missing from the package root",
    );
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (err) {
    throw new DeckPipelineError(
      "INVALID_MANIFEST",
      "manifest.json is not valid UTF-8 JSON",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(manifestRaw);
  } catch (err) {
    throw new DeckPipelineError(
      "INVALID_MANIFEST",
      "manifest.json does not match slidestage@1.0",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  // 5b. Verify each slide file path is safe & present.
  for (const slide of manifest.slides) {
    let slidePath: string;
    try {
      slidePath = normalizePackagePath(slide.file);
    } catch (err) {
      throw new DeckPipelineError(
        "UNSAFE_PATH",
        `Manifest references an unsafe slide path: ${slide.file}`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    if (!entries.has(slidePath)) {
      throw new DeckPipelineError(
        "INVALID_MANIFEST",
        `Manifest references missing slide: ${slide.file}`,
      );
    }
    if (slide.thumbnail) {
      try {
        normalizePackagePath(slide.thumbnail);
      } catch (err) {
        throw new DeckPipelineError(
          "UNSAFE_PATH",
          `Manifest references an unsafe thumbnail path: ${slide.thumbnail}`,
          { cause: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }

  // 6. Fingerprint = sha256 of the bytes (deterministic).
  //    Already computed above; nothing to do.

  return {
    manifest,
    sha256,
    fingerprint,
    sizeBytes: bytes.byteLength,
    slideCount: manifest.slides.length,
  };
}
