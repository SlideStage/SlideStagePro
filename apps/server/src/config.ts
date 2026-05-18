/**
 * Runtime configuration. Pulls from process.env with sane defaults so the
 * server boots even without an .env file. CI / Docker should still set the
 * vars explicitly — see ../.env.example.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ephemeralSecret } from './storage-token.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/server/dist/config.js or apps/server/src/config.ts → apps/server
const APP_ROOT = path.resolve(__dirname, '..');

export interface AppConfig {
  port: number;
  host: string;
  storageRoot: string;
  databaseUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  webOrigin: string;
  corsAllowDevOrigins: boolean;

  /** Max .stage upload (bytes). Spec §2.5 → 200 MB default. */
  maxUploadBytes: number;
  /** Max decompressed total bytes. Spec §2.5 → 1 GB default. */
  maxDecompressedBytes: number;
  /** Max individual file (post-decompress). Spec §2.5 → 100 MB default. */
  maxFileBytes: number;
  /** Max slides per deck. Spec §2.5 → 500. */
  maxSlides: number;

  auth: {
    sessionCookie: string;
    sessionDays: number;
    cookieSecure: boolean;
    /**
     * Master switch for self-service registration. When `false`:
     *   - `POST /api/auth/register` returns 403 (`EREGCLOSED`).
     *   - OAuth / OIDC callbacks refuse to mint a new local user (existing
     *     linked accounts still log in fine).
     *   - The `/api/auth/providers` response advertises
     *     `allowRegistration: false` so the SPA can hide register affordances.
     *
     * Always overridden by the bootstrap exception: when the `User` table is
     * empty, the very first registration is allowed and is promoted to
     * `admin`, regardless of this flag. See `docs/USER_MANAGEMENT.md`.
     */
    allowRegistration: boolean;
    github?: OAuthProviderConfig;
    oidcProviders: OAuthProviderConfig[];
  };

  /**
   * Short-lived deck-scoped access tokens that let sandboxed slide iframes
   * pull `/storage/<deck>/<asset>` without the SameSite=Lax session cookie
   * (which the browser refuses to attach because the iframe is opaque-origin).
   * Issued by `/api/decks/*` responses and consumed via `?t=<token>` query
   * parameters by the storage route. See `storage-token.ts` for the format.
   */
  storageToken: {
    secret: string;
    ttlSec: number;
  };
}

export interface OAuthProviderConfig {
  key: string;
  issuer?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function optionalProvider(
  key: string,
  prefix: string,
  issuerRequired: boolean,
): OAuthProviderConfig | undefined {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const redirectUri = process.env[`${prefix}_REDIRECT_URI`];
  const issuer = process.env[`${prefix}_ISSUER`];
  if (!clientId || !clientSecret || !redirectUri || (issuerRequired && !issuer)) {
    return undefined;
  }
  return { key, issuer, clientId, clientSecret, redirectUri };
}

function oidcProviders(): OAuthProviderConfig[] {
  const keys = (process.env.OIDC_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return keys
    .map((key) =>
      optionalProvider(key, `OIDC_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, true),
    )
    .filter((p): p is OAuthProviderConfig => Boolean(p));
}

export function loadConfig(): AppConfig {
  const storageRoot = process.env.STORAGE_ROOT
    ? path.resolve(process.cwd(), process.env.STORAGE_ROOT)
    : path.resolve(APP_ROOT, 'storage');

  return {
    port: int('PORT', 4000),
    host: process.env.HOST ?? '0.0.0.0',
    storageRoot,
    databaseUrl:
      process.env.DATABASE_URL ?? `file:${path.resolve(APP_ROOT, 'dev.db')}`,
    logLevel:
      (process.env.LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    corsAllowDevOrigins: bool(
      'CORS_ALLOW_DEV_ORIGINS',
      process.env.NODE_ENV !== 'production',
    ),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 200 * 1024 * 1024),
    maxDecompressedBytes: int('MAX_DECOMPRESSED_BYTES', 1024 * 1024 * 1024),
    maxFileBytes: int('MAX_FILE_BYTES', 100 * 1024 * 1024),
    maxSlides: int('MAX_SLIDES', 500),
    auth: {
      sessionCookie: process.env.AUTH_SESSION_COOKIE ?? 'slidestage_session',
      sessionDays: int('AUTH_SESSION_DAYS', 30),
      cookieSecure: bool('AUTH_COOKIE_SECURE', false),
      allowRegistration: bool('AUTH_ALLOW_REGISTRATION', true),
      github: optionalProvider('github', 'GITHUB', false),
      oidcProviders: oidcProviders(),
    },
    storageToken: {
      secret: process.env.AUTH_STORAGE_TOKEN_SECRET ?? ephemeralSecret(),
      ttlSec: int('AUTH_STORAGE_TOKEN_TTL_SEC', 60 * 60),
    },
  };
}

export const APP_ROOT_PATH = APP_ROOT;
