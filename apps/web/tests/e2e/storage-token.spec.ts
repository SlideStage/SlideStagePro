/**
 * E2E regression for the "uploaded slide tokens.css → 401" bug.
 *
 * The sample fixture is plain — slide HTML inlines its own `<style>` — so it
 * doesn't actually exercise the `../shared/tokens.css` path. We make sure the
 * bug really stays fixed by uploading a *custom* deck where each slide loads
 * an external stylesheet via `<link rel="stylesheet" href="../shared/tokens.css">`.
 * Then we open the viewer and verify:
 *
 *   1. The slide iframe URL carries `?t=<access-token>`.
 *   2. The cross-resource `../shared/tokens.css` request inside the sandboxed
 *      iframe returns 200 (not 401 / 404).
 *   3. The expected style actually applies (visual confirmation).
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loginE2EUser, type E2EAuth } from './auth-helper.js';
import { API_BASE } from './test-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let auth: E2EAuth;
let deckPath: string;
const DECK_ID = 'storage-token-regression';

test.beforeAll(() => {
  deckPath = buildTokensCssFixture();
});

test.beforeEach(async ({ context, request }) => {
  auth = await loginE2EUser(context, request, 'e2e-storage-token-owner');
  await request
    .delete(`${API_BASE}/api/decks/${DECK_ID}`, {
      headers: { cookie: auth.cookie },
    })
    .catch(() => {});
});

test('sandboxed slide iframe loads /storage subresources via ?t= token', async ({
  page,
}) => {
  // Collect every `/storage/*/shared/tokens.css` response. Using `page.on`
  // (instead of `page.waitForResponse` *after* navigation) guarantees we
  // don't race the iframe's own load — the response often lands within ms
  // of the parent navigation completing.
  const tokensCssResponses: { url: string; status: number; type: string }[] = [];
  const failedRequests: { url: string; error: string }[] = [];
  page.on('response', (resp) => {
    const url = resp.url();
    if (url.includes(`/storage/${DECK_ID}/shared/tokens.css`)) {
      tokensCssResponses.push({
        url,
        status: resp.status(),
        type: resp.headers()['content-type'] ?? '',
      });
    }
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes(`/storage/${DECK_ID}/`)) {
      failedRequests.push({
        url: req.url(),
        error: req.failure()?.errorText ?? 'unknown',
      });
    }
  });

  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));

  const iframeElem = page.locator('iframe[title="slide content"]').first();
  await expect(iframeElem).toHaveAttribute('src', /\?t=[^&"]+/);

  // Wait for the iframe to fetch the external stylesheet. Fail loud with
  // the captured network log if we caught a `requestfailed` event — that
  // typically means CSP, ORB, or auth dropped the response.
  await expect
    .poll(() => tokensCssResponses.length, {
      message: () =>
        `expected /storage/${DECK_ID}/shared/tokens.css to load; ` +
        `failed requests so far: ${JSON.stringify(failedRequests)}`,
      timeout: 8000,
    })
    .toBeGreaterThan(0);

  expect(failedRequests).toEqual([]);
  for (const r of tokensCssResponses) {
    expect(r.status, `tokens.css responded ${r.status} for ${r.url}`).toBe(200);
    expect(r.url).toMatch(/\?t=[^&]+/);
    expect(r.type).toMatch(/text\/css/);
  }

  // Sanity-check the imported style actually applied. The fixture sets
  // `--accent: #C04A1A` and paints `h1.tokens-heading` with `color: var(--accent)`.
  const iframe = page.frameLocator('iframe[title="slide content"]').first();
  await expect(iframe.locator('h1.tokens-heading')).toHaveCSS(
    'color',
    'rgb(192, 74, 26)',
  );
});

test('storage token URL grants access to anyone who possesses it (documented contract)', async ({
  context,
  request,
  page,
}) => {
  // Upload as user A.
  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));

  const iframeElem = page.locator('iframe[title="slide content"]').first();
  const srcAttr = await iframeElem.getAttribute('src');
  expect(srcAttr).toMatch(/\?t=/);
  const tokenA = new URL(`http://x${srcAttr}`).searchParams.get('t');
  expect(tokenA).toBeTruthy();

  // Switch identity to user B. User B never sees user A's deck in the
  // library (cross-user 404 on `/api/decks`), but the token URL is an
  // explicit grant — like a signed S3 link — so possession alone authorises
  // the read until expiry. Re-affirm that behaviour from a fresh, unrelated
  // user context AND from a fully logged-out context.
  await context.clearCookies();

  // Logged-out browser request via the token URL → 200.
  const loggedOutResp = await request.get(
    `${API_BASE}/storage/${DECK_ID}/shared/tokens.css?t=${encodeURIComponent(tokenA!)}`,
    { headers: {} },
  );
  expect(loggedOutResp.status()).toBe(200);
  expect(loggedOutResp.headers()['content-type']).toMatch(/text\/css/);

  // Logged-in-as-someone-else request via the token URL → still 200.
  await loginE2EUser(context, request, 'e2e-storage-token-stranger');
  const strangerResp = await request.get(
    `${API_BASE}/storage/${DECK_ID}/shared/tokens.css?t=${encodeURIComponent(tokenA!)}`,
  );
  expect(strangerResp.status()).toBe(200);

  // …but the SAME stranger WITHOUT the token URL gets 404 (uniform error so
  // they can't enumerate deck ids).
  const noTokenResp = await request.get(
    `${API_BASE}/storage/${DECK_ID}/shared/tokens.css`,
  );
  expect(noTokenResp.status()).toBe(404);
});

/* ----------------------- fixture builder ----------------------- */

/**
 * Synthesizes a tiny `.stage` package that exercises the
 * `../shared/tokens.css` reference. Reuses Node's zlib for `deflate-raw`
 * compression — no third-party dep, matches the scheme used by
 * `scripts/build-fixture.mjs`.
 */
function buildTokensCssFixture(): string {
  const out = path.join(os.tmpdir(), `slidestage-storage-token-${Date.now()}.stage`);

  const tokensCss = `
:root { --accent: #C04A1A; --paper: #FAFAFA; --ink: #1A1A1A; }
body { background: var(--paper); color: var(--ink); margin: 0; padding: 80px; font-family: sans-serif; }
h1.tokens-heading { color: var(--accent); font-size: 96px; }
`.trim();

  const slideHtml = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><title>Storage Token Regression</title>
<link rel="stylesheet" href="../shared/tokens.css">
</head><body>
<h1 class="tokens-heading">tokens.css via /storage/?t=</h1>
<p>If this heading is orange (#C04A1A), the external stylesheet loaded.</p>
</body></html>`;

  const manifest = {
    schema: 'slidestage@1.0',
    id: DECK_ID,
    version: '1.0.0',
    title: 'Storage Token Regression Deck',
    subtitle: 'iframe sandbox + tokens.css',
    author: 'e2e',
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    architecture: 'multi-file',
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 1,
    slides: [
      {
        index: 1,
        id: 'cover',
        label: 'Cover',
        file: 'slides/01-cover.html',
        thumbnail: null,
        notes: null,
      },
    ],
    fonts: [],
    tokens: {},
    assets: {
      totalSize: tokensCss.length,
      count: 1,
      files: [{ path: 'shared/tokens.css', size: tokensCss.length, type: 'style' }],
    },
    runtime: {
      presenterTools: 'platform',
      fallbackEntry: null,
      capabilities: ['keyboard-nav'],
    },
    platform: {
      minSchemaVersion: '1.0',
      compatibleArchitectures: ['multi-file'],
    },
    stats: {
      packedAt: '2026-01-01T00:00:00Z',
      packerVersion: 'storage-token-spec',
    },
  };

  const entries: { name: string; content: string | Buffer }[] = [
    { name: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
    { name: 'slides/01-cover.html', content: slideHtml },
    { name: 'shared/tokens.css', content: tokensCss },
  ];

  fs.writeFileSync(out, makeZip(entries));
  return out;
}

/* PKZip writer (deflate). Mirrors scripts/build-fixture.mjs but inlined so
 * this spec doesn't reach into the .mjs ESM module from a .ts/.spec context. */
function makeZip(entries: { name: string; content: string | Buffer }[]): Buffer {
  const localChunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const entryBuf = Buffer.concat([localHeader, nameBuf, compressed]);
    localChunks.push(entryBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHeader, nameBuf]));
    offset += entryBuf.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
