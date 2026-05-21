import { Hono } from "hono";
import { z } from "zod";
import type { Repositories } from "../db/repositories/index.js";
import { ApiError } from "../middleware/error.js";
import type { AuthVars } from "../middleware/auth.js";
import type { AnnotationRecord } from "../types/contract.js";

export interface AnnotationRoutesDeps {
  repos: Repositories;
  annotationMaxBytes: number;
}

const upsertSchema = z.object({
  payload: z.unknown(),
});

const slideIndexSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "string" ? Number.parseInt(v, 10) : v))
  .pipe(z.number().int().min(0));

function serializePayload(payload: unknown): string {
  // Reject non-serializable values up-front so storage stays clean.
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    throw new ApiError(
      400,
      "INVALID_PAYLOAD",
      "Annotation payload must be JSON-serializable",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (json === undefined) {
    throw new ApiError(400, "INVALID_PAYLOAD", "Annotation payload may not be undefined");
  }
  return json;
}

export function createAnnotationRoutes(
  deps: AnnotationRoutesDeps,
): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  async function loadDeckOrThrow(deckId: string, userId: string, isAdmin: boolean) {
    const deck = await deps.repos.deck.findById(deckId);
    if (!deck) throw new ApiError(404, "NOT_FOUND", "Deck not found");
    if (!isAdmin && deck.ownerId !== userId) {
      throw new ApiError(403, "FORBIDDEN", "Cannot access annotations for this deck");
    }
    return deck;
  }

  // PUT /api/decks/:id/annotations/:slideIndex
  app.put("/decks/:id/annotations/:slideIndex", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const deck = await loadDeckOrThrow(c.req.param("id"), user.id, isAdmin);
    const slideIndex = slideIndexSchema.safeParse(c.req.param("slideIndex"));
    if (!slideIndex.success) {
      throw new ApiError(400, "INVALID_SLIDE_INDEX", "Slide index must be a non-negative integer");
    }
    const body = await c.req.json().catch(() => null);
    const parsed = upsertSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_BODY", "Invalid annotation body", parsed.error.flatten());
    }
    const payloadJson = serializePayload(parsed.data.payload);
    const byteLength = Buffer.byteLength(payloadJson, "utf8");
    if (byteLength > deps.annotationMaxBytes) {
      throw new ApiError(
        400,
        "PAYLOAD_TOO_LARGE",
        `Annotation payload exceeds ${deps.annotationMaxBytes} bytes`,
        { sizeBytes: byteLength, maxBytes: deps.annotationMaxBytes },
      );
    }
    const row = await deps.repos.annotation.upsert(
      deck.id,
      slideIndex.data,
      payloadJson,
    );
    let outPayload: unknown;
    try {
      outPayload = JSON.parse(row.payloadJson);
    } catch {
      outPayload = null;
    }
    const response: AnnotationRecord = {
      deckId: deck.id,
      slideIndex: row.slideIndex,
      payload: outPayload,
      updatedAt: row.updatedAt.toISOString(),
    };
    return c.json(response, 200);
  });

  // GET /api/decks/:id/annotations
  app.get("/decks/:id/annotations", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const deck = await loadDeckOrThrow(c.req.param("id"), user.id, isAdmin);
    const rows = await deps.repos.annotation.listForDeck(deck.id);
    return c.json(
      {
        items: rows.map((r) => {
          let payload: unknown;
          try {
            payload = JSON.parse(r.payloadJson);
          } catch {
            payload = null;
          }
          return {
            slideIndex: r.slideIndex,
            payload,
            updatedAt: r.updatedAt.toISOString(),
          };
        }),
      },
      200,
    );
  });

  // DELETE /api/decks/:id/annotations/:slideIndex
  app.delete("/decks/:id/annotations/:slideIndex", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const deck = await loadDeckOrThrow(c.req.param("id"), user.id, isAdmin);
    const slideIndex = slideIndexSchema.safeParse(c.req.param("slideIndex"));
    if (!slideIndex.success) {
      throw new ApiError(400, "INVALID_SLIDE_INDEX", "Slide index must be a non-negative integer");
    }
    await deps.repos.annotation.delete(deck.id, slideIndex.data);
    return c.body(null, 204);
  });

  return app;
}
