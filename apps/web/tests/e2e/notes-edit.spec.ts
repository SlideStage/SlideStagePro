import { test, expect } from '@playwright/test';
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
    throw new Error(
      `Fixture missing at ${FIXTURE_PATH}. Run \`pnpm fixtures\` first.`,
    );
  }
});

test.beforeEach(async ({ context, request }) => {
  auth = await loginE2EUser(context, request, 'e2e-shared-owner');
});

async function ensureDeckUploaded(request: import('@playwright/test').APIRequestContext): Promise<void> {
  // Idempotent: try to fetch the deck; if 404, upload it.
  const probe = await request.get(`${API_BASE}/api/decks/${DECK_ID}`, {
    headers: { cookie: auth.cookie },
  });
  if (probe.ok()) return;

  const buf = fs.readFileSync(FIXTURE_PATH);
  await request.post(`${API_BASE}/api/decks`, {
    headers: { cookie: auth.cookie },
    multipart: {
      file: {
        name: 'sample.stage',
        mimeType: 'application/zip',
        buffer: buf,
      },
    },
  });
}

test('edit speaker notes → autosaves → survives reload → export zips edited notes', async ({
  page,
  request,
}) => {
  await ensureDeckUploaded(request);

  // 1. Open the deck viewer.
  await page.goto(`/decks/${DECK_ID}#1`);
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');

  // 2. Open the speaker side-panel.
  await page.getByTestId('speaker-button').click();
  const speakerPanel = page.getByTestId('speaker-panel');
  await expect(speakerPanel).toBeVisible();

  // 3. Editor starts locked — read-only `<pre>` is visible, textarea is not.
  await expect(
    speakerPanel.getByTestId('editable-notes-readonly'),
  ).toBeVisible();
  await expect(
    speakerPanel.getByTestId('editable-notes-textarea'),
  ).toHaveCount(0);
  // 3a. Click "Edit ✎" to unlock.
  await speakerPanel.getByTestId('notes-edit-toggle').click();
  const textarea = speakerPanel.getByTestId('editable-notes-textarea');
  await expect(textarea).toBeVisible();

  // 4. Type a fresh note for slide 1.
  const newNote = `E2E updated note for slide 1 — ${Date.now()}`;
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await textarea.fill(newNote);

  // 5. Wait for autosave: status pill cycles dirty → saving → saved.
  const status = speakerPanel.getByTestId('notes-status');
  await expect(status).toHaveAttribute('data-state', 'saved', { timeout: 4000 });

  // 6. Press Esc to exit Edit mode — textarea swaps back to the read-only view.
  await textarea.press('Escape');
  await expect(
    speakerPanel.getByTestId('editable-notes-textarea'),
  ).toHaveCount(0);
  await expect(
    speakerPanel.getByTestId('editable-notes-readonly'),
  ).toContainText(newNote);

  // 7. Reload the page; reopen speaker view; the note should still be there
  //    (in the read-only view — Edit mode resets on reload).
  await page.reload();
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');
  await page.getByTestId('speaker-button').click();
  await expect(
    page.getByTestId('speaker-panel').getByTestId('editable-notes-readonly'),
  ).toContainText(newNote);

  // 8. Click "Export ↓" — capture the download.
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-button').click();
  const dl = await downloadPromise;
  const dlPath = await dl.path();
  expect(dlPath).toBeTruthy();

  // 9. Open the zip and verify manifest carries the edited note.
  const zip = new AdmZip(dlPath as string);
  const manifestEntry = zip.getEntry('manifest.json');
  expect(manifestEntry).toBeTruthy();
  const manifest = JSON.parse(manifestEntry!.getData().toString('utf8'));
  expect(manifest.slides[0].notes).toBe(newNote);

  // The redundant speaker-notes.json mirror should also be updated.
  const notesEntry = zip.getEntry('speaker-notes.json');
  expect(notesEntry).toBeTruthy();
  const notesArr = JSON.parse(notesEntry!.getData().toString('utf8'));
  expect(notesArr[0]).toBe(newNote);
});

test('presenter view bottom strip edits the same notes (round-trip)', async ({
  page,
  request,
}) => {
  await ensureDeckUploaded(request);

  await page.goto(`/decks/${DECK_ID}/presenter#2`);
  await expect(page.getByTestId('deck-counter')).toContainText('2 / 4');

  const stripScope = page.getByTestId('speaker-notes');
  // Strip starts locked too.
  await expect(stripScope.getByTestId('editable-notes-readonly')).toBeVisible();
  await stripScope.getByTestId('notes-edit-toggle').click();
  const textarea = stripScope.getByTestId('editable-notes-textarea');
  await expect(textarea).toBeVisible();

  const newNote = `Presenter-strip edit @ ${Date.now()}`;
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await textarea.fill(newNote);

  const status = stripScope.getByTestId('notes-status');
  await expect(status).toHaveAttribute('data-state', 'saved', { timeout: 4000 });

  // Hop to single-window viewer + speaker panel to confirm the same note
  // shows up there. The Speaker panel is locked by default after navigation,
  // so we read from the read-only `<pre>` view rather than a textarea.
  await page.goto(`/decks/${DECK_ID}#2`);
  await page.getByTestId('speaker-button').click();
  await expect(
    page.getByTestId('speaker-panel').getByTestId('editable-notes-readonly'),
  ).toContainText(newNote);
});

test('Edit mode lock: ←/→ keep advancing slides while the speaker panel is open', async ({
  page,
  request,
}) => {
  await ensureDeckUploaded(request);

  await page.goto(`/decks/${DECK_ID}#1`);
  await page.getByTestId('speaker-button').click();
  const speakerPanel = page.getByTestId('speaker-panel');
  await expect(speakerPanel).toBeVisible();
  // Lock-state hint chip is visible and the editor is locked by default.
  await expect(speakerPanel.getByTestId('notes-lock-hint')).toBeVisible();
  await expect(speakerPanel.getByTestId('notes-lock-hint')).toContainText(
    /Read only/,
  );
  // A clueless click on the panel must not steal nav keys.
  await speakerPanel.getByTestId('editable-notes-readonly').click();
  await expect(page.getByTestId('deck-counter')).toContainText('1 / 4');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('deck-counter')).toContainText('2 / 4');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('deck-counter')).toContainText('3 / 4');

  // Once the user enters Edit mode, the textarea owns the keyboard — pressing
  // ArrowRight inside the textarea types nothing for empty input, so we
  // verify by typing and watching the value change instead. The lock hint
  // must disappear in Edit mode.
  await speakerPanel.getByTestId('notes-edit-toggle').click();
  await expect(speakerPanel.getByTestId('notes-lock-hint')).toHaveCount(0);
  const textarea = speakerPanel.getByTestId('editable-notes-textarea');
  await textarea.fill('owns-the-keyboard');
  await expect(textarea).toHaveValue('owns-the-keyboard');

  // Pressing Esc returns control; ArrowRight resumes advancing slides, and
  // the lock hint is back.
  await textarea.press('Escape');
  await expect(
    speakerPanel.getByTestId('editable-notes-textarea'),
  ).toHaveCount(0);
  await expect(speakerPanel.getByTestId('notes-lock-hint')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('deck-counter')).toContainText('4 / 4');
});

test('History panel lazily fetches audit log and reflects new edits', async ({
  page,
  request,
}) => {
  await ensureDeckUploaded(request);

  await page.goto(`/decks/${DECK_ID}#3`);
  await page.getByTestId('speaker-button').click();
  const speakerPanel = page.getByTestId('speaker-panel');
  await expect(speakerPanel).toBeVisible();

  // The History panel exists but is collapsed by default. Expanding it
  // triggers the first fetch (we wait for the GET to come back).
  const history = speakerPanel.getByTestId('notes-history');
  await expect(history).toBeVisible();
  // List should not be in the DOM until the user opens the disclosure.
  await expect(
    speakerPanel.getByTestId('notes-history-list'),
  ).toHaveCount(0);

  const auditPromise = page.waitForResponse(
    (resp) =>
      resp.url().includes('/notes/audit') && resp.request().method() === 'GET',
  );
  await history.locator('summary').click();
  await auditPromise;

  // Make a fresh edit so the list has *something* deterministic to assert
  // on, regardless of whatever the previous spec runs left behind.
  await speakerPanel.getByTestId('notes-edit-toggle').click();
  const textarea = speakerPanel.getByTestId('editable-notes-textarea');
  const sentinel = `History sentinel ${Date.now()}`;
  await textarea.fill(sentinel);
  // Wait for autosave so the audit row is committed before we look.
  await expect(
    speakerPanel.getByTestId('notes-status'),
  ).toHaveAttribute('data-state', 'saved', { timeout: 4000 });
  await textarea.press('Escape');

  // History should refresh on save and surface the sentinel near the top
  // (the panel auto-refetches when notesSync.status flips to 'saved').
  await expect(speakerPanel.getByTestId('notes-history-list')).toContainText(
    sentinel,
    { timeout: 5000 },
  );
});
