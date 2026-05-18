/**
 * Tests for PATCH /api/decks/:id/info (Stage A.6).
 *
 * Mirrors `notes.test.ts`'s four-sink discipline (DB row, manifest JSON
 * mirror, on-disk manifest.json) but extended to the per-slide label path
 * (Slide.label rows). Plus the export round-trip — exported `.stage`
 * must reflect post-edit metadata so re-uploading it would faithfully
 * restore the modifications.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import {
  MAX_MANIFEST_TITLE_LENGTH,
  MAX_SLIDE_LABEL_LENGTH,
} from '@slidestage/shared';
import { getPrisma } from '../src/db.js';

const OWNER = 'info-tester';
const STRANGER = 'info-stranger';
const DECK_ID = 'sample-stage-a';

let env: TestEnv;
let ownerCookie: string;
let strangerCookie: string;

beforeAll(async () => {
  env = await setupTestEnv();
  ownerCookie = await authCookie(env, OWNER);
  strangerCookie = await authCookie(env, STRANGER);
  const upload = await uploadFixture(env, env.fixturePath, OWNER);
  if (upload.status !== 201) {
    throw new Error(`fixture upload failed: ${upload.status}`);
  }
}, 60_000);

afterAll(async () => {
  if (env) await teardownTestEnv(env);
});

describe('PATCH /api/decks/:id/info', () => {
  it('updates deck-level metadata across DB column, manifest mirror and disk', async () => {
    const patch = {
      title: 'Patched Deck Title',
      subtitle: 'with a fresh subtitle',
      author: 'Editor Name',
      description: 'Updated description for the deck.',
    };
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: patch,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deckFieldsChanged.sort()).toEqual(
      ['author', 'description', 'subtitle', 'title'].sort(),
    );
    expect(body.slideLabelsChanged).toEqual([]);
    expect(typeof body.manifestUpdatedAt).toBe('string');

    const prisma = getPrisma();
    const deck = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    expect(deck).toBeTruthy();
    expect(deck!.title).toBe(patch.title);
    expect(deck!.subtitle).toBe(patch.subtitle);
    expect(deck!.author).toBe(patch.author);
    expect(deck!.description).toBe(patch.description);

    const manifestMirror = JSON.parse(deck!.manifest);
    expect(manifestMirror.title).toBe(patch.title);
    expect(manifestMirror.subtitle).toBe(patch.subtitle);
    expect(manifestMirror.author).toBe(patch.author);
    expect(manifestMirror.description).toBe(patch.description);
    expect(manifestMirror.updatedAt).toBe(body.manifestUpdatedAt);

    const diskManifestText = await fs.readFile(
      path.join(env.config.storageRoot, deck!.storageRoot, 'manifest.json'),
      'utf8',
    );
    const diskManifest = JSON.parse(diskManifestText);
    expect(diskManifest.title).toBe(patch.title);
    expect(diskManifest.subtitle).toBe(patch.subtitle);
    expect(diskManifest.author).toBe(patch.author);
    expect(diskManifest.description).toBe(patch.description);
  });

  it('clears optional fields when null is sent explicitly', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { subtitle: null, description: null },
    });
    expect(res.statusCode).toBe(200);
    const prisma = getPrisma();
    const deck = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    expect(deck!.subtitle).toBeNull();
    expect(deck!.description).toBeNull();
    expect(deck!.title).toBe('Patched Deck Title'); // untouched
  });

  it('rejects an empty title with 400 and leaves disk unchanged', async () => {
    const prisma = getPrisma();
    const before = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    const beforeManifest = before!.manifest;

    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);

    const after = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    expect(after!.title).toBe(before!.title);
    expect(after!.manifest).toBe(beforeManifest);
  });

  it('updates Slide.label and the manifest copy when slideLabels is provided', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: {
        slideLabels: { '1': 'Opening Remarks', '3': 'Demo' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slideLabelsChanged.sort()).toEqual([1, 3]);

    const prisma = getPrisma();
    const slide1 = await prisma.slide.findUnique({
      where: { deckId_idx: { deckId: DECK_ID, idx: 1 } },
    });
    const slide3 = await prisma.slide.findUnique({
      where: { deckId_idx: { deckId: DECK_ID, idx: 3 } },
    });
    expect(slide1!.label).toBe('Opening Remarks');
    expect(slide3!.label).toBe('Demo');

    const deck = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    const m = JSON.parse(deck!.manifest);
    expect(m.slides[0].label).toBe('Opening Remarks');
    expect(m.slides[2].label).toBe('Demo');
  });

  it('preserves disjoint concurrent info patches for the same deck', async () => {
    const [titlePatch, labelPatch] = await Promise.all([
      env.app.inject({
        method: 'PATCH',
        url: `/api/decks/${DECK_ID}/info`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: { title: 'Concurrent Info Title' },
      }),
      env.app.inject({
        method: 'PATCH',
        url: `/api/decks/${DECK_ID}/info`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: { slideLabels: { '4': 'Concurrent Slide 4' } },
      }),
    ]);
    expect(titlePatch.statusCode).toBe(200);
    expect(labelPatch.statusCode).toBe(200);

    const deck = await getPrisma().deck.findUniqueOrThrow({
      where: { id: DECK_ID },
      select: { title: true, manifest: true },
    });
    const manifest = JSON.parse(deck.manifest);
    expect(deck.title).toBe('Concurrent Info Title');
    expect(manifest.title).toBe('Concurrent Info Title');
    expect(manifest.slides[3].label).toBe('Concurrent Slide 4');
  });

  it('rejects out-of-range slide indices with 400', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { slideLabels: { '999': 'nope' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects oversized metadata, labels, and sparse label maps', async () => {
    const tooLongTitle = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { title: 'x'.repeat(MAX_MANIFEST_TITLE_LENGTH + 1) },
    });
    expect(tooLongTitle.statusCode).toBe(400);

    const tooLongLabel = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { slideLabels: { '1': 'x'.repeat(MAX_SLIDE_LABEL_LENGTH + 1) } },
    });
    expect(tooLongLabel.statusCode).toBe(400);

    const tooManyLabels = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: {
        slideLabels: { '1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e' },
      },
    });
    expect(tooManyLabels.statusCode).toBe(413);
    expect(tooManyLabels.json().error).toBe('ETOOLARGE');
  });

  it('returns 404 when called by a non-owner', async () => {
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: strangerCookie, 'content-type': 'application/json' },
      payload: { title: 'Hijack' },
    });
    expect(res.statusCode).toBe(404);

    const prisma = getPrisma();
    const deck = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    expect(deck!.title).not.toBe('Hijack');
  });

  it('is a no-op when the patch contains no actual diffs', async () => {
    const prisma = getPrisma();
    const before = await prisma.deck.findUnique({ where: { id: DECK_ID } });
    const beforeManifest = JSON.parse(before!.manifest);

    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { title: before!.title, author: before!.author },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deckFieldsChanged).toEqual([]);
    expect(body.slideLabelsChanged).toEqual([]);
    expect(body.manifestUpdatedAt).toBe(beforeManifest.updatedAt);
  });
});

describe('GET /api/decks/:id/export reflects info edits', () => {
  it('produces a .stage archive whose manifest.json carries the latest metadata', async () => {
    // Ensure a known sentinel set just before exporting.
    const patch = {
      title: 'Exportable Title',
      subtitle: 'export subtitle',
      author: 'export author',
      description: 'export description',
      slideLabels: { '2': 'Exported Slide 2' },
    };
    const setup = await env.app.inject({
      method: 'PATCH',
      url: `/api/decks/${DECK_ID}/info`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: patch,
    });
    expect(setup.statusCode).toBe(200);

    const res = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}/export`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.stage+zip');

    const zip = new AdmZip(res.rawPayload as Buffer);
    const manifestEntry = zip.getEntry('manifest.json');
    expect(manifestEntry).toBeTruthy();
    const manifest = JSON.parse(manifestEntry!.getData().toString('utf8'));
    expect(manifest.title).toBe(patch.title);
    expect(manifest.subtitle).toBe(patch.subtitle);
    expect(manifest.author).toBe(patch.author);
    expect(manifest.description).toBe(patch.description);
    expect(manifest.slides[1].label).toBe('Exported Slide 2');
  });
});
