/**
 * Deck-info editor coverage (Stage A.6).
 *
 * Three angles:
 *   1. Editing title / subtitle / author / description through the dialog
 *      auto-saves (debounced, 800ms), survives a reload, and updates the
 *      library card on /decks.
 *   2. Editing a slide's label flows into the manifest mirror and shows up
 *      in the Overview panel.
 *   3. Exporting after edits yields a .stage whose manifest.json carries
 *      the patched metadata — the whole point of "edit and export".
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
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

async function openInfoEditor(page: Page): Promise<void> {
  await page.goto(`/decks/${DECK_ID}`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');
  await page.getByTestId('edit-info-button').click();
  await expect(page.getByTestId('deck-info-editor')).toBeVisible();
}

test('edits to deck-level metadata auto-save and survive reload', async ({
  page,
}) => {
  await openInfoEditor(page);

  const titleInput = page.getByTestId('deck-info-title');
  const authorInput = page.getByTestId('deck-info-author');
  const descriptionInput = page.getByTestId('deck-info-description');

  await titleInput.fill('My Edited Deck');
  await authorInput.fill('Cursor Tester');
  await descriptionInput.fill('Description edited via the new dialog.');

  // Wait for the debounce flush to land — the status pill drops to "Saved".
  await expect(page.getByTestId('deck-info-status')).toHaveAttribute(
    'data-status',
    'saved',
    { timeout: 5_000 },
  );

  await page.getByTestId('deck-info-close').click();

  // Reload the viewer to make sure the changes round-tripped through the
  // server + manifest mirror.
  await page.reload();
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');
  await expect(
    page.locator('h2.deck-title'),
  ).toContainText('My Edited Deck');

  // The library page must also show the new title — that confirms the DB
  // column updated, not just the manifest blob. The card title sits in an
  // `<h3>` inside `.deck-card-meta`; targeting by class + role is stable.
  await page.goto('/decks');
  await expect(
    page.locator(`[data-testid="deck-card-${DECK_ID}"] .deck-card-meta h3`),
  ).toContainText('My Edited Deck');
});

test('slide-label edits flow into the Overview view', async ({ page }) => {
  await openInfoEditor(page);

  const label2 = page.getByTestId('deck-info-label-2');
  await label2.fill('Renamed Slide Two');
  await expect(page.getByTestId('deck-info-status')).toHaveAttribute(
    'data-status',
    'saved',
    { timeout: 5_000 },
  );
  await page.getByTestId('deck-info-close').click();

  // Open the Overview and check slide #2's caption shows the new label.
  await page.getByTestId('overview-button').click();
  await expect(page.getByTestId('overview-cell-2')).toContainText(
    'Renamed Slide Two',
  );
});

test('exported .stage reflects edited title and slide label', async ({
  page,
  context,
  request,
}) => {
  await openInfoEditor(page);
  await page.getByTestId('deck-info-title').fill('Export Title');
  await page.getByTestId('deck-info-label-1').fill('Export Slide One');
  await expect(page.getByTestId('deck-info-status')).toHaveAttribute(
    'data-status',
    'saved',
    { timeout: 5_000 },
  );
  await page.getByTestId('deck-info-close').click();

  // Fetch the export through the same auth context so we can read raw bytes.
  // Cookies are shared across `context.request` and `page.request`.
  const cookieHeader = (await context.cookies()).map(
    (c) => `${c.name}=${c.value}`,
  ).join('; ');
  const res = await request.get(
    `${API_BASE}/api/decks/${DECK_ID}/export`,
    { headers: { cookie: cookieHeader } },
  );
  expect(res.ok()).toBeTruthy();
  const body = await res.body();
  const zip = new AdmZip(body);
  const manifestEntry = zip.getEntry('manifest.json');
  expect(manifestEntry).toBeTruthy();
  const manifest = JSON.parse(manifestEntry!.getData().toString('utf8'));
  expect(manifest.title).toBe('Export Title');
  expect(manifest.slides[0].label).toBe('Export Slide One');
});
