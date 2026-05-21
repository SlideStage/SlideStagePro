import { Hono } from "hono";
import { z } from "zod";
import type { Repositories } from "../db/repositories/index.js";
import { ApiError } from "../middleware/error.js";
import type { AuthVars } from "../middleware/auth.js";
import type { NoteRecord } from "../types/contract.js";

export interface NoteRoutesDeps {
  repos: Repositories;
}

const NOTE_BODY_MAX_CHARS = 10000;

const upsertSchema = z.object({
  body: z.string().max(NOTE_BODY_MAX_CHARS),
});

const slideIndexSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "string" ? Number.parseInt(v, 10) : v))
  .pipe(z.number().int().min(0));

export function createNoteRoutes(deps: NoteRoutesDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  // Helper: assert deck access (owner or admin reads/writes their own notes;
  // contract says notes follow deck reader/owner semantics).
  async function loadDeckOrThrow(deckId: string, userId: string, isAdmin: boolean) {
    const deck = await deps.repos.deck.findById(deckId);
    if (!deck) throw new ApiError(404, "NOT_FOUND", "Deck not found");
    if (!isAdmin && deck.ownerId !== userId) {
      throw new ApiError(403, "FORBIDDEN", "Cannot access notes for this deck");
    }
    return deck;
  }

  // PUT /api/decks/:id/notes/:slideIndex
  app.put("/decks/:id/notes/:slideIndex", async (c) => {
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
      throw new ApiError(400, "INVALID_BODY", "Invalid note body", parsed.error.flatten());
    }
    const row = await deps.repos.note.upsert(deck.id, slideIndex.data, parsed.data.body);
    const response: NoteRecord = {
      deckId: deck.id,
      slideIndex: row.slideIndex,
      body: row.body,
      updatedAt: row.updatedAt.toISOString(),
    };
    return c.json(response, 200);
  });

  // GET /api/decks/:id/notes
  app.get("/decks/:id/notes", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const deck = await loadDeckOrThrow(c.req.param("id"), user.id, isAdmin);
    const rows = await deps.repos.note.listForDeck(deck.id);
    return c.json(
      {
        items: rows.map((r) => ({
          slideIndex: r.slideIndex,
          body: r.body,
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
      200,
    );
  });

  // DELETE /api/decks/:id/notes/:slideIndex
  app.delete("/decks/:id/notes/:slideIndex", async (c) => {
    const user = c.get("user")!;
    const isAdmin = (user.role ?? "user") === "admin";
    const deck = await loadDeckOrThrow(c.req.param("id"), user.id, isAdmin);
    const slideIndex = slideIndexSchema.safeParse(c.req.param("slideIndex"));
    if (!slideIndex.success) {
      throw new ApiError(400, "INVALID_SLIDE_INDEX", "Slide index must be a non-negative integer");
    }
    await deps.repos.note.delete(deck.id, slideIndex.data);
    return c.body(null, 204);
  });

  return app;
}
