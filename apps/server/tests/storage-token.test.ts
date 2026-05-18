/**
 * Unit tests for the stateless storage-token signer.
 *
 * These cover the standalone HMAC/expiry logic; the storage-route integration
 * (token in `?t=`, cookie fallback, cross-deck rejection) lives in
 * `storage-route.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  ephemeralSecret,
  signStorageToken,
  verifyStorageToken,
} from '../src/storage-token.js';

const SECRET = 'unit-test-secret-do-not-use-in-prod';
const CONFIG = { secret: SECRET, ttlSec: 60 };

describe('storage-token', () => {
  it('round-trips a freshly signed token', () => {
    const now = 1_700_000_000;
    const token = signStorageToken('deck-a', 'user-1', CONFIG, now);
    const payload = verifyStorageToken(token, CONFIG, now);
    expect(payload).not.toBeNull();
    expect(payload!.d).toBe('deck-a');
    expect(payload!.u).toBe('user-1');
    expect(payload!.exp).toBe(now + CONFIG.ttlSec);
  });

  it('rejects tokens with a tampered payload', () => {
    const token = signStorageToken('deck-a', 'user-1', CONFIG);
    const [payloadB64, sig] = token.split('.');
    // Swap one base64url char inside the payload (still valid base64url, but
    // decodes to different bytes → HMAC mismatch).
    const flipped = payloadB64!.replace(/[A-Z]/, 'a');
    const altered = `${flipped === payloadB64 ? payloadB64 + 'x' : flipped}.${sig}`;
    expect(verifyStorageToken(altered, CONFIG)).toBeNull();
  });

  it('rejects tokens with a forged signature', () => {
    const token = signStorageToken('deck-a', 'user-1', CONFIG);
    const [payloadB64] = token.split('.');
    expect(verifyStorageToken(`${payloadB64}.AAAA`, CONFIG)).toBeNull();
  });

  it('rejects tokens with a different secret', () => {
    const token = signStorageToken('deck-a', 'user-1', CONFIG);
    expect(
      verifyStorageToken(token, { ...CONFIG, secret: 'another-secret' }),
    ).toBeNull();
  });

  it('rejects expired tokens', () => {
    const now = 1_700_000_000;
    const token = signStorageToken('deck-a', 'user-1', CONFIG, now);
    // Token TTL is 60 s — checking 90 s later must fail.
    expect(verifyStorageToken(token, CONFIG, now + 90)).toBeNull();
    // Boundary case: exactly at exp is also rejected (exp is exclusive).
    expect(verifyStorageToken(token, CONFIG, now + CONFIG.ttlSec)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyStorageToken('', CONFIG)).toBeNull();
    expect(verifyStorageToken('no-dot', CONFIG)).toBeNull();
    expect(verifyStorageToken('.justasig', CONFIG)).toBeNull();
    expect(verifyStorageToken('payload.', CONFIG)).toBeNull();
    expect(verifyStorageToken('not.b64.payload', CONFIG)).toBeNull();
  });

  it('ephemeralSecret returns a fresh non-empty string each call', () => {
    const a = ephemeralSecret();
    const b = ephemeralSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(16);
  });
});
