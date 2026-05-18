import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { build as buildFixture } from '../../../scripts/build-fixture.mjs';
import { buildServer } from '../src/server.js';
import { disconnectPrisma, getPrisma } from '../src/db.js';
import type { AppConfig } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..');

export interface TestEnv {
  app: FastifyInstance;
  config: AppConfig;
  tmpRoot: string;
  fixturePath: string;
  url: (p: string) => string;
}

let dbReady = false;
const authCookies = new Map<string, string>();

export interface SetupOverrides {
  /** Override `config.auth.allowRegistration` for the registration-lockdown tests. */
  allowRegistration?: boolean;
  /** Deliberately point process.env at another DB to verify config injection. */
  mismatchAmbientDatabaseUrl?: boolean;
  webOrigin?: string;
  corsAllowDevOrigins?: boolean;
}

export async function setupTestEnv(
  overrides: SetupOverrides = {},
): Promise<TestEnv> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'slidestage-test-'));
  const dbPath = path.join(tmpRoot, 'test.db');
  const databaseUrl = `file:${dbPath}`;
  const storageRoot = path.join(tmpRoot, 'storage');
  await fs.mkdir(storageRoot, { recursive: true });

  process.env.DATABASE_URL = overrides.mismatchAmbientDatabaseUrl
    ? `file:${path.join(tmpRoot, 'ambient-wrong.db')}`
    : databaseUrl;
  process.env.STORAGE_ROOT = storageRoot;
  process.env.LOG_LEVEL = 'fatal';

  // Apply schema to the empty SQLite file.
  execSync('npx prisma db push --skip-generate', {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    stdio: 'pipe',
  });
  dbReady = true;

  const config: AppConfig = {
    port: 0,
    host: '127.0.0.1',
    storageRoot,
    databaseUrl,
    logLevel: 'fatal',
    webOrigin: overrides.webOrigin ?? 'http://localhost:5173',
    corsAllowDevOrigins: overrides.corsAllowDevOrigins ?? true,
    maxUploadBytes: 50 * 1024 * 1024,
    maxDecompressedBytes: 100 * 1024 * 1024,
    maxFileBytes: 25 * 1024 * 1024,
    maxSlides: 500,
    auth: {
      sessionCookie: 'slidestage_session',
      sessionDays: 30,
      cookieSecure: false,
      allowRegistration: overrides.allowRegistration ?? true,
      oidcProviders: [],
    },
    storageToken: {
      secret: 'test-storage-token-secret-do-not-use-in-prod',
      ttlSec: 60 * 60,
    },
  };
  const app = await buildServer(config);
  await app.ready();

  // Build a sample fixture into the test dir, not the repo's fixtures/out.
  const fixturePath = path.join(tmpRoot, 'sample.stage');
  buildFixture({ targetPath: fixturePath });

  return {
    app,
    config,
    tmpRoot,
    fixturePath,
    url: (p: string) => p,
  };
}

export async function teardownTestEnv(env: TestEnv): Promise<void> {
  await env.app.close();
  await disconnectPrisma();
  await fs.rm(env.tmpRoot, { recursive: true, force: true }).catch(() => {});
}

export async function uploadFixture(
  env: TestEnv,
  filePath: string = env.fixturePath,
  userId = 'tester',
): Promise<{ status: number; body: any }> {
  const buf = await fs.readFile(filePath);
  const cookie = await authCookie(env, userId);
  const boundary = `----TestBoundary${crypto.randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="sample.stage"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, buf, tail]);

  const res = await env.app.inject({
    method: 'POST',
    url: '/api/decks',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      cookie,
    },
    payload: body,
  });
  return {
    status: res.statusCode,
    body: res.statusCode === 204 ? null : res.json(),
  };
}

export async function authCookie(env: TestEnv, userId = 'tester'): Promise<string> {
  const key = `${env.tmpRoot}:${userId}`;
  const cached = authCookies.get(key);
  if (cached) return cached;
  const email = `${userId}@test.local`;
  const password = 'correct horse';
  let res = await env.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password, name: userId }),
  });
  if (res.statusCode === 409) {
    res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password }),
    });
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`authCookie failed: ${res.statusCode} ${res.body}`);
  }
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('authCookie missing set-cookie');
  const cookie = value.split(';')[0]!;
  authCookies.set(key, cookie);
  return cookie;
}

export { REPO_ROOT, SERVER_DIR };
