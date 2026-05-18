/**
 * Tests for the speaker-notes editing + deck-export routes (Stage A.5).
 *
 * Coverage targets:
 *   1. PATCH /api/decks/:id/notes propagates the new note to:
 *      a. `Slide.notes` row in DB
 *      b. `Deck.manifest` JSON column
 *      c. on-disk `manifest.json`
 *      d. on-disk `speaker-notes.json`
 *   2. PATCH respects ownership (404 cross-user)
 *   3. PATCH validates the body shape and slide-index range
 *   4. GET /api/decks/:id/export streams a fresh .stage zip whose
 *      manifest.json reflects the latest edits.
 *   5. Export 404s for cross-user access.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import {
  setupTestEnv,
  teardownTestEnv,
  uploadFixture,
  authCookie,
  type TestEnv,
} from './helpers.js';
import { MAX_SLIDE_NOTES_LENGTH } from '@slidestage/shared';
import { getPrisma } from '../src/db.js';

const OWNER = 'notes-tester';
const STRANGER = 'stranger';
const DECK_ID = 'sample-stage-a';

let env: TestEnv;
let ownerCookie: string;
let strangerCookie: string;
let ownerUserId: string;

beforeAll(async () => {
  env = await setupTestEnv();
  ownerCookie = await authCookie(env, OWNER);
  strangerCookie = await authCookie(env, STRANGER);
  const me = await env.app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: ownerCookie },
  });
  ownerUserId = me.json().user.id;
  const upload = await uploadFixture(env, env.fixturePath, OWNER);
  if (upload.status !== 201) {
    throw new Error(`fixture upload failed: ${upload.status}`);
  }
}, 60_000);

afterAll(async () => {
  if (env) await teardownTestEnv(env);
});

describe('PATCH /api/decks/:id/notes', () => {
  it('updates DB rows, deck.manifest, manifest.json and speaker-notes.json', async () => {
    const newNote =
      'Updated speaker note for slide 2 — please verify all four sinks.';
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: {
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      payload: { notes: { '2': newNote, '3': 'New note for slide 3.' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(2);
    expect(typeof body.manifestUpdatedAt).toBe('string');

    // 1a. Slide row was updated.
    const prisma = getPrisma();
    const slide2 = await prisma.slide.findUnique({
      where: { deckId_idx: { deckId: DECK_ID, idx: 2 } },
    });
    expect(slide2?.notes).toBe(newNote);

    // 1b. Deck.manifest mirror updated.
    const deckRow = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    expect(deckRow).toBeTruthy();
    const manifest = JSON.parse(deckRow!.manifest);
    expect(manifest.slides[1].notes).toBe(newNote);
    expect(manifest.slides[2].notes).toBe('New note for slide 3.');
    expect(manifest.updatedAt).toBe(body.manifestUpdatedAt);

    // 1c. On-disk manifest.json reflects the edits.
    const storageDir = path.join(env.config.storageRoot, deckRow!.storageRoot);
    const manifestText = await fs.readFile(
      path.join(storageDir, 'manifest.json'),
      'utf8',
    );
    const diskManifest = JSON.parse(manifestText);
    expect(diskManifest.slides[1].notes).toBe(newNote);
    expect(diskManifest.slides[2].notes).toBe('New note for slide 3.');

    // 1d. On-disk speaker-notes.json reflects the edits.
    const notesText = await fs.readFile(
      path.join(storageDir, 'speaker-notes.json'),
      'utf8',
    );
    const notesArr = JSON.parse(notesText);
    expect(notesArr[1]).toBe(newNote);
    expect(notesArr[2]).toBe('New note for slide 3.');
  });

  it('restores manifest.json and speaker-notes.json when the DB transaction fails', async () => {
    const prisma = getPrisma();
    const deck = await prisma.deck.findUniqueOrThrow({
      where: { id: DECK_ID },
      select: { storageRoot: true, manifest: true },
    });
    const manifestPath = path.join(env.config.storageRoot, deck.storageRoot, 'manifest.json');
    const notesPath = path.join(env.config.storageRoot, deck.storageRoot, 'speaker-notes.json');
    const originalManifest = await fs.readFile(manifestPath, 'utf8');
    const originalNotes = await fs.readFile(notesPath, 'utf8');

    const txSpy = vi.spyOn(prisma, '$transaction').mockImplementationOnce(async () => {
      throw new Error('forced notes db failure');
    });
    try {
      const res = await env.app.inject({
        method: 'PATCH',
        url: `/api/decks/${DECK_ID}/notes`,
        headers: {
          cookie: ownerCookie,
          'content-type': 'application/json',
        },
        payload: { notes: { '2': 'This write should roll back on disk.' } },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toContain('forced notes db failure');
    } finally {
      txSpy.mockRestore();
    }

    expect(await fs.readFile(manifestPath, 'utf8')).toBe(originalManifest);
    expect(await fs.readFile(notesPath, 'utf8')).toBe(originalNotes);
    const currentDeck = await prisma.deck.findUniqueOrThrow({
      where: { id: DECK_ID },
      select: { manifest: true },
    });
    expect(currentDeck.manifest).toBe(deck.manifest);
  });

  it('treats an empty string as "clear the note" (null in manifest)', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: {
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      payload: { notes: { '4': '' } },
    });
    expect(res.statusCode).toBe(200);

    const prisma = getPrisma();
    const slide4 = await prisma.slide.findUnique({
      where: { deckId_idx: { deckId: DECK_ID, idx: 4 } },
    });
    expect(slide4?.notes).toBeNull();
  });

  it('preserves disjoint concurrent note patches for the same deck', async () => {
    const [slide1, slide2] = await Promise.all([
      env.app.inject({
        method: 'PATCH',
        url: `/api/decks/${DECK_ID}/notes`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: { notes: { '1': 'Concurrent note one' } },
      }),
      env.app.inject({
        method: 'PATCH',
        url: `/api/decks/${DECK_ID}/notes`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: { notes: { '2': 'Concurrent note two' } },
      }),
    ]);
    expect(slide1.statusCode).toBe(200);
    expect(slide2.statusCode).toBe(200);

    const deck = await getPrisma().deck.findUniqueOrThrow({
      where: { id: DECK_ID },
      select: { manifest: true },
    });
    const manifest = JSON.parse(deck.manifest);
    expect(manifest.slides[0].notes).toBe('Concurrent note one');
    expect(manifest.slides[1].notes).toBe('Concurrent note two');
  });

  it('rejects out-of-range slide indices with 400', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: {
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      payload: { notes: { '99': 'too high' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects oversized note text and oversized sparse maps', async () => {
    const tooLong = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: {
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      payload: { notes: { '1': 'x'.repeat(MAX_SLIDE_NOTES_LENGTH + 1) } },
    });
    expect(tooLong.statusCode).toBe(400);

    const tooMany = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: {
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      payload: { notes: { '1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e' } },
    });
    expect(tooMany.statusCode).toBe(413);
    expect(tooMany.json().error).toBe('ETOOLARGE');
  });

  it('rejects malformed body (non-string keys / wrong shape) with 400', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: {
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      payload: { notes: { abc: 'x' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when called by a non-owner', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: {
        cookie: strangerCookie,
        'content-type': 'application/json',
      },
      payload: { notes: { '1': 'should not stick' } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/decks/:id/notes/audit', () => {
  it('returns audit entries for every actually-changed slide, newest first', async () => {
    // The earlier PATCHes in this file have already produced 3 audit rows
    // (slide 2 update, slide 3 add, slide 4 clear). Add one more change so
    // we can assert ordering.
    const sentinel = `Audit log marker ${Date.now()}`;
    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { notes: { '1': sentinel } },
    });
    expect(patch.statusCode).toBe(200);

    const res = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/notes/audit`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const { entries, nextCursor } = res.json() as {
      entries: Array<Record<string, unknown>>;
      nextCursor: number | null;
    };
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(nextCursor).toBeNull();
    expect(entries[0]).toMatchObject({
      deckId: DECK_ID,
      userId: ownerUserId,
      slideIdx: 1,
      newNotes: sentinel,
    });
    expect(typeof entries[0].editedAt).toBe('string');
    for (const e of entries) {
      expect(e).toHaveProperty('id');
      expect(e).toHaveProperty('deckId');
      expect(e).toHaveProperty('userId');
      expect(e).toHaveProperty('slideIdx');
      expect(e).toHaveProperty('previousNotes');
      expect(e).toHaveProperty('newNotes');
      expect(e).toHaveProperty('editedAt');
    }
  });

  it('paginates with ?limit + ?cursor (cursor-based)', async () => {
    // Fetch page 1 of size 2 — there are at least 4 rows so we expect
    // nextCursor !== null.
    const p1 = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/notes/audit?limit=2`,
      headers: { cookie: ownerCookie },
    });
    expect(p1.statusCode).toBe(200);
    const page1 = p1.json() as {
      entries: Array<{ id: number }>;
      nextCursor: number | null;
    };
    expect(page1.entries.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2 starting from nextCursor — every entry id must be smaller
    // than the cursor (newest-first ordering).
    const p2 = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/notes/audit?limit=2&cursor=${page1.nextCursor}`,
      headers: { cookie: ownerCookie },
    });
    expect(p2.statusCode).toBe(200);
    const page2 = p2.json() as {
      entries: Array<{ id: number }>;
      nextCursor: number | null;
    };
    expect(page2.entries.length).toBeGreaterThan(0);
    for (const e of page2.entries) {
      expect(e.id).toBeLessThan(page1.nextCursor!);
    }
    // No id appears in both pages (no overlap).
    const ids1 = new Set(page1.entries.map((e) => e.id));
    for (const e of page2.entries) expect(ids1.has(e.id)).toBe(false);
  });

  it('rejects invalid limit/cursor values with 400', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/notes/audit?limit=999`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('skips no-op PATCH calls (no audit row when nothing changed)', async () => {
    const before = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/notes/audit?limit=200`,
      headers: { cookie: ownerCookie },
    });
    const beforeCount = (before.json() as { entries: unknown[] }).entries
      .length;

    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/notes`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { notes: { '3': 'New note for slide 3.' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().updated).toBe(0);

    const after = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/notes/audit?limit=200`,
      headers: { cookie: ownerCookie },
    });
    const afterCount = (after.json() as { entries: unknown[] }).entries.length;
    expect(afterCount).toBe(beforeCount);
  });

  it('returns 404 to non-owners', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/notes/audit`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/decks/:id/export', () => {
  it('streams a .stage zip whose manifest reflects edited notes', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/export`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.stage+zip');
    expect(String(res.headers['content-disposition'] ?? '')).toMatch(
      /attachment; filename="sample-stage-a-/,
    );

    const buf = res.rawPayload;
    expect(buf.length).toBeGreaterThan(0);

    const zip = new AdmZip(buf);
    const manifestEntry = zip.getEntry('manifest.json');
    expect(manifestEntry).toBeTruthy();
    const manifest = JSON.parse(manifestEntry!.getData().toString('utf8'));
    // Edits from the PATCH test above should be present.
    expect(manifest.slides[1].notes).toBe('Concurrent note two');
    expect(manifest.slides[2].notes).toBe('New note for slide 3.');
    expect(manifest.slides[3].notes).toBeNull();

    // The zip must still contain the original slide HTML + thumbnails.
    expect(zip.getEntry('slides/01-cover.html')).toBeTruthy();
    expect(zip.getEntry('slides/02-agenda.html')).toBeTruthy();
    expect(zip.getEntry('thumbnails/01.png')).toBeTruthy();
    expect(zip.getEntry('speaker-notes.json')).toBeTruthy();
  });

  it('returns 404 when called by a non-owner', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/export`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
