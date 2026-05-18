/**
 * Dual-window (presenter + audience) sync tests.
 *
 * Each test opens two Playwright pages in the same context. Same context →
 * same browser process → same origin → BroadcastChannel reaches both. We
 * never click "Open audience window" via window.open() because pop-up
 * windows are flaky to capture in headless Playwright; opening both URLs
 * directly in `context.newPage()` exercises the exact same sync path.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
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

async function openPair(
  context: BrowserContext,
): Promise<{ presenter: Page; audience: Page }> {
  const presenter = await context.newPage();
  await presenter.goto(`/decks/${DECK_ID}/presenter`);
  await expect(presenter.getByTestId('deck-counter')).toContainText('1 / 4');

  const audience = await context.newPage();
  await audience.goto(`/decks/${DECK_ID}/audience`);
  await expect(audience.getByTestId('audience-host')).toBeVisible();

  // Wait for the BroadcastChannel handshake to settle (audience-presenter-status
  // flips to "Linked"). We allow a beat for the snapshot to flow back.
  await expect(audience.getByTestId('audience-presenter-status')).toHaveText(
    /Linked/,
    { timeout: 5_000 },
  );
  await expect(presenter.getByTestId('audience-status')).toHaveText(/Live/);

  return { presenter, audience };
}

test('audience mirrors slide-index changes from presenter', async ({ context }) => {
  const { presenter, audience } = await openPair(context);

  await presenter.keyboard.press('ArrowRight');
  await expect(presenter.getByTestId('deck-counter')).toContainText('2 / 4');
  // Audience iframe src should switch to slide 2 — read the iframe URL.
  const audienceIframeSrc = async (): Promise<string | null> =>
    audience
      .locator('[data-testid="audience-stage-wrapper"] iframe[data-active="true"]')
      .getAttribute('src');
  await expect.poll(audienceIframeSrc, { timeout: 5_000 }).toContain('02-');

  await presenter.keyboard.press('End');
  await expect(presenter.getByTestId('deck-counter')).toContainText('4 / 4');
  await expect.poll(audienceIframeSrc).toContain('04-');

  await presenter.keyboard.press('Home');
  await expect.poll(audienceIframeSrc).toContain('01-');
});

test('pen strokes drawn on presenter appear on audience in real time', async ({
  context,
}) => {
  const { presenter, audience } = await openPair(context);

  // The right-dock collapses by default; reveal it first by hovering the
  // tools handle, then switch to pen and draw a diagonal stroke.
  await presenter.getByTestId('toolbar-handle').hover();
  await expect(presenter.getByTestId('presenter-toolbar')).toHaveAttribute(
    'data-expanded',
    'true',
  );
  await presenter.getByTestId('tool-pen').click();
  await expect(presenter.getByTestId('tool-pen')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const overlay = presenter.getByTestId('annotation-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('annotation overlay has no bounding box');
  const sx = box.x + box.width * 0.4;
  const sy = box.y + box.height * 0.3;
  const ex = box.x + box.width * 0.7;
  const ey = box.y + box.height * 0.6;

  await presenter.mouse.move(sx, sy);
  await presenter.mouse.down();
  await presenter.mouse.move(sx + 30, sy + 30, { steps: 4 });
  // While mid-drag the audience should already render a "draft" stroke.
  await expect(
    audience.locator(
      '[data-testid="annotation-overlay"] path[data-draft="external"]',
    ),
  ).toHaveCount(1, { timeout: 3_000 });

  await presenter.mouse.move(ex, ey, { steps: 6 });
  await presenter.mouse.up();

  // Once committed, presenter has a pen path and so does audience.
  await expect(
    presenter.locator('[data-testid="annotation-overlay"] path[data-tool="pen"]'),
  ).toHaveCount(1);
  await expect(
    audience.locator('[data-testid="annotation-overlay"] path[data-tool="pen"]'),
  ).toHaveCount(1, { timeout: 3_000 });

  // Audience draft path is gone.
  await expect(
    audience.locator(
      '[data-testid="annotation-overlay"] path[data-draft="external"]',
    ),
  ).toHaveCount(0);

  // Undo on presenter → stroke disappears on audience too.
  await presenter.keyboard.press('Control+KeyZ');
  await expect(
    audience.locator('[data-testid="annotation-overlay"] path[data-tool="pen"]'),
  ).toHaveCount(0, { timeout: 3_000 });
});

test('blackout & whiteout & spotlight tools propagate to audience', async ({
  context,
}) => {
  const { presenter, audience } = await openPair(context);

  // Blackout
  await presenter.keyboard.press('b');
  await expect(presenter.getByTestId('blackout')).toBeVisible();
  await expect(audience.getByTestId('blackout')).toBeVisible({ timeout: 3_000 });
  await presenter.keyboard.press('b');
  await expect(audience.getByTestId('blackout')).toBeHidden();

  // Whiteout
  await presenter.keyboard.press('w');
  await expect(audience.getByTestId('whiteout')).toBeVisible({ timeout: 3_000 });
  await presenter.keyboard.press('w');

  // Spotlight tool toggles the dimming overlay on both sides.
  await presenter.keyboard.press('Shift+S');
  await expect(audience.getByTestId('spotlight-overlay')).toBeVisible({
    timeout: 3_000,
  });
  await presenter.keyboard.press('Escape');
  await expect(audience.getByTestId('spotlight-overlay')).toBeHidden({
    timeout: 3_000,
  });
});

test('right-dock toolbar collapses by default and expands on hover', async ({
  context,
}) => {
  const presenter = await context.newPage();
  await presenter.goto(`/decks/${DECK_ID}/presenter`);
  await expect(presenter.getByTestId('deck-counter')).toContainText('1 / 4');

  const toolbar = presenter.getByTestId('presenter-toolbar');
  // Default state: collapsed (only the handle is visible).
  await expect(toolbar).toHaveAttribute('data-mode', 'right-dock');
  await expect(toolbar).toHaveAttribute('data-expanded', 'false');
  await expect(presenter.getByTestId('toolbar-handle')).toBeVisible();

  // Hovering the handle expands the dock with full tools + labels.
  await presenter.getByTestId('toolbar-handle').hover();
  await expect(toolbar).toHaveAttribute('data-expanded', 'true');
  await expect(presenter.getByTestId('tool-pen')).toBeVisible();

  // Clicking pen activates it while the dock is open.
  await presenter.getByTestId('tool-pen').click();
  await expect(presenter.getByTestId('tool-pen')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Move mouse far away → toolbar collapses even though pen remains active,
  // so the slide content is not covered while drawing.
  await presenter.mouse.move(50, 50);
  await presenter.waitForTimeout(800);
  await expect(toolbar).toHaveAttribute('data-expanded', 'false');
  await expect(presenter.getByTestId('active-tool-pill')).toContainText('Pen');

  // Reopen, switch to highlighter, and verify the collapsed active-tool pill
  // reflects the selected translucent highlighter color.
  await presenter.getByTestId('toolbar-handle').hover();
  await expect(toolbar).toHaveAttribute('data-expanded', 'true');
  await presenter.getByTestId('tool-highlighter').click();
  await presenter.getByTestId('color-4').click();
  await presenter.mouse.move(50, 50);
  await presenter.waitForTimeout(800);
  const activeToolPill = presenter.getByTestId('active-tool-pill');
  await expect(activeToolPill).toContainText('Highlighter');
  await expect(activeToolPill.locator('.active-tool-pill-color')).toHaveCSS(
    'background-color',
    'rgba(10, 132, 255, 0.42)',
  );

  // Esc returns to pointer and keeps the dock collapsed.
  await presenter.keyboard.press('Escape');
  await presenter.waitForTimeout(700);
  await expect(toolbar).toHaveAttribute('data-expanded', 'false');
  await expect(presenter.getByTestId('active-tool-pill')).toBeHidden();
});

test('presenter side and notes panels resize with drag handles', async ({
  context,
}) => {
  const presenter = await context.newPage();
  await presenter.goto(`/decks/${DECK_ID}/presenter`);
  await expect(presenter.getByTestId('deck-counter')).toContainText('1 / 4');

  const sidePanel = presenter.getByTestId('presenter-side');
  const sideHandle = presenter.getByTestId('presenter-side-resizer');
  const initialSideBox = await sidePanel.boundingBox();
  const sideHandleBox = await sideHandle.boundingBox();
  if (!initialSideBox || !sideHandleBox) {
    throw new Error('presenter side resize targets are missing');
  }

  await presenter.mouse.move(
    sideHandleBox.x + sideHandleBox.width / 2,
    sideHandleBox.y + sideHandleBox.height / 2,
  );
  await presenter.mouse.down();
  await presenter.mouse.move(
    sideHandleBox.x + sideHandleBox.width / 2 - 90,
    sideHandleBox.y + sideHandleBox.height / 2,
    { steps: 5 },
  );
  await presenter.mouse.up();
  await expect
    .poll(async () => (await sidePanel.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialSideBox.width + 50);

  const notesPanel = presenter.getByTestId('speaker-notes');
  const notesHandle = presenter.getByTestId('presenter-notes-resizer');
  const initialNotesBox = await notesPanel.boundingBox();
  const notesHandleBox = await notesHandle.boundingBox();
  if (!initialNotesBox || !notesHandleBox) {
    throw new Error('presenter notes resize targets are missing');
  }

  await presenter.mouse.move(
    notesHandleBox.x + notesHandleBox.width / 2,
    notesHandleBox.y + notesHandleBox.height / 2,
  );
  await presenter.mouse.down();
  await presenter.mouse.move(
    notesHandleBox.x + notesHandleBox.width / 2,
    notesHandleBox.y + notesHandleBox.height / 2 - 70,
    { steps: 5 },
  );
  await presenter.mouse.up();
  await expect
    .poll(async () => (await notesPanel.boundingBox())?.height ?? 0)
    .toBeGreaterThan(initialNotesBox.height + 40);
});

test('seeded annotations show up immediately in a freshly-opened audience window', async ({
  context,
  request,
}) => {
  // Pre-seed a stroke on slide 1 so we can see snapshot-on-join in action.
  await request.post(
    `${API_BASE}/api/decks/${DECK_ID}/annotations/1`,
    {
      headers: { cookie: auth.cookie, 'content-type': 'application/json' },
      data: {
        strokes: [
          {
            tool: 'pen',
            color: '#FF3B30',
            width: 12,
            cid: 'seed-stroke',
            points: [
              [100, 100],
              [800, 540],
              [1820, 980],
            ],
          },
        ],
      },
    },
  );

  const presenter = await context.newPage();
  await presenter.goto(`/decks/${DECK_ID}/presenter`);
  await expect(presenter.getByTestId('deck-counter')).toContainText('1 / 4');
  // Presenter renders the seeded stroke.
  await expect(
    presenter.locator(
      '[data-testid="annotation-overlay"] path[data-tool="pen"]',
    ),
  ).toHaveCount(1, { timeout: 5_000 });

  // Audience opens *after* presenter is already running and should receive
  // the seeded stroke via the snapshot handshake (or via its own initial
  // GET — either path is acceptable; we just want to see one stroke).
  const audience = await context.newPage();
  await audience.goto(`/decks/${DECK_ID}/audience`);
  await expect(audience.getByTestId('audience-host')).toBeVisible();
  await expect(
    audience.locator(
      '[data-testid="annotation-overlay"] path[data-tool="pen"]',
    ),
  ).toHaveCount(1, { timeout: 5_000 });
});
