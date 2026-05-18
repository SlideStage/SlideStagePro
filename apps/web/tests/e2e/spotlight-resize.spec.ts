/**
 * Spotlight resize coverage.
 *
 * Verifies that the four input paths agreed on in the spec
 * (mouse wheel, `[` / `]`, toolbar slider, audience-side cross-window sync)
 * all converge on the same lattice (80 ↔ 480 px, step 16), persist across
 * reload via localStorage, and produce a visible size-pill confirmation.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loginE2EUser, type E2EAuth } from './auth-helper.js';
import { API_BASE } from './test-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'fixtures', 'out', 'sample.stage');

const DECK_ID = 'sample-stage-a';
let auth: E2EAuth;

test.beforeAll(() => {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error('Fixture missing — run `pnpm fixtures` first');
  }
});

test.beforeEach(async ({ context, request }) => {
  auth = await loginE2EUser(context, request, 'e2e-shared-owner');

  await request
    .delete(`${API_BASE}/api/decks/${DECK_ID}`, {
      headers: { cookie: auth.cookie },
    })
    .catch(() => {});

  const upload = await request.post(`${API_BASE}/api/decks`, {
    headers: { cookie: auth.cookie },
    multipart: {
      file: {
        name: 'sample.stage',
        mimeType: 'application/zip',
        buffer: fs.readFileSync(FIXTURE_PATH),
      },
    },
  });
  if (!upload.ok()) {
    throw new Error(
      `Fixture upload failed: ${upload.status()} ${await upload.text()}`,
    );
  }
});

/** Read the current radius the overlay was rendered with. */
async function readRadius(page: Page): Promise<number> {
  const raw = await page
    .getByTestId('spotlight-overlay')
    .getAttribute('data-spotlight-radius');
  if (!raw) throw new Error('spotlight overlay missing data-spotlight-radius');
  return Number(raw);
}

/**
 * Activate the spotlight tool and wait for the overlay to mount. The deck
 * must finish loading first — `Shift+S` is owned by `usePresenterShortcuts`
 * which only listens after the deck mounts.
 */
async function activateSpotlight(page: Page): Promise<void> {
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');
  await page.keyboard.press('Shift+S');
  await expect(page.getByTestId('spotlight-overlay')).toBeVisible();
}

test('bracket keys shrink and grow the spotlight in 16px steps and show the pill', async ({
  page,
}) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('slidestage.spotlight-radius');
    } catch {
      /* ignore */
    }
  });
  await page.goto(`/decks/${DECK_ID}`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');
  await activateSpotlight(page);

  await expect.poll(() => readRadius(page)).toBe(240);

  // ] grows by one STEP, [ shrinks by one STEP.
  await page.keyboard.press(']');
  await expect.poll(() => readRadius(page)).toBe(256);

  // The pill is fade-controlled by opacity, so we check the data-visible flag
  // rather than fighting Playwright's opacity-aware visibility check.
  await expect(page.getByTestId('spotlight-size-pill')).toHaveAttribute(
    'data-visible',
    'true',
  );
  await expect(page.getByTestId('spotlight-size-pill')).toContainText('256px');

  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect.poll(() => readRadius(page)).toBe(224);
});

test('mouse wheel over the stage adjusts the spotlight (and is clamped)', async ({
  page,
}) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('slidestage.spotlight-radius');
    } catch {
      /* ignore */
    }
  });
  await page.goto(`/decks/${DECK_ID}`);
  await activateSpotlight(page);

  const stage = page.getByTestId('deck-stage-wrapper');
  const box = await stage.boundingBox();
  if (!box) throw new Error('stage missing bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Park the cursor over the stage so the wheel event lands there.
  await page.mouse.move(cx, cy);

  // Scroll up (deltaY < 0) → grow. We send 3 small wheel events.
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => readRadius(page)).toBe(240 + 16 * 3);

  // Scroll down past the floor — clamp to MIN (80).
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 100);
  }
  await expect.poll(() => readRadius(page)).toBe(80);

  // …and back up past the ceiling — clamp to MAX (480).
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, -100);
  }
  await expect.poll(() => readRadius(page)).toBe(480);
});

test('toolbar slider sets the radius directly and persists via localStorage', async ({
  page,
}) => {
  // No addInitScript here: it would re-clear localStorage on `page.reload()`
  // below and defeat the very persistence we're verifying. Playwright gives
  // each test a fresh BrowserContext so localStorage starts empty anyway.
  await page.goto(`/decks/${DECK_ID}`);
  await activateSpotlight(page);

  // The single-window deck viewer uses the auto-hide bar; nudge the cursor
  // into the lower half so the bar reveals itself.
  const stage = page.getByTestId('deck-stage-wrapper');
  const box = await stage.boundingBox();
  if (!box) throw new Error('stage missing bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.85);

  const slider = page.getByTestId('spotlight-size-slider');
  await expect(slider).toBeVisible();

  // React-controlled inputs ignore direct `input.value =` because React
  // tracks the previous DOM value internally. Going through the prototype's
  // `value` setter is the standard workaround that makes React's
  // synthetic-onChange fire. Dragging the native thumb would also work but
  // is platform-specific to compute pixel coords for. We're testing the
  // controlled-component contract, not pointer math.
  await slider.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 128);
  await expect.poll(() => readRadius(page)).toBe(128);

  // Reload — localStorage should restore the new size on next mount.
  await page.reload();
  await activateSpotlight(page);
  await expect.poll(() => readRadius(page)).toBe(128);
});

test('presenter resizing the spotlight syncs to the audience window', async ({
  context,
}) => {
  const presenter = await context.newPage();
  await presenter.addInitScript(() => {
    try {
      window.localStorage.removeItem('slidestage.spotlight-radius');
    } catch {
      /* ignore */
    }
  });
  await presenter.goto(`/decks/${DECK_ID}/presenter`);
  await expect(presenter.getByTestId('deck-counter')).toContainText('1 / 4');

  const audience = await context.newPage();
  await audience.goto(`/decks/${DECK_ID}/audience`);
  await expect(audience.getByTestId('audience-presenter-status')).toHaveText(
    /Linked/,
    { timeout: 5_000 },
  );

  // Activate spotlight on presenter side — audience should mirror it.
  await presenter.keyboard.press('Shift+S');
  await expect(audience.getByTestId('spotlight-overlay')).toBeVisible({
    timeout: 3_000,
  });
  await expect.poll(() => readRadius(audience)).toBe(240);

  // Grow on the presenter — audience tracks the new value.
  await presenter.keyboard.press(']');
  await presenter.keyboard.press(']');
  await expect.poll(() => readRadius(presenter)).toBe(272);
  await expect.poll(() => readRadius(audience), { timeout: 3_000 }).toBe(272);

  // Shrink + the slider path — audience still matches.
  await presenter.keyboard.press('[');
  await expect.poll(() => readRadius(audience), { timeout: 3_000 }).toBe(256);
});
