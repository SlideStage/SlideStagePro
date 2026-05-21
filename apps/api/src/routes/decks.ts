import { Hono } from "hono";
import { z } from "zod";
import type { Repositories } from "../db/repositories/index.js";
import type { StorageDriver } from "../storage/types.js";
import { LocalStorageDriver } from "../storage/local.js";
import {
  DeckPipelineError,
  runDeckPipeline,
} from "../deck-pipeline.js";
import { ApiError } from "../middleware/error.js";
import type { AuthVars } from "../middleware/auth.js";
import type {
  DeckDetail,
  DeckCreatedResponse,
  DeckSummary,
  PageEnvelope,
  Visibility,
} from "../types/contract.js";

export interface DeckRoutesDeps {
  repos: Repositories;
  storage: StorageDriver;
  uploadMaxBytes: number;
}

function objectKey(deckId: string, versionId: string): string {
  return `decks/${deckId}/${versionId}.stage`;
}

function sanitizeTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
  return cleaned || "deck";
}

function toSummary(deck: {
  id: string;
  title: string;
  fingerprint: string;
  currentVersionId: string | null;
  visibility: string;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  _slideCount?: number;
}): DeckSummary {
  return {
    id: deck.id,
    title: deck.title,
    fingerprint: deck.fingerprint,
    currentVersionId: deck.currentVersionId ?? null,
    visibility: (deck.visibility as Visibility) ?? "private",
    ownerId: deck.ownerId,
    createdAt: deck.createdAt.toISOString(),
    updatedAt: deck.updatedAt.toISOString(),
    slideCount: deck._slideCount ?? 0,
  };
}

const listQuerySchema = z.object({
  limit: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? Number.parseInt(v, 10) : v))
    .pipe(z.number().int().min(1).max(100))
    .default(20),
  cursor: z.string().min(1).optional(),
});

export function createDeckRoutes(deps: DeckRoutesDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  // GET /api/decks — list owned (or all, for admin)
  app.get("/", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const parsed = listQuerySchema.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_QUERY", "Invalid pagination", parsed.error.flatten());
    }
    const { items, nextCursor } = await deps.repos.deck.list({
      ownerId: isAdmin ? null : user.id,
      ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
      limit: parsed.data.limit,
    });
    const envelope: PageEnvelope<DeckSummary> = {
      items: items.map((d) =>
        toSummary({
          ...d,
          _slideCount: d._slideCount,
        }),
      ),
      nextCursor,
    };
    return c.json(envelope, 200);
  });

  // POST /api/decks — upload
  app.post("/", async (c) => {
    const user = c.get("user")!;
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Expected multipart/form-data",
      );
    }
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "FILE_REQUIRED", "Form field `file` is required");
    }
    const titleOverride =
      typeof form.get("title") === "string"
        ? (form.get("title") as string).trim()
        : "";

    if (file.size > deps.uploadMaxBytes) {
      throw new ApiError(
        400,
        "UPLOAD_TOO_LARGE",
        `Upload exceeds ${deps.uploadMaxBytes} bytes`,
        { sizeBytes: file.size, maxBytes: deps.uploadMaxBytes },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let pipeline;
    try {
      pipeline = runDeckPipeline({ bytes: buffer, maxBytes: deps.uploadMaxBytes });
    } catch (err) {
      if (err instanceof DeckPipelineError) {
        throw new ApiError(400, err.code, err.message, err.details);
      }
      throw err;
    }

    const title = titleOverride || pipeline.manifest.title;
    // 7. Persist Deck + DeckVersion via repository (single transaction).
    //    We do this before storage write so we have stable IDs to namespace
    //    the storage key. If storage write fails we'll roll back the rows.
    const { deck, version } = await deps.repos.deck.createWithVersion({
      ownerId: user.id,
      title,
      fingerprint: pipeline.fingerprint,
      visibility: "private",
      version: {
        // Placeholder objectKey written below — we update after writing bytes.
        objectKey: "PENDING",
        manifestJson: JSON.stringify(pipeline.manifest),
        sizeBytes: pipeline.sizeBytes,
        sha256: pipeline.sha256,
      },
    });

    const key = objectKey(deck.id, version.id);
    try {
      await deps.storage.putObject(key, buffer);
    } catch (err) {
      // Best-effort rollback — drop the deck (cascades versions).
      await deps.repos.deck.deleteById(deck.id).catch(() => {});
      throw new ApiError(
        500,
        "STORAGE_WRITE_FAILED",
        "Failed to persist deck bytes",
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }

    // We needed the version id to build the storage key, so we update it
    // post-creation. Race-safe because the row is private to this request.
    await deps.repos.version.setObjectKey(version.id, key);

    const response: DeckCreatedResponse = {
      id: deck.id,
      title: deck.title,
      fingerprint: deck.fingerprint,
      currentVersionId: version.id,
      createdAt: deck.createdAt.toISOString(),
      manifestSummary: {
        slideCount: pipeline.manifest.slides.length,
        title: pipeline.manifest.title,
        createdAt: pipeline.manifest.createdAt,
        schema: pipeline.manifest.schema,
      },
    };
    return c.json(response, 201);
  });

  // GET /api/decks/:id
  app.get("/:id", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const id = c.req.param("id");
    const deck = await deps.repos.deck.findByIdForOwnerOrAdmin(id, user.id, isAdmin);
    if (!deck) {
      throw new ApiError(404, "NOT_FOUND", "Deck not found");
    }
    const versionRow = deck.versions[0] ?? null;
    let manifest: unknown = null;
    if (versionRow) {
      try {
        manifest = JSON.parse(versionRow.manifestJson);
      } catch {
        manifest = null;
      }
    }
    const slideCount =
      manifest && typeof manifest === "object" && manifest !== null && "slides" in manifest
        ? Array.isArray((manifest as { slides?: unknown[] }).slides)
          ? (manifest as { slides: unknown[] }).slides.length
          : 0
        : 0;

    const body: DeckDetail = {
      id: deck.id,
      title: deck.title,
      fingerprint: deck.fingerprint,
      currentVersionId: deck.currentVersionId ?? null,
      visibility: (deck.visibility as Visibility) ?? "private",
      ownerId: deck.ownerId,
      createdAt: deck.createdAt.toISOString(),
      updatedAt: deck.updatedAt.toISOString(),
      slideCount,
      currentVersion: versionRow
        ? {
            id: versionRow.id,
            sizeBytes: versionRow.sizeBytes,
            sha256: versionRow.sha256,
            createdAt: versionRow.createdAt.toISOString(),
          }
        : null,
      manifest,
    };
    return c.json(body, 200);
  });

  // GET /api/decks/:id/blob — stream the raw .stage bytes
  app.get("/:id/blob", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const id = c.req.param("id");
    const deck = await deps.repos.deck.findByIdForOwnerOrAdmin(id, user.id, isAdmin);
    if (!deck) throw new ApiError(404, "NOT_FOUND", "Deck not found");
    const version = deck.versions[0];
    if (!version) throw new ApiError(404, "NO_VERSION", "Deck has no version");

    const etag = `"${version.sha256}"`;
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return c.body(null, 304, { ETag: etag });
    }

    if (!(await deps.storage.exists(version.objectKey))) {
      throw new ApiError(404, "BLOB_MISSING", "Deck blob is missing from storage");
    }
    const stream = await deps.storage.getObject(version.objectKey);
    const filename = `${sanitizeTitle(deck.title)}.stage`;
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(version.sizeBytes),
      ETag: etag,
      "Cache-Control": "private, max-age=300",
    };
    if (Buffer.isBuffer(stream)) {
      // Hand off the raw bytes via a Response — c.body's Buffer overload is
      // typed against Uint8Array<ArrayBuffer> which doesn't accept Node's
      // Buffer<ArrayBufferLike> in newer @types/node.
      return new Response(
        new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength),
        { status: 200, headers },
      );
    }
    return new Response(stream, { status: 200, headers });
  });

  // DELETE /api/decks/:id
  app.delete("/:id", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const id = c.req.param("id");
    const deck = await deps.repos.deck.findById(id);
    if (!deck) throw new ApiError(404, "NOT_FOUND", "Deck not found");
    if (!isAdmin && deck.ownerId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "Cannot delete this deck");
    }
    const versionRows = await deps.repos.deck.listVersionKeys(id);
    await deps.repos.deck.deleteById(id);
    // Best-effort storage cleanup. We don't fail the request if it errs.
    if (deps.storage instanceof LocalStorageDriver) {
      await deps.storage.deletePrefix(`decks/${id}`).catch(() => {});
    } else {
      await Promise.all(
        versionRows.map((v) =>
          deps.storage.deleteObject(v.objectKey).catch(() => {}),
        ),
      );
    }
    return c.body(null, 204);
  });

  return app;
}
