/**
 * Stateless deck-scoped access tokens for `/storage/*`.
 *
 * Why this exists: slide iframes are sandboxed with `allow-scripts` only — no
 * `allow-same-origin` — to neutralise XSS-via-deck attacks. That makes their
 * origin opaque, which in turn makes every subresource fetch they trigger a
 * cross-site request from the browser's point of view. SameSite=Lax session
 * cookies never ride along, so the storage route would 401 every `.css`,
 * `.png`, font, etc. that a slide references.
 *
 * The token here is a short-lived HMAC over `(deckId, userId, exp)` that
 * `/api/decks/*` hands back to the SPA. The SPA appends it as `?t=<token>` to
 * every `/storage/...` URL it constructs. The storage route accepts either a
 * valid token *or* the session cookie — the cookie still works for first-party
 * fetches (e.g. `DeckListPage` thumbnails loaded by the SPA itself).
 *
 * Token format (URL-safe, no `=` padding):
 *
 *   <base64url(payload)>.<base64url(hmac-sha256(secret, payload_b64))>
 *
 * Payload:
 *
 *   { d: deckId, u: userId, exp: epochSeconds }
 *
 * The secret is loaded from `AUTH_STORAGE_TOKEN_SECRET`. If unset, the server
 * derives a stable per-process random secret on startup; that means tokens
 * minted before a restart stop validating after a restart, which is fine for
 * short TTLs.
 */

import crypto from 'node:crypto';

export interface StorageTokenPayload {
  /** Deck the token grants access to. */
  d: string;
  /** Owner user id this token was issued to. */
  u: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export interface StorageTokenConfig {
  secret: string;
  ttlSec: number;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function sign(payloadB64: string, secret: string): string {
  return b64urlEncode(
    crypto.createHmac('sha256', secret).update(payloadB64).digest(),
  );
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Mint a storage token for `(deckId, userId)`. Expiry is `now + ttlSec`.
 */
export function signStorageToken(
  deckId: string,
  userId: string,
  config: StorageTokenConfig,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const payload: StorageTokenPayload = {
    d: deckId,
    u: userId,
    exp: nowSec + config.ttlSec,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64, config.secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a token. Returns the payload on success, `null` on any failure
 * (malformed, bad signature, expired). Constant-time signature compare.
 */
export function verifyStorageToken(
  token: string,
  config: StorageTokenConfig,
  nowSec: number = Math.floor(Date.now() / 1000),
): StorageTokenPayload | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = sign(payloadB64, config.secret);
  if (!timingSafeEqualStrings(sigB64, expectedSig)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as StorageTokenPayload).d !== 'string' ||
    typeof (payload as StorageTokenPayload).u !== 'string' ||
    typeof (payload as StorageTokenPayload).exp !== 'number'
  ) {
    return null;
  }
  const p = payload as StorageTokenPayload;
  if (p.exp <= nowSec) return null;
  return p;
}

/**
 * Generate a fresh per-process secret. Used when the operator doesn't set
 * `AUTH_STORAGE_TOKEN_SECRET`. Tokens minted with this secret stop working
 * after a server restart — acceptable for short TTLs.
 */
export function ephemeralSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}
