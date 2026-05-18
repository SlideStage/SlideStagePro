/**
 * Offline-mirror UX (Stage A.X).
 *
 * Verifies that a deck carrying `manifest.offline` round-trips through the
 * Pro server and surfaces an "Offline ready" / "Partial offline" badge in
 * both the library list and the viewer header.
 *
 * The test composes a minimal `.stage` archive on the fly (instead of
 * depending on a permanent fixture) so the offline branch can evolve
 * without dragging the canonical sample deck along with it.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import AdmZip from 'adm-zip';
import { Buffer } from 'node:buffer';
import { loginE2EUser, type E2EAuth } from './auth-helper.js';
import { API_BASE } from './test-env.js';

const READY_DECK_ID = 'offline-e2e-ready';
const PARTIAL_DECK_ID = 'offline-e2e-partial';

function buildManifest(opts: {
  id: string;
  ready: boolean;
  mirroredAssetPaths: string[];
  skippedUrls: Array<{ url: string; reason: string; detail?: string }>;
}): Record<string, unknown> {
  return {
    schema: 'slidestage@1.0',
    id: opts.id,
    version: '1.0',
    title: `Offline ${opts.ready ? 'Ready' : 'Partial'} Deck`,
    subtitle: null,
    author: null,
    description: null,
    createdAt: '2026-05-15T12:00:00.000Z',
    updatedAt: '2026-05-15T12:00:00.000Z',
    architecture: 'multi-file',
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 1,
    slides: [
      {
        index: 1,
        id: 'cover',
        label: 'Cover',
        file: 'slides/01.html',
        thumbnail: null,
        notes: null,
      },
    ],
    fonts: [],
    tokens: {},
    assets: {
      totalSize: opts.mirroredAssetPaths.length * 4,
      count: opts.mirroredAssetPaths.length,
      files: opts.mirroredAssetPaths.map((path) => ({
        path,
        size: 4,
        type: 'image',
      })),
    },
    runtime: {
      presenterTools: 'platform',
      fallbackEntry: null,
      capabilities: [],
    },
    platform: {
      minSchemaVersion: '1.0',
      compatibleArchitectures: ['multi-file'],
    },
    stats: { packedAt: '2026-05-15T12:00:00.000Z', packerVersion: 'e2e' },
    offline: {
      ready: opts.ready,
      mirroredAt: '2026-05-15T12:00:00.000Z',
      mirrorTool: { name: 'slidestage-mirror', version: '0.1.0' },
      policy: {
        includeScripts: false,
        includeIframes: false,
        maxAssetBytes: 50 * 1024 * 1024,
        maxTotalBytes: 500 * 1024 * 1024,
      },
      mirroredAssets: opts.mirroredAssetPaths.map((path, idx) => ({
        originalUrl: `https://images.example.com/asset-${idx + 1}.png`,
        path,
        contentHash: `sha256-${'a'.repeat(64)}`,
        contentType: 'image/png',
        bytes: 4,
        fetchedAt: '2026-05-15T12:00:00.000Z',
        referencedBy: [1],
      })),
      skippedUrls: opts.skippedUrls,
    },
  };
}

function buildZip(manifest: Record<string, unknown>, extra: Record<string, Buffer> = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  zip.addFile(
    'slides/01.html',
    Buffer.from('<html><body><h1>offline</h1></body></html>', 'utf8'),
  );
  for (const [path, bytes] of Object.entries(extra)) {
    zip.addFile(path, bytes);
  }
  return zip.toBuffer();
}

async function uploadDeck(
  request: APIRequestContext,
  cookie: string,
  filename: string,
  payload: Buffer,
): Promise<void> {
  const res = await request.post(`${API_BASE}/api/decks`, {
    headers: { cookie },
    multipart: {
      file: { name: filename, mimeType: 'application/zip', buffer: payload },
    },
  });
  if (!res.ok()) {
    throw new Error(`upload failed: ${res.status()} ${await res.text()}`);
  }
}

let auth: E2EAuth;

test.beforeEach(async ({ context, request }) => {
  auth = await loginE2EUser(context, request, 'e2e-offline-owner');
  for (const id of [READY_DECK_ID, PARTIAL_DECK_ID]) {
    await request
      .delete(`${API_BASE}/api/decks/${id}`, { headers: { cookie: auth.cookie } })
      .catch(() => {});
  }
});

test('renders an "Offline ready" badge on the library card and viewer header', async ({
  page,
  request,
}) => {
  const mirrorPath = 'assets/_mirror/img/ready.png';
  const manifest = buildManifest({
    id: READY_DECK_ID,
    ready: true,
    mirroredAssetPaths: [mirrorPath],
    skippedUrls: [],
  });
  const zip = buildZip(manifest, { [mirrorPath]: Buffer.from('PNG\x00', 'utf8') });
  await uploadDeck(request, auth.cookie, 'offline-ready.stage', zip);

  await page.goto('/decks');
  const card = page.getByTestId(`deck-card-offline-${READY_DECK_ID}`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-offline-ready', 'true');
  await expect(card).toContainText(/Offline ready/i);

  await page.goto(`/decks/${READY_DECK_ID}`);
  const badge = page.getByTestId('deck-offline-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-offline-ready', 'true');
  await expect(badge).toContainText(/Offline ready/i);
});

test('renders a "Partial offline" badge when skippedUrls are non-empty', async ({
  page,
  request,
}) => {
  const mirrorPath = 'assets/_mirror/img/partial.png';
  const manifest = buildManifest({
    id: PARTIAL_DECK_ID,
    ready: false,
    mirroredAssetPaths: [mirrorPath],
    skippedUrls: [
      {
        url: 'https://noise.example.com/script.js',
        reason: 'blocked-by-policy',
        detail: 'scripts are off by default',
      },
    ],
  });
  const zip = buildZip(manifest, { [mirrorPath]: Buffer.from('PNG\x00', 'utf8') });
  await uploadDeck(request, auth.cookie, 'offline-partial.stage', zip);

  await page.goto('/decks');
  const card = page.getByTestId(`deck-card-offline-${PARTIAL_DECK_ID}`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-offline-ready', 'false');
  await expect(card).toContainText(/Partial offline/i);

  await page.goto(`/decks/${PARTIAL_DECK_ID}`);
  const badge = page.getByTestId('deck-offline-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-offline-ready', 'false');
  await expect(badge).toContainText(/Partial offline/i);
});
