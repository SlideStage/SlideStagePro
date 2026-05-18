import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  setupTestEnv,
  teardownTestEnv,
  uploadFixture,
  authCookie,
  type TestEnv,
} from './helpers.js';
import { build as buildFixture } from '../../../scripts/build-fixture.mjs';
import { makeZip } from '../../../scripts/build-fixture.mjs';
import { getPrisma } from '../src/db.js';
import {
  MAX_MANIFEST_ASSET_FILES,
  MAX_MANIFEST_TITLE_LENGTH,
  MAX_MANIFEST_TOKEN_KEYS,
  MAX_SLIDE_NOTES_LENGTH,
  MAX_STROKES_PER_SLIDE,
} from '@slidestage/shared';

let env: TestEnv;
let testerCookie: string;
let strangerCookie: string;

function makeSingleSlideManifest(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'slidestage@1.0',
    id,
    version: '1.0',
    title: 'Test Deck',
    subtitle: null,
    author: null,
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    architecture: 'multi-file',
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 1,
    slides: [
      {
        index: 1,
        id: 'a',
        label: 'A',
        file: 'slides/01.html',
        thumbnail: null,
        notes: null,
      },
    ],
    fonts: [],
    tokens: {},
    assets: { totalSize: 0, count: 0, files: [] },
    runtime: { presenterTools: 'platform', fallbackEntry: null, capabilities: [] },
    platform: { minSchemaVersion: '1.0', compatibleArchitectures: ['multi-file'] },
    stats: { packedAt: '2026-01-01T00:00:00Z', packerVersion: 'test' },
    ...overrides,
  };
}

beforeAll(async () => {
  env = await setupTestEnv();
  testerCookie = await authCookie(env, 'tester');
  strangerCookie = await authCookie(env, 'someone-else');
}, 60_000);

afterAll(async () => {
  if (env) await teardownTestEnv(env);
});

describe('POST /api/decks (upload pipeline)', () => {
  it('accepts a valid sample.stage and indexes it', async () => {
    const res = await uploadFixture(env);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('sample-stage-a');
    expect(res.body.manifest.totalSlides).toBe(4);
  });

  it('lists the uploaded deck for the same user', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/decks',
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decks).toHaveLength(1);
    expect(body.decks[0].id).toBe('sample-stage-a');
  });

  it('serves the manifest under /api/decks/:id/manifest', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/decks/sample-stage-a/manifest',
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schema).toBe('slidestage@1.0');
    expect(body.slides[0].id).toBe('cover');
  });

  it('serves slide HTML through /storage only to the owner', async () => {
    // No cookie + no token → 404 (was previously 401, but the route now
    // returns a uniform 404 so unauthenticated probes can't enumerate
    // existing deck ids vs missing ones — see routes/storage.ts).
    const unauthenticated = await env.app.inject({
      method: 'GET',
      url: '/storage/sample-stage-a/slides/01-cover.html',
    });
    expect(unauthenticated.statusCode).toBe(404);

    const stranger = await env.app.inject({
      method: 'GET',
      url: '/storage/sample-stage-a/slides/01-cover.html',
      headers: { cookie: strangerCookie },
    });
    expect(stranger.statusCode).toBe(404);

    const res = await env.app.inject({
      method: 'GET',
      url: '/storage/sample-stage-a/slides/01-cover.html',
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(res.body).toContain('Slide Deck Packaging Demo');
  });

  it('serves thumbnail PNGs to the owner', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/storage/sample-stage-a/thumbnails/01.png',
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });

  it('keeps decks user-isolated', async () => {
    const otherUser = await env.app.inject({
      method: 'GET',
      url: '/api/decks',
      headers: { cookie: strangerCookie },
    });
    expect(otherUser.statusCode).toBe(200);
    expect(otherUser.json().decks).toHaveLength(0);

    const cantSee = await env.app.inject({
      method: 'GET',
      url: '/api/decks/sample-stage-a',
      headers: { cookie: strangerCookie },
    });
    expect(cantSee.statusCode).toBe(404);
  });

  it('rejects another user uploading the same manifest id', async () => {
    const res = await uploadFixture(env, env.fixturePath, 'someone-else');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('deck id already exists');

    const otherUser = await env.app.inject({
      method: 'GET',
      url: '/api/decks',
      headers: { cookie: strangerCookie },
    });
    expect(otherUser.statusCode).toBe(200);
    expect(otherUser.json().decks).toHaveLength(0);

    const ownerCanStillLoad = await env.app.inject({
      method: 'GET',
      url: '/storage/sample-stage-a/slides/01-cover.html',
      headers: { cookie: testerCookie },
    });
    expect(ownerCanStillLoad.statusCode).toBe(200);
    expect(ownerCanStillLoad.body).toContain('Slide Deck Packaging Demo');
  });

  it('restores previous storage if DB persistence fails after replacement promotion', async () => {
    const replacementManifest = {
      schema: 'slidestage@1.0',
      id: 'sample-stage-a',
      version: '2.0',
      title: 'Replacement that should roll back',
      subtitle: null,
      author: null,
      description: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      architecture: 'multi-file',
      dimensions: { width: 1920, height: 1080 },
      totalSlides: 1,
      slides: [
        {
          index: 1,
          id: 'replacement',
          label: 'Replacement',
          file: 'slides/01-cover.html',
          thumbnail: null,
          notes: null,
        },
      ],
      fonts: [],
      tokens: {},
      assets: { totalSize: 0, count: 0, files: [] },
      runtime: { presenterTools: 'platform', fallbackEntry: null, capabilities: [] },
      platform: { minSchemaVersion: '1.0', compatibleArchitectures: ['multi-file'] },
      stats: { packedAt: '2026-01-01T00:00:00Z', packerVersion: 'test' },
    };
    const zipPath = path.join(env.tmpRoot, 'replacement-fails.stage');
    const buf = makeZip([
      { name: 'manifest.json', content: JSON.stringify(replacementManifest) },
      {
        name: 'slides/01-cover.html',
        content: '<html><body>Replacement should not persist</body></html>',
      },
    ]);
    await fs.writeFile(zipPath, buf);

    const txSpy = vi
      .spyOn(getPrisma(), '$transaction')
      .mockImplementationOnce(async () => {
        throw new Error('forced db failure');
      });
    try {
      const res = await uploadFixture(env, zipPath, 'tester');
      expect(res.status).toBe(500);
      expect(res.body.message).toContain('forced db failure');
    } finally {
      txSpy.mockRestore();
    }

    const ownerCanStillLoad = await env.app.inject({
      method: 'GET',
      url: '/storage/sample-stage-a/slides/01-cover.html',
      headers: { cookie: testerCookie },
    });
    expect(ownerCanStillLoad.statusCode).toBe(200);
    expect(ownerCanStillLoad.body).toContain('Slide Deck Packaging Demo');
    expect(ownerCanStillLoad.body).not.toContain('Replacement should not persist');

    const deck = await getPrisma().deck.findUniqueOrThrow({
      where: { id: 'sample-stage-a' },
      select: { storageRoot: true },
    });
    const storageParent = path.dirname(path.join(env.config.storageRoot, deck.storageRoot));
    const siblings = await fs.readdir(storageParent);
    expect(siblings.some((name) => name.includes('.replaced-'))).toBe(false);
  });

  it('rejects a zip-slip payload with EZIPSLIP', async () => {
    // Hand-craft a zip that contains "../evil.txt" entry.
    const zipPath = path.join(env.tmpRoot, 'evil.stage');
    const buf = makeZip([
      { name: '../evil.txt', content: 'pwn' },
      { name: 'manifest.json', content: '{}' },
    ]);
    await fs.writeFile(zipPath, buf);
    const res = await uploadFixture(env, zipPath, 'attacker');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EZIPSLIP');
  });

  it('rejects a zip without manifest.json with ENOMANIFEST', async () => {
    const zipPath = path.join(env.tmpRoot, 'no-manifest.stage');
    const buf = makeZip([{ name: 'slides/01.html', content: '<html></html>' }]);
    await fs.writeFile(zipPath, buf);
    const res = await uploadFixture(env, zipPath, 'tester');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ENOMANIFEST');
  });

  it('rejects a manifest with mismatched totalSlides', async () => {
    const manifest = {
      schema: 'slidestage@1.0',
      id: 'broken-deck',
      version: '1.0',
      title: 'Broken',
      subtitle: null,
      author: null,
      description: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      architecture: 'multi-file',
      dimensions: { width: 1920, height: 1080 },
      totalSlides: 2,
      slides: [
        {
          index: 1,
          id: 'a',
          label: 'A',
          file: 'slides/01.html',
          thumbnail: null,
          notes: null,
        },
      ],
      fonts: [],
      tokens: {},
      assets: { totalSize: 0, count: 0, files: [] },
      runtime: { presenterTools: 'platform', fallbackEntry: null, capabilities: [] },
      platform: { minSchemaVersion: '1.0', compatibleArchitectures: ['multi-file'] },
      stats: { packedAt: '2026-01-01T00:00:00Z', packerVersion: 'test' },
    };
    const zipPath = path.join(env.tmpRoot, 'broken.stage');
    const buf = makeZip([
      { name: 'manifest.json', content: JSON.stringify(manifest) },
      { name: 'slides/01.html', content: '<html><body>1</body></html>' },
    ]);
    await fs.writeFile(zipPath, buf);
    const res = await uploadFixture(env, zipPath, 'tester');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EBADMANIFEST');
  });

  it('rejects a manifest missing referenced slide files', async () => {
    const manifest = {
      schema: 'slidestage@1.0',
      id: 'missing-deck',
      version: '1.0',
      title: 'Missing',
      subtitle: null,
      author: null,
      description: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      architecture: 'multi-file',
      dimensions: { width: 1920, height: 1080 },
      totalSlides: 1,
      slides: [
        {
          index: 1,
          id: 'a',
          label: 'A',
          file: 'slides/missing.html',
          thumbnail: null,
          notes: null,
        },
      ],
      fonts: [],
      tokens: {},
      assets: { totalSize: 0, count: 0, files: [] },
      runtime: { presenterTools: 'platform', fallbackEntry: null, capabilities: [] },
      platform: { minSchemaVersion: '1.0', compatibleArchitectures: ['multi-file'] },
      stats: { packedAt: '2026-01-01T00:00:00Z', packerVersion: 'test' },
    };
    const zipPath = path.join(env.tmpRoot, 'missing.stage');
    const buf = makeZip([
      { name: 'manifest.json', content: JSON.stringify(manifest) },
    ]);
    await fs.writeFile(zipPath, buf);
    const res = await uploadFixture(env, zipPath, 'tester');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EMISSINGFILE');
  });

  it('rejects unsafe package paths in thumbnails, assets, and fonts', async () => {
    const makeManifest = (
      id: string,
      overrides: Record<string, unknown>,
    ): Record<string, unknown> => ({
      schema: 'slidestage@1.0',
      id,
      version: '1.0',
      title: 'Unsafe Paths',
      subtitle: null,
      author: null,
      description: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      architecture: 'multi-file',
      dimensions: { width: 1920, height: 1080 },
      totalSlides: 1,
      slides: [
        {
          index: 1,
          id: 'a',
          label: 'A',
          file: 'slides/01.html',
          thumbnail: null,
          notes: null,
        },
      ],
      fonts: [],
      tokens: {},
      assets: { totalSize: 0, count: 0, files: [] },
      runtime: { presenterTools: 'platform', fallbackEntry: null, capabilities: [] },
      platform: { minSchemaVersion: '1.0', compatibleArchitectures: ['multi-file'] },
      stats: { packedAt: '2026-01-01T00:00:00Z', packerVersion: 'test' },
      ...overrides,
    });
    const cases = [
      makeManifest('unsafe-thumbnail', {
        slides: [
          {
            index: 1,
            id: 'a',
            label: 'A',
            file: 'slides/01.html',
            thumbnail: '../outside.png',
            notes: null,
          },
        ],
      }),
      makeManifest('unsafe-asset', {
        assets: {
          totalSize: 1,
          count: 1,
          files: [{ path: 'assets/../secret.png', size: 1, type: 'image' }],
        },
      }),
      makeManifest('unsafe-font', {
        fonts: [
          {
            family: 'Unsafe',
            source: 'self-hosted',
            weights: [400],
            files: ['/secret.woff2'],
          },
        ],
      }),
    ];

    for (const [idx, manifest] of cases.entries()) {
      const zipPath = path.join(env.tmpRoot, `unsafe-path-${idx}.stage`);
      await fs.writeFile(
        zipPath,
        makeZip([
          { name: 'manifest.json', content: JSON.stringify(manifest) },
          { name: 'slides/01.html', content: '<html><body>1</body></html>' },
        ]),
      );
      const res = await uploadFixture(env, zipPath, 'tester');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('EBADMANIFEST');
    }
  });

  it('preserves provenance and normalizes compat.requires across the upload pipeline', async () => {
    const manifest = makeSingleSlideManifest('provenance-compat-deck', {
      provenance: {
        sourceKind: 'webcomponent-deck',
        conversionMode: 'wrap',
        sourceEntry: 'index.html',
        converter: { name: 'slides-deck-converter', version: '0.1.0' },
      },
      compat: {
        // Includes a duplicate and an unknown capability that must be
        // dropped during normalization. The output should be sorted and
        // contain only the canonical TrustCapability values.
        requires: [
          'window-open',
          'future-capability',
          'window-open',
          'same-origin-storage',
        ],
        notes: 'demo deck',
      },
    });
    const zipPath = path.join(env.tmpRoot, 'provenance-compat-deck.stage');
    await fs.writeFile(
      zipPath,
      makeZip([
        { name: 'manifest.json', content: JSON.stringify(manifest) },
        { name: 'slides/01.html', content: '<html><body>1</body></html>' },
      ]),
    );
    const res = await uploadFixture(env, zipPath, 'tester');
    expect(res.status).toBe(201);
    expect(res.body.manifest.provenance).toMatchObject({
      sourceKind: 'webcomponent-deck',
      conversionMode: 'wrap',
      sourceEntry: 'index.html',
      converter: { name: 'slides-deck-converter', version: '0.1.0' },
    });
    expect(res.body.manifest.compat.requires).toEqual([
      'same-origin-storage',
      'window-open',
    ]);
    expect(res.body.manifest.compat.notes).toBe('demo deck');

    const detail = await env.app.inject({
      method: 'GET',
      url: '/api/decks/provenance-compat-deck',
      headers: { cookie: testerCookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.manifest.provenance.sourceKind).toBe('webcomponent-deck');
    expect(body.manifest.compat.requires).toEqual([
      'same-origin-storage',
      'window-open',
    ]);
  });

  it('preserves offline mirror metadata and exposes a list-endpoint summary', async () => {
    // Bake a single mirrored asset so we exercise the path-existence
    // validation in pipeline/validate.ts; the bytes are arbitrary.
    const mirrorPath = 'assets/_mirror/img/abc123.png';
    const manifest = makeSingleSlideManifest('offline-ready-deck', {
      assets: {
        totalSize: 4,
        count: 1,
        files: [{ path: mirrorPath, size: 4, type: 'image' }],
      },
      offline: {
        ready: true,
        mirroredAt: '2026-05-15T12:00:00.000Z',
        mirrorTool: { name: 'slidestage-mirror', version: '0.1.0' },
        policy: {
          includeScripts: false,
          includeIframes: false,
          maxAssetBytes: 50 * 1024 * 1024,
          maxTotalBytes: 500 * 1024 * 1024,
        },
        mirroredAssets: [
          {
            originalUrl: 'https://images.example.com/hero.png',
            path: mirrorPath,
            contentHash: 'sha256-deadbeef',
            contentType: 'image/png',
            bytes: 4,
            fetchedAt: '2026-05-15T12:00:00.000Z',
            referencedBy: [1],
          },
        ],
        skippedUrls: [],
      },
    });
    const zipPath = path.join(env.tmpRoot, 'offline-ready-deck.stage');
    await fs.writeFile(
      zipPath,
      makeZip([
        { name: 'manifest.json', content: JSON.stringify(manifest) },
        { name: 'slides/01.html', content: '<html><body>1</body></html>' },
        // Note: bytes are intentionally small + arbitrary; the validator
        // only checks existence, not hash equality.
        { name: mirrorPath, content: 'PNG\x00' },
      ]),
    );
    const upload = await uploadFixture(env, zipPath, 'tester');
    expect(upload.status).toBe(201);
    expect(upload.body.manifest.offline).toMatchObject({
      ready: true,
      mirroredAssets: [
        expect.objectContaining({
          originalUrl: 'https://images.example.com/hero.png',
          path: mirrorPath,
        }),
      ],
    });

    const detail = await env.app.inject({
      method: 'GET',
      url: '/api/decks/offline-ready-deck',
      headers: { cookie: testerCookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.manifest.offline.ready).toBe(true);
    expect(body.manifest.offline.mirroredAssets[0].path).toBe(mirrorPath);

    const list = await env.app.inject({
      method: 'GET',
      url: '/api/decks',
      headers: { cookie: testerCookie },
    });
    expect(list.statusCode).toBe(200);
    const listed = list
      .json()
      .decks.find((d: { id: string }) => d.id === 'offline-ready-deck');
    expect(listed.offline).toMatchObject({
      ready: true,
      mirroredAssets: 1,
      skippedUrls: 0,
    });
  });

  it('rejects manifests whose offline.mirroredAssets reference missing files', async () => {
    const manifest = makeSingleSlideManifest('offline-broken-deck', {
      offline: {
        ready: true,
        mirroredAt: '2026-05-15T12:00:00.000Z',
        mirrorTool: { name: 'slidestage-mirror' },
        mirroredAssets: [
          {
            originalUrl: 'https://images.example.com/hero.png',
            path: 'assets/_mirror/img/missing.png',
            contentHash: 'sha256-deadbeef',
            contentType: 'image/png',
            bytes: 4,
            fetchedAt: '2026-05-15T12:00:00.000Z',
            referencedBy: [1],
          },
        ],
        skippedUrls: [],
      },
    });
    const zipPath = path.join(env.tmpRoot, 'offline-broken-deck.stage');
    await fs.writeFile(
      zipPath,
      makeZip([
        { name: 'manifest.json', content: JSON.stringify(manifest) },
        { name: 'slides/01.html', content: '<html><body>1</body></html>' },
        // The mirrored asset path declared in the manifest is intentionally
        // omitted from the package.
      ]),
    );
    const res = await uploadFixture(env, zipPath, 'tester');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EMISSINGFILE');
  });

  it('rejects manifests with oversized strings and collections', async () => {
    const assetFiles = Array.from(
      { length: MAX_MANIFEST_ASSET_FILES + 1 },
      (_, idx) => ({
        path: `assets/${idx}.png`,
        size: 0,
        type: 'image',
      }),
    );
    const cases = [
      makeSingleSlideManifest('oversized-title', {
        title: 'x'.repeat(MAX_MANIFEST_TITLE_LENGTH + 1),
      }),
      makeSingleSlideManifest('oversized-note', {
        slides: [
          {
            index: 1,
            id: 'a',
            label: 'A',
            file: 'slides/01.html',
            thumbnail: null,
            notes: 'x'.repeat(MAX_SLIDE_NOTES_LENGTH + 1),
          },
        ],
      }),
      makeSingleSlideManifest('too-many-assets', {
        assets: {
          totalSize: 0,
          count: assetFiles.length,
          files: assetFiles,
        },
      }),
      makeSingleSlideManifest('too-many-tokens', {
        tokens: Object.fromEntries(
          Array.from({ length: MAX_MANIFEST_TOKEN_KEYS + 1 }, (_, idx) => [
            `token${idx}`,
            idx,
          ]),
        ),
      }),
    ];

    for (const [idx, manifest] of cases.entries()) {
      const zipPath = path.join(env.tmpRoot, `oversized-manifest-${idx}.stage`);
      await fs.writeFile(
        zipPath,
        makeZip([
          { name: 'manifest.json', content: JSON.stringify(manifest) },
          { name: 'slides/01.html', content: '<html><body>1</body></html>' },
        ]),
      );
      const res = await uploadFixture(env, zipPath, 'tester');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('EBADMANIFEST');
    }
  });
});

describe('annotation API', () => {
  const stroke = {
    tool: 'pen' as const,
    color: '#FF3B30',
    width: 4,
    points: [
      [10, 20],
      [40, 60],
    ],
  };

  it('round-trips strokes per (deck, user, slide)', async () => {
    const put = await env.app.inject({
      method: 'POST',
      url: '/api/decks/sample-stage-a/annotations/1',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ strokes: [stroke] }),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, count: 1 });

    const get = await env.app.inject({
      method: 'GET',
      url: '/api/decks/sample-stage-a/annotations/1',
      headers: { cookie: testerCookie },
    });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.strokes).toHaveLength(1);
    expect(body.strokes[0].color).toBe('#FF3B30');
  });

  it('appends additional strokes via PATCH', async () => {
    const patch = await env.app.inject({
      method: 'PATCH',
      url: '/api/decks/sample-stage-a/annotations/1',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        append: [
          {
            tool: 'highlighter',
            color: 'rgba(255,215,0,0.42)',
            width: 18,
            points: [
              [100, 100],
              [200, 100],
            ],
          },
        ],
      }),
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ ok: true, count: 2 });
  });

  it('rejects annotation writes outside the deck slide range', async () => {
    const zero = await env.app.inject({
      method: 'POST',
      url: '/api/decks/sample-stage-a/annotations/0',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ strokes: [stroke] }),
    });
    expect(zero.statusCode).toBe(400);

    const beyondTotal = await env.app.inject({
      method: 'POST',
      url: '/api/decks/sample-stage-a/annotations/5',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ strokes: [stroke] }),
    });
    expect(beyondTotal.statusCode).toBe(400);
    expect(beyondTotal.json().message).toContain('out of range');
  });

  it('rejects oversized annotation payloads', async () => {
    const tooMany = await env.app.inject({
      method: 'POST',
      url: '/api/decks/sample-stage-a/annotations/1',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        strokes: Array.from({ length: MAX_STROKES_PER_SLIDE + 1 }, () => stroke),
      }),
    });
    expect(tooMany.statusCode).toBe(400);

    const tooWide = await env.app.inject({
      method: 'POST',
      url: '/api/decks/sample-stage-a/annotations/1',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        strokes: [{ ...stroke, width: 10_000 }],
      }),
    });
    expect(tooWide.statusCode).toBe(400);
  });

  it('rejects appends that would exceed the per-slide stroke cap', async () => {
    const replace = await env.app.inject({
      method: 'POST',
      url: '/api/decks/sample-stage-a/annotations/2',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        strokes: Array.from({ length: MAX_STROKES_PER_SLIDE }, () => stroke),
      }),
    });
    expect(replace.statusCode).toBe(200);

    const append = await env.app.inject({
      method: 'PATCH',
      url: '/api/decks/sample-stage-a/annotations/2',
      headers: { cookie: testerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ append: [stroke] }),
    });
    expect(append.statusCode).toBe(413);
    expect(append.json().error).toBe('ETOOLARGE');
  });

  it('isolates annotations across users', async () => {
    const get = await env.app.inject({
      method: 'GET',
      url: '/api/decks/sample-stage-a/annotations/1',
      headers: { cookie: strangerCookie },
    });
    // Other user can't even read this deck.
    expect(get.statusCode).toBe(404);
  });
});
