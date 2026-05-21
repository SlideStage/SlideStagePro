import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  buildTestApp,
  cookieHeader,
  resetTables,
  signUpUser,
  teardownTestEnv,
  type TestApp,
} from "./helpers/testApp.js";

function buildStageZip(title = "Notes Deck"): Buffer {
  const manifest = {
    schema: "slidestage@1.0",
    id: "deck-notes-001",
    version: "1.0.0",
    title,
    subtitle: null,
    author: null,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    architecture: "multi-file",
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 1,
    slides: [
      {
        index: 1,
        id: "s0",
        label: "Only",
        file: "slides/01.html",
        thumbnail: null,
        notes: null,
      },
    ],
  };
  return Buffer.from(
    zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "slides/01.html": strToU8("<!doctype html><body>1</body>"),
    }),
  );
}

let ctx: TestApp;
let cookies: string[];
let deckId: string;

beforeAll(async () => {
  ctx = await buildTestApp();
  await resetTables(ctx.prisma);
  await signUpUser(ctx, {
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
  });
  const result = await signUpUser(ctx, {
    email: "noteguy@example.com",
    name: "Note Guy",
  });
  cookies = result.cookies;

  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(buildStageZip())], "deck.stage", {
      type: "application/zip",
    }),
  );
  const res = await ctx.app.request("http://127.0.0.1:3000/api/decks", {
    method: "POST",
    headers: { Cookie: cookieHeader(cookies) },
    body: form,
  });
  if (res.status !== 201) {
    throw new Error(`failed to upload deck: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  deckId = body.id;
});

afterAll(async () => {
  await teardownTestEnv();
});

describe("PUT /api/decks/:id/notes/:slideIndex", () => {
  it("upserts a note for slide 0", async () => {
    const putRes = await ctx.app.request(
      `http://127.0.0.1:3000/api/decks/${deckId}/notes/0`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(cookies),
        },
        body: JSON.stringify({ body: "Hello from slide 0" }),
      },
    );
    expect(putRes.status).toBe(200);
    const created = (await putRes.json()) as {
      deckId: string;
      slideIndex: number;
      body: string;
      updatedAt: string;
    };
    expect(created.deckId).toBe(deckId);
    expect(created.slideIndex).toBe(0);
    expect(created.body).toBe("Hello from slide 0");

    // Overwrite & re-read.
    await ctx.app.request(
      `http://127.0.0.1:3000/api/decks/${deckId}/notes/0`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(cookies),
        },
        body: JSON.stringify({ body: "Updated body" }),
      },
    );
    const listRes = await ctx.app.request(
      `http://127.0.0.1:3000/api/decks/${deckId}/notes`,
      { headers: { Cookie: cookieHeader(cookies) } },
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      items: Array<{ slideIndex: number; body: string }>;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.body).toBe("Updated body");
  });

  it("rejects an empty note body that exceeds 10k chars", async () => {
    const tooLong = "a".repeat(10_001);
    const res = await ctx.app.request(
      `http://127.0.0.1:3000/api/decks/${deckId}/notes/0`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(cookies),
        },
        body: JSON.stringify({ body: tooLong }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("DELETE removes the note", async () => {
    const del = await ctx.app.request(
      `http://127.0.0.1:3000/api/decks/${deckId}/notes/0`,
      { method: "DELETE", headers: { Cookie: cookieHeader(cookies) } },
    );
    expect(del.status).toBe(204);
    const list = await ctx.app.request(
      `http://127.0.0.1:3000/api/decks/${deckId}/notes`,
      { headers: { Cookie: cookieHeader(cookies) } },
    );
    const body = (await list.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });
});
