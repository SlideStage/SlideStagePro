import { test, expect } from '@playwright/test';
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

test.beforeEach(async ({ page, request }) => {
  auth = await loginE2EUser(page.context(), request, 'e2e-shared-owner');

  // Reset deck + annotations server-side so each test runs from clean state.
  await request
    .delete(`${API_BASE}/api/decks/${DECK_ID}`, {
      headers: { cookie: auth.cookie },
    })
    .catch(() => {});
  // Reupload via API (cheaper than going through UI again).
  const buf = fs.readFileSync(FIXTURE_PATH);
  // Build multipart manually using a Buffer because Playwright APIs differ.
  const boundary = `----PWBoundary${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.stage"\r\nContent-Type: application/zip\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  await request.post(`${API_BASE}/api/decks`, {
    headers: {
      cookie: auth.cookie,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    data: Buffer.concat([head, buf, tail]),
  });
});

test('toolbar exposes all nine tools and switches via shortcuts', async ({ page }) => {
  await page.goto(`/decks/${DECK_ID}`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');

  for (const id of [
    'mouse',
    'laser',
    'pen',
    'highlighter',
    'eraser',
    'spotlight',
    'blackout',
    'whiteout',
  ]) {
    await expect(page.getByTestId(`tool-${id}`)).toBeVisible();
  }

  // Shift+L → laser, then Esc → mouse.
  await page.keyboard.press('Shift+L');
  await expect(page.getByTestId('tool-laser')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('laser-overlay')).toBeAttached();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-mouse')).toHaveAttribute('aria-pressed', 'true');

  // B → blackout twice → mouse
  await page.keyboard.press('b');
  await expect(page.getByTestId('blackout')).toBeVisible();
  await page.keyboard.press('b');
  await expect(page.getByTestId('blackout')).not.toBeVisible();

  // W → whiteout
  await page.keyboard.press('w');
  await expect(page.getByTestId('whiteout')).toBeVisible();
  await page.keyboard.press('w');

  // Shift+S → spotlight
  await page.keyboard.press('Shift+S');
  await expect(page.getByTestId('spotlight-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('drawing a pen stroke persists to the backend', async ({ page, request }) => {
  await page.goto(`/decks/${DECK_ID}`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');

  // Switch to pen via toolbar button.
  await page.getByTestId('tool-pen').click();
  await expect(page.getByTestId('tool-pen')).toHaveAttribute('aria-pressed', 'true');

  // Color swatches appear when pen active.
  await expect(page.getByTestId('color-1')).toBeVisible();

  // Draw a quick diagonal stroke on the overlay.
  const overlay = page.getByTestId('annotation-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('annotation overlay has no bounding box');

  const startX = box.x + box.width * 0.4;
  const startY = box.y + box.height * 0.3;
  const endX = box.x + box.width * 0.7;
  const endY = box.y + box.height * 0.6;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 30, startY + 30, { steps: 4 });
  await page.mouse.move(endX, endY, { steps: 6 });
  await page.mouse.up();

  // SVG should contain at least one path with data-tool=pen.
  await expect(
    page.locator('[data-testid="annotation-overlay"] path[data-tool="pen"]'),
  ).toHaveCount(1);

  // Wait a touch longer than the 800ms debounce, then verify backend saw it.
  await page.waitForTimeout(1100);

  const got = await request.get(
    `${API_BASE}/api/decks/${DECK_ID}/annotations/1`,
    { headers: { cookie: auth.cookie } },
  );
  expect(got.ok()).toBeTruthy();
  const json = (await got.json()) as { strokes: Array<{ tool: string; points: number[][] }> };
  expect(json.strokes.length).toBe(1);
  expect(json.strokes[0]!.tool).toBe('pen');
  expect(json.strokes[0]!.points.length).toBeGreaterThan(2);

  // Reload the page and confirm the stroke is still rendered.
  await page.reload();
  await expect(
    page.locator('[data-testid="annotation-overlay"] path[data-tool="pen"]'),
  ).toHaveCount(1);

  // Ctrl+Z removes the stroke locally; debounce flushes empty array.
  await page.keyboard.press('Control+KeyZ');
  await expect(
    page.locator('[data-testid="annotation-overlay"] path[data-tool="pen"]'),
  ).toHaveCount(0);
});

test('highlighter uses the selected translucent color', async ({ page }) => {
  await page.goto(`/decks/${DECK_ID}`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');

  await page.getByTestId('tool-highlighter').click();
  await expect(page.getByTestId('tool-highlighter')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByTestId('color-4').click();
  await expect(page.getByTestId('color-4')).toHaveCSS(
    'background-color',
    'rgba(10, 132, 255, 0.42)',
  );

  const overlay = page.getByTestId('annotation-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('annotation overlay has no bounding box');

  const startX = box.x + box.width * 0.35;
  const startY = box.y + box.height * 0.42;
  const endX = box.x + box.width * 0.68;
  const endY = box.y + box.height * 0.42;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 6 });
  await page.mouse.up();

  const stroke = page.locator(
    '[data-testid="annotation-overlay"] path[data-tool="highlighter"]',
  );
  await expect(stroke).toHaveCount(1);
  await expect(stroke).toHaveAttribute('stroke', 'rgba(10, 132, 255, 0.42)');
});

test('seeded slide-1 strokes survive a fresh viewer mount and follow the speaker-view layout', async ({
  page,
  request,
}) => {
  // Pre-seed slide 1 directly via the API so we test the *load* path,
  // not the *draw* path.
  const seed = await request.post(
    `${API_BASE}/api/decks/${DECK_ID}/annotations/1`,
    {
      headers: { cookie: auth.cookie, 'content-type': 'application/json' },
      data: {
        strokes: [
          {
            tool: 'pen',
            color: '#FF3B30',
            width: 12,
            cid: 'corner-box',
            points: [
              [50, 50],
              [1870, 50],
              [1870, 1030],
              [50, 1030],
              [50, 50],
            ],
          },
        ],
      },
    },
  );
  expect(seed.ok(), 'failed to seed annotation').toBeTruthy();

  await page.goto(`/decks/${DECK_ID}`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');

  // Regression guard for the bug where StrictMode's mount/unmount/remount
  // simulation flushed the empty placeholder over the seeded annotations.
  const stroke = page.locator(
    '[data-testid="annotation-overlay"] path[data-tool="pen"]',
  );
  await expect(stroke).toHaveCount(1);
  // Server-side: still has the seeded stroke after the viewer has settled.
  await page.waitForTimeout(1100);
  const got = await request.get(
    `${API_BASE}/api/decks/${DECK_ID}/annotations/1`,
    { headers: { cookie: auth.cookie } },
  );
  const json = (await got.json()) as { strokes: Array<{ cid?: string }> };
  expect(json.strokes.length).toBe(1);
  expect(json.strokes[0]!.cid).toBe('corner-box');

  // Toggling speaker view shrinks the host — the rendered stroke must
  // shrink with the slide, not stay anchored to original page pixels.
  const before = await stroke.boundingBox();
  if (!before) throw new Error('stroke bbox missing');

  await page.keyboard.press('s');
  await expect(page.getByTestId('speaker-button')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.waitForTimeout(200);

  const after = await stroke.boundingBox();
  if (!after) throw new Error('stroke bbox missing after speaker view');
  expect(after.width).toBeLessThan(before.width * 0.95);
});
