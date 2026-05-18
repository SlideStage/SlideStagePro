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
    throw new Error(
      `Fixture missing at ${FIXTURE_PATH}. Run \`pnpm fixtures\` first.`,
    );
  }
});

test.beforeEach(async ({ page, request }) => {
  auth = await loginE2EUser(page.context(), request, 'e2e-shared-owner');

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

test('primary app chrome and deck actions render lucide icons', async ({ page }) => {
  await page.goto('/decks');

  await expect(page.locator('.brand-mark svg')).toBeVisible();
  await expect(page.locator('.app-nav a[href="/decks"] svg')).toBeVisible();
  await expect(page.getByTestId('upload-link').locator('svg.btn-icon')).toBeVisible();

  await expect(
    page.getByTestId(`deck-card-export-${DECK_ID}`).locator('svg.btn-icon'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /delete Slide Deck Packaging Demo/i }).locator(
      'svg.btn-icon',
    ),
  ).toBeVisible();
});

test('viewer, overview, notes, and presenter controls render icon buttons', async ({
  page,
}) => {
  await page.goto(`/decks/${DECK_ID}`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');

  await expect(page.getByRole('button', { name: 'back to library' }).locator('svg')).toBeVisible();
  await expect(page.getByRole('button', { name: 'previous slide' }).locator('svg')).toBeVisible();
  await expect(page.getByRole('button', { name: 'next slide' }).locator('svg')).toBeVisible();
  await expect(page.getByTestId('overview-button').locator('svg')).toBeVisible();
  await expect(page.getByTestId('speaker-button').locator('svg')).toBeVisible();
  await expect(page.getByTestId('export-button').locator('svg')).toBeVisible();
  await expect(page.getByTestId('present-button').locator('svg')).toBeVisible();

  await page.getByTestId('overview-button').click();
  await expect(page.getByTestId('overview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'close overview' }).locator('svg')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('speaker-button').click();
  await expect(page.getByTestId('notes-edit-toggle').locator('svg')).toBeVisible();
  await expect(page.getByTestId('notes-lock-hint').locator('svg')).toBeVisible();

  await page.getByTestId('present-button').click();
  await expect(page).toHaveURL(/\/presenter#1$/);
  await expect(page.getByRole('button', { name: 'back to viewer' }).locator('svg')).toBeVisible();
  await expect(page.getByTestId('open-audience').locator('svg')).toBeVisible();
  await expect(page.getByTestId('audience-status').locator('.status-dot')).toBeVisible();
});
