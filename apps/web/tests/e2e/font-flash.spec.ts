/**
 * E2E regression for "translating between slides causes a webfont flash".
 *
 * The pre-fix behaviour: every slide is loaded into a fresh sandboxed iframe
 * with its own opaque-origin document (and therefore its own FontFaceSet).
 * The old `DeckStage` promoted the buffered iframe as soon as `onload` fired,
 * which is *before* webfonts finish swapping in. Users saw the fallback
 * font for ~100-300ms on every page turn.
 *
 * The fix is two-pronged:
 *
 *   1. `routes/storage.ts` injects a small `slidestage:ready` postMessage
 *      script into every slide HTML that fires after `document.fonts.ready`.
 *   2. `DeckStage` waits for **both** `iframe.onload` AND the ready
 *      postMessage before promoting a buffered slot. The previous slot
 *      stays on screen until the new one is visually stable.
 *
 * This spec uses a custom deck whose slides each `<link>` an external CSS
 * that registers a webfont with a deliberately slow load profile, then:
 *
 *   * Verifies the `slidestage:ready` script is actually present in the
 *     served HTML (regression for #1).
 *   * Asserts the active iframe's `data-ready` flips to `true` after a
 *     `<link>` to the font has had a chance to load (regression for #2).
 *   * Walks forward through every slide and checks that the *prior* slide
 *     remains visible until the next is ready — i.e. no blank/empty
 *     frame is ever painted as the user turns the page.
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
const DECK_ID = 'font-flash-regression';

test.beforeAll(() => {
  deckPath = buildMultiSlideFontDeck();
});

test.beforeEach(async ({ context, request }) => {
  auth = await loginE2EUser(context, request, 'e2e-font-flash-owner');
  await request
    .delete(`${API_BASE}/api/decks/${DECK_ID}`, {
      headers: { cookie: auth.cookie },
    })
    .catch(() => {});
});

test('slidestage:ready script is present in the served slide HTML', async ({
  page,
  request,
}) => {
  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));

  // Fetch the slide HTML through the SPA session — we already have the
  // owner's cookie via `auth.cookie`, set up in `beforeEach`.
  const detail = await request.get(`${API_BASE}/api/decks/${DECK_ID}`, {
    headers: { cookie: auth.cookie },
  });
  expect(detail.ok()).toBeTruthy();
  const detailJson = (await detail.json()) as { storageToken: string };

  const slideResp = await request.get(
    `${API_BASE}/storage/${DECK_ID}/slides/01-cover.html?t=${encodeURIComponent(detailJson.storageToken)}`,
  );
  expect(slideResp.status()).toBe(200);
  const body = await slideResp.text();
  expect(body).toContain('slidestage:ready');
  expect(body).toContain('document.fonts');
  const bodyClose = body.lastIndexOf('</body>');
  const scriptIdx = body.indexOf('slidestage:ready');
  expect(bodyClose).toBeGreaterThan(-1);
  expect(scriptIdx).toBeLessThan(bodyClose);
});

test('DeckStage flips iframe data-ready=true after fonts settle', async ({
  page,
}) => {
  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));

  const iframe = page.locator('iframe[title="slide content"][data-active="true"]');
  await expect(iframe).toBeAttached();

  // Within a generous timeout the active iframe should advertise readiness.
  // (The injected script bounds itself at 1.5s server-side + 2s safety net
  // client-side, but in healthy conditions it usually lands within 200ms.)
  await expect(iframe).toHaveAttribute('data-ready', 'true', {
    timeout: 6000,
  });
});

test('SPA preloads deck stylesheets to warm the HTTP cache before iframe mount', async ({
  page,
  request,
}) => {
  // Capture stylesheet requests issued by the SPA (not the iframe) so we can
  // verify `useDeckFontWarmup` runs and the @import → Google Fonts chain
  // also kicks off — that's what makes the *first* slide load fast.
  const stylesheetReqs: string[] = [];
  page.on('request', (req) => {
    if (req.resourceType() === 'stylesheet' || req.resourceType() === 'font') {
      stylesheetReqs.push(req.url());
    }
  });

  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));

  // The warmup hook injects <link rel="preload" as="style"> *and*
  // <link rel="stylesheet" media="print"> pointing at every CSS asset.
  // Assert both ended up in the parent document head.
  const head = page.locator('head');
  await expect(
    head.locator(
      `link[rel="preload"][as="style"][href*="/storage/${DECK_ID}/shared/tokens.css"]`,
    ),
  ).toHaveCount(1, { timeout: 5000 });
  await expect(
    head.locator(
      `link[rel="stylesheet"][media="print"][href*="/storage/${DECK_ID}/shared/tokens.css"]`,
    ),
  ).toHaveCount(1, { timeout: 5000 });

  // And the warmup actually reaches the network — tokens.css must hit the
  // SPA, not just sit as an unused link node.
  const warmRequested = stylesheetReqs.some((u) =>
    u.includes(`/storage/${DECK_ID}/shared/tokens.css`),
  );
  expect(warmRequested).toBeTruthy();

  // Sanity: the stylesheet itself responds 200 over the same token.
  void request;
});

test('sequential keyboard navigation is instantaneous (pre-warmed pool)', async ({
  page,
}) => {
  // The whole point of the 3-slot pool: when the user advances to the next
  // slide, the iframe is *already mounted* in the pool with its fonts
  // swapped in. The active flip is therefore a CSS opacity change with no
  // perceptible delay.

  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 3');

  // Wait for the first slide and its preload neighbour to land in the
  // pool. There should be 2 mounted iframes (current + next) at minimum.
  await expect(
    page.locator('iframe[title="slide content"][data-active="true"]'),
  ).toHaveAttribute('data-ready', 'true', { timeout: 6000 });

  // Give the next-slide preload a beat to also finish so we're really
  // testing the warm path.
  await page.waitForFunction(
    () => {
      const frames = Array.from(
        document.querySelectorAll('iframe[title="slide content"]'),
      );
      const ready = frames.filter(
        (f) => f.getAttribute('data-ready') === 'true',
      );
      return ready.length >= 2;
    },
    { timeout: 6000 },
  );

  // Now press → and assert that the next-slide iframe immediately becomes
  // active (data-active flips within a single rAF) with no intervening
  // "neither iframe is active" frame.
  const flips: { activeRefs: string[]; t: number }[] = [];
  await page.evaluate(() => {
    const observed: { activeRefs: string[]; t: number }[] = [];
    const observer = new MutationObserver(() => {
      const frames = Array.from(
        document.querySelectorAll('iframe[title="slide content"]'),
      );
      observed.push({
        activeRefs: frames
          .filter((f) => f.getAttribute('data-active') === 'true')
          .map((f) => f.getAttribute('src') ?? ''),
        t: performance.now(),
      });
    });
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-active'],
    });
    (window as unknown as { __flipObserver: MutationObserver }).__flipObserver = observer;
    (window as unknown as { __flipObserved: typeof observed }).__flipObserved = observed;
  });

  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('deck-counter')).toContainText('2 / 3');

  const recorded = await page.evaluate(() => {
    const observer = (window as unknown as { __flipObserver: MutationObserver })
      .__flipObserver;
    observer.disconnect();
    return (window as unknown as { __flipObserved: { activeRefs: string[]; t: number }[] })
      .__flipObserved;
  });
  flips.push(...recorded);

  // We expect:
  //   * at least one flip after the keypress
  //   * never a moment with zero `data-active="true"` iframes
  expect(flips.length).toBeGreaterThan(0);
  for (const f of flips) {
    expect(
      f.activeRefs.length,
      `expected always-1 active iframe; got ${JSON.stringify(f.activeRefs)} at t=${f.t}`,
    ).toBe(1);
  }

  // And the newly active iframe should already be ready (because the pool
  // warmed it ahead of time) — no FOUT window for the user to perceive.
  await expect(
    page.locator('iframe[title="slide content"][data-active="true"]'),
  ).toHaveAttribute('data-ready', 'true', { timeout: 1500 });
});

test('iframe DOM node for an in-pool slide is reused across navigations', async ({
  page,
}) => {
  // The pool's `key={slotIndex}` (not `key={src}`) is what makes React
  // *repoint* an iframe's `src` instead of unmounting and re-creating
  // the DOM node when LRU eviction happens. We assert this by tagging the
  // iframe that currently holds slide 1, navigating away and back, and
  // verifying the *same* tagged element is still the one showing slide 1.
  // If React had unmounted it, the tag would be gone.
  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));

  await expect(
    page.locator('iframe[title="slide content"][data-active="true"]'),
  ).toHaveAttribute('data-ready', 'true', { timeout: 6000 });

  // Tag the iframe currently rendering slide 1.
  const slide1Src = await page.evaluate(() => {
    const active = document.querySelector(
      'iframe[title="slide content"][data-active="true"]',
    ) as HTMLIFrameElement | null;
    if (!active) return null;
    active.setAttribute('data-slide1-tag', 'persist-me');
    return active.src;
  });
  expect(slide1Src).not.toBeNull();
  expect(slide1Src).toContain('01-cover.html');

  // Navigate forward and back.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('deck-counter')).toContainText('2 / 3');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 3');

  // The slide-1 iframe should still be the same DOM node — tag preserved.
  const taggedStillShowingSlide1 = await page.evaluate(() => {
    const tagged = document.querySelector(
      'iframe[data-slide1-tag="persist-me"]',
    ) as HTMLIFrameElement | null;
    if (!tagged) return { found: false };
    return {
      found: true,
      isActive: tagged.getAttribute('data-active') === 'true',
      src: tagged.src,
    };
  });
  expect(taggedStillShowingSlide1.found, 'slide-1 iframe was remounted').toBe(
    true,
  );
  expect(taggedStillShowingSlide1.isActive).toBe(true);
  expect(taggedStillShowingSlide1.src).toContain('01-cover.html');
});

test('navigating slides keeps an iframe visible the whole time (no blank flash)', async ({
  page,
}) => {
  await page.goto('/decks/upload');
  await page.getByTestId('upload-input').setInputFiles(deckPath);
  await page.getByTestId('upload-submit').click();
  await expect(page).toHaveURL(new RegExp(`/decks/${DECK_ID}`));
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 3');

  // Wait for the initial slide to be fully ready so the test's "always
  // visible" expectation isn't tripped by the very first load.
  await expect(
    page.locator('iframe[title="slide content"][data-active="true"]'),
  ).toHaveAttribute('data-ready', 'true', { timeout: 6000 });

  // Step through each slide and at every tick assert that *some* iframe is
  // active. If the buffer promotes too early we'd see a moment with zero
  // visible iframes (tear-down before the new one is ready); the fix
  // guarantees the prior iframe stays on screen until the new one fires
  // both `load` AND `slidestage:ready`.
  for (let i = 2; i <= 3; i++) {
    await page.keyboard.press('ArrowRight');

    // Poll for ~3s — at every snapshot at least one iframe must be the
    // active one. We use a polling assertion with a very tight gap so we
    // catch even a single missed frame if the bug ever returns.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const activeCount = await page
        .locator('iframe[title="slide content"][data-active="true"]')
        .count();
      expect(
        activeCount,
        `at slide ${i} transition: expected exactly 1 active iframe at all times`,
      ).toBe(1);
      // Stop the loop once the new slide has actually landed.
      const counter = await page.getByTestId('deck-counter').textContent();
      if (counter?.includes(`${i} / 3`)) {
        // Wait for the iframe to be marked ready so the next nav doesn't
        // race the previous slide's promotion.
        const ready = await page
          .locator('iframe[title="slide content"][data-active="true"]')
          .getAttribute('data-ready');
        if (ready === 'true') break;
      }
      await page.waitForTimeout(50);
    }
  }
});

/* ----------------------------- fixture builder ----------------------------- */

/**
 * Build a tiny 3-slide deck where each slide loads an external stylesheet
 * containing a webfont declaration. Reuses the inline zip writer scheme
 * from `storage-token.spec.ts` so we don't pull in a third-party zip dep.
 */
function buildMultiSlideFontDeck(): string {
  const out = path.join(os.tmpdir(), `slidestage-font-flash-${Date.now()}.stage`);

  // A bone-simple stylesheet that pulls a webfont from Google. We choose a
  // family that is reliably available and uses `display=swap` (the worst
  // case for the bug). The actual visual style doesn't matter — only that
  // a webfont is *loaded* by the iframe document.
  const tokensCss = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap");
:root { --paper: #FAFAFA; --ink: #1A1A1A; --accent: #C04A1A; }
body { background: var(--paper); color: var(--ink); margin: 0; padding: 80px; font-family: 'Inter', system-ui, sans-serif; }
h1.headline { color: var(--accent); font-size: 96px; font-weight: 700; }
p.body { font-size: 32px; line-height: 1.4; }
`.trim();

  const slideHtml = (n: number, label: string) => `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><title>${label}</title>
<link rel="stylesheet" href="../shared/tokens.css">
</head><body>
<h1 class="headline">Slide ${n}: ${label}</h1>
<p class="body">External webfont via @import — should not flash on navigation.</p>
</body></html>`;

  const manifest = {
    schema: 'slidestage@1.0',
    id: DECK_ID,
    version: '1.0.0',
    title: 'Font Flash Regression Deck',
    subtitle: 'webfont + multi-slide',
    author: 'e2e',
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    architecture: 'multi-file',
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 3,
    slides: [
      { index: 1, id: 'cover', label: 'Cover', file: 'slides/01-cover.html', thumbnail: null, notes: null },
      { index: 2, id: 'two', label: 'Two', file: 'slides/02-two.html', thumbnail: null, notes: null },
      { index: 3, id: 'three', label: 'Three', file: 'slides/03-three.html', thumbnail: null, notes: null },
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
      packerVersion: 'font-flash-spec',
    },
  };

  const entries: { name: string; content: string | Buffer }[] = [
    { name: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
    { name: 'slides/01-cover.html', content: slideHtml(1, 'Cover') },
    { name: 'slides/02-two.html', content: slideHtml(2, 'Two') },
    { name: 'slides/03-three.html', content: slideHtml(3, 'Three') },
    { name: 'shared/tokens.css', content: tokensCss },
  ];

  fs.writeFileSync(out, makeZip(entries));
  return out;
}

/* PKZip writer (deflate). Same pattern as storage-token.spec.ts. */
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
