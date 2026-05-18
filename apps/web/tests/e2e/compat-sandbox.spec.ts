/**
 * Trust model end-to-end check.
 *
 * Builds a tiny `.stage` package whose `manifest.json` declares
 * `compat.requires = ['same-origin-storage', 'window-open']`, uploads it, and
 * asserts the live slide iframe is rendered with the elevated sandbox token
 * set derived by `utils/iframeSandbox.ts`. Unknown / duplicate capabilities
 * supplied in the manifest are expected to be normalized away by the server.
 */
import AdmZip from 'adm-zip';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginE2EUser, type E2EAuth } from './auth-helper.js';
import { API_BASE } from './test-env.js';

const DECK_ID = 'compat-sandbox-deck';
const SLIDE_HTML =
  '<!doctype html><html><body><h1 data-testid="slide-title">Compat sandbox check</h1></body></html>';

function buildCompatDeckBuffer(): Buffer {
  const manifest = {
    schema: 'slidestage@1.0',
    id: DECK_ID,
    version: '1.0.0',
    title: 'Compat sandbox check',
    subtitle: null,
    author: null,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    architecture: 'multi-file',
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 1,
    slides: [
      {
        index: 1,
        id: 'slide-1',
        label: 'Slide 1',
        file: 'slides/01.html',
        thumbnail: null,
        notes: null,
      },
    ],
    fonts: [],
    tokens: {},
    assets: { totalSize: SLIDE_HTML.length, count: 1, files: [] },
    runtime: {
      presenterTools: 'platform',
      fallbackEntry: null,
      capabilities: [],
    },
    platform: { minSchemaVersion: '1.0', compatibleArchitectures: ['multi-file'] },
    provenance: {
      sourceKind: 'webcomponent-deck',
      conversionMode: 'wrap',
      sourceEntry: 'index.html',
      converter: { name: 'slides-deck-converter', version: '0.1.0' },
    },
    compat: {
      // includes an unknown capability + duplicate that the server should drop
      requires: [
        'window-open',
        'future-capability',
        'same-origin-storage',
        'window-open',
      ],
      notes: 'demo',
    },
    stats: {
      packedAt: '2026-01-01T00:00:00.000Z',
      packerVersion: 'e2e',
    },
  };

  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('slides/01.html', Buffer.from(SLIDE_HTML));
  return zip.toBuffer();
}

let auth: E2EAuth;
let zipPath: string;

test.beforeAll(() => {
  zipPath = path.join(os.tmpdir(), `${DECK_ID}.stage`);
  fs.writeFileSync(zipPath, buildCompatDeckBuffer());
});

test.afterAll(() => {
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* ignore */
  }
});

test.beforeEach(async ({ context, request }) => {
  auth = await loginE2EUser(context, request, 'e2e-compat-owner');
});

test('live deck iframe sandbox reflects manifest.compat.requires', async ({
  page,
  request,
}) => {
  // Idempotent cleanup so reruns start from a clean slate.
  await request
    .delete(`${API_BASE}/api/decks/${DECK_ID}`, {
      headers: { cookie: auth.cookie },
    })
    .catch(() => {});

  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(zipPath);
  await page.getByTestId('upload-submit').click();

  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));

  const iframe = page.locator('iframe[title="slide content"]').first();
  await expect(iframe).toBeVisible();
  const sandbox = await iframe.getAttribute('sandbox');
  expect(sandbox).not.toBeNull();
  const tokens = (sandbox ?? '').split(/\s+/).filter(Boolean).sort();
  expect(tokens).toEqual(
    [
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-same-origin',
      'allow-scripts',
    ].sort(),
  );

  // Server normalization: detail endpoint exposes only canonical capabilities.
  const detail = await request.get(`${API_BASE}/api/decks/${DECK_ID}`, {
    headers: { cookie: auth.cookie },
  });
  expect(detail.ok()).toBe(true);
  const body = await detail.json();
  expect(body.manifest.compat.requires).toEqual([
    'same-origin-storage',
    'window-open',
  ]);
  expect(body.manifest.provenance.sourceKind).toBe('webcomponent-deck');
});
