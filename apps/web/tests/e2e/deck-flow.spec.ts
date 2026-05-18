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
let auth: E2EAuth;

test.beforeAll(() => {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `Fixture missing at ${FIXTURE_PATH}. Run \`pnpm fixtures\` first.`,
    );
  }
});

test.beforeEach(async ({ context, request }) => {
  auth = await loginE2EUser(context, request, 'e2e-shared-owner');
});

test('full deck flow: upload → list → view → navigate → overview → speaker view', async ({
  page,
  request,
}) => {
  // Best-effort cleanup so the test is idempotent.
  await request
    .delete(`${API_BASE}/api/decks/sample-stage-a`, {
      headers: { cookie: auth.cookie },
    })
    .catch(() => {});

  // 1. land on library
  await page.goto('/decks');
  await expect(page.locator('h1')).toContainText('Library');

  // 2. upload page
  await page.getByTestId('upload-link').click();
  await expect(page).toHaveURL(/\/decks\/upload$/);

  await page.getByTestId('upload-input').setInputFiles(FIXTURE_PATH);
  await page.getByTestId('upload-submit').click();

  // 3. lands on viewer
  await expect(page).toHaveURL(/\/decks\/sample-stage-a/);

  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');
  await expect(page.locator('h2.deck-title')).toContainText(
    'Slide Deck Packaging Demo',
  );

  // iframe content visible
  const iframe = page.frameLocator('iframe[title="slide content"]').first();
  await expect(iframe.locator('h1')).toContainText('Slide Deck Packaging Demo');

  // 4. keyboard nav forward
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('deck-counter')).toContainText('2 / 4');
  await expect(page).toHaveURL(/#2$/);

  await page.keyboard.press('Space');
  await expect(page.getByTestId('deck-counter')).toContainText('3 / 4');

  await page.keyboard.press('End');
  await expect(page.getByTestId('deck-counter')).toContainText('4 / 4');

  await page.keyboard.press('Home');
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');

  // jump-to digit
  await page.keyboard.press('3');
  await expect(page.getByTestId('deck-counter')).toContainText('3 / 4');

  // 5. overview
  await page.keyboard.press('o');
  await expect(page.getByTestId('overview')).toBeVisible();
  await expect(page.getByTestId('overview-cell-2')).toBeVisible();
  await page.getByTestId('overview-cell-2').click();
  await expect(page.getByTestId('overview')).toBeHidden();
  await expect(page.getByTestId('deck-counter')).toContainText('2 / 4');

  // 6. speaker view
  await page.keyboard.press('s');
  const speakerNotes = page.getByTestId('speaker-notes');
  await expect(speakerNotes).toBeVisible();
  // Slide 2 has notes per fixture.
  await expect(speakerNotes).toContainText('这一页讲三个要点');

  await page.keyboard.press('s');
  await expect(speakerNotes).toBeHidden();

  // 7. back to library — deck card present
  await page.goto('/decks');
  const deckCard = page.getByTestId('deck-card-sample-stage-a');
  await expect(deckCard).toBeVisible();
  // Thumbnail URL carries `?t=<access-token>` so the sandboxed slide-preview
  // iframes (which can't send the session cookie) can authenticate.
  await expect(deckCard.locator('.deck-card-cover')).toHaveAttribute(
    'src',
    /\/storage\/sample-stage-a\/thumbnails\/01\.png(\?t=[^"]+)?$/,
  );
});

test('library shows error when uploading a non-zip file', async ({ page }) => {
  await page.goto('/decks/upload');
  // create a small bogus file on the fly via the page
  const tmpFile = path.join(REPO_ROOT, 'fixtures', 'out', 'not-a-zip.stage');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, 'this is plain text, not a zip');

  await page.getByTestId('upload-input').setInputFiles(tmpFile);
  await page.getByTestId('upload-submit').click();
  await expect(page.getByTestId('upload-error')).toBeVisible();
});
