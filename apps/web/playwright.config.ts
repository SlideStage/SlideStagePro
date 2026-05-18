import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.resolve(REPO_ROOT, 'apps', 'server');
const E2E_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'slidestage-e2e-'));
const E2E_DB = path.join(E2E_ROOT, 'e2e.db');
const E2E_STORAGE = path.join(E2E_ROOT, 'storage');
const SERVER_PORT = process.env.E2E_SERVER_PORT ?? '4001';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const RESET_E2E_STATE = `node -e 'const fs=require("node:fs"); fs.rmSync(${JSON.stringify(E2E_DB)}, { force: true }); fs.rmSync(${JSON.stringify(E2E_STORAGE)}, { recursive: true, force: true });'`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  // All specs share the same backend (sample deck id, storage path, sqlite DB),
  // so running files in parallel races on uploads/deletes. Stick to a single
  // worker until each spec uses a unique deck id.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // Boot backend in fresh-state mode against a per-run isolated DB + storage.
      // We prepare the SQLite schema with `prisma db push` before launch so
      // the very first request doesn't 500. Both DB and storage use absolute
      // temp paths to keep cwd-independence and avoid stale state.
      command: [
        RESET_E2E_STATE,
        'pnpm --filter @slidestage/server build',
        'pnpm --filter @slidestage/server exec prisma db push --skip-generate --accept-data-loss',
        'pnpm --filter @slidestage/server start',
      ].join(' && '),
      cwd: REPO_ROOT,
      env: {
        DATABASE_URL: `file:${E2E_DB}`,
        STORAGE_ROOT: E2E_STORAGE,
        PORT: SERVER_PORT,
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        AUTH_ALLOW_REGISTRATION: 'true',
      },
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm --filter @slidestage/web dev --host 127.0.0.1 --port ${WEB_PORT}`,
      cwd: REPO_ROOT,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VITE_API_URL: `http://127.0.0.1:${SERVER_PORT}`,
      },
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
