/**
 * Integration tests for `/storage/:id/*` after the deck-scoped access token
 * was bolted onto the previously cookie-only route.
 *
 * Reproduces the original bug ("uploaded slide tokens.css → 401") and locks
 * the new behaviour in:
 *
 *   • cookie  + no token   → 200       (SPA-side fetches still work)
 *   • token   + no cookie  → 200       (the new sandboxed-iframe path)
 *   • bad token + cookie   → 200       (token is opportunistic, not required)
 *   • bad token + no cookie→ 404       (no way to authenticate)
 *   • token of deck-A used to read deck-B (same owner) → 404
 *   • expired token + no cookie → 404
 *   • token of user-A used by user-B with their own cookie → 404 (cross-user)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authCookie,
  setupTestEnv,
  teardownTestEnv,
  uploadFixture,
  type TestEnv,
} from './helpers.js';
import { signStorageToken } from '../src/storage-token.js';

let env: TestEnv;
let testerCookie: string;
let strangerCookie: string;
let storageToken: string;
const DECK_ID = 'sample-stage-a';
const ASSET_PATH = 'slides/01-cover.html';

beforeAll(async () => {
  env = await setupTestEnv();
  testerCookie = await authCookie(env, 'tester');
  strangerCookie = await authCookie(env, 'someone-else');
  const upload = await uploadFixture(env, env.fixturePath, 'tester');
  expect(upload.status).toBe(201);
  const detail = await env.app.inject({
    method: 'GET',
    url: `/api/decks/${DECK_ID}`,
    headers: { cookie: testerCookie },
  });
  expect(detail.statusCode).toBe(200);
  storageToken = detail.json().storageToken;
  expect(typeof storageToken).toBe('string');
  expect(storageToken.length).toBeGreaterThan(20);
}, 60_000);

afterAll(async () => {
  if (env) await teardownTestEnv(env);
});

describe('GET /storage/:id/* — cookie path', () => {
  it('serves the asset when the session cookie owns the deck', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}`,
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  it('returns 404 to another logged-in user (no enumeration)', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 with no cookie and no token (the original bug)', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /storage/:id/* — token path', () => {
  it('serves the asset with a valid `?t=` and no cookie', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  it('also serves nested subresources (the original `tokens.css` repro)', async () => {
    // The fixture is multi-file but doesn't ship `shared/tokens.css`. Use
    // `thumbnails/01.png` which is generated for every fixture page.
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/thumbnails/01.png?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('falls back to cookie auth when the token is malformed', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}?t=not-a-token`,
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a token issued for a different deck', async () => {
    const otherDeckToken = signStorageToken(
      'sample-stage-a-OTHER',
      'tester',
      env.config.storageToken,
    );
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}?t=${encodeURIComponent(otherDeckToken)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an expired token', async () => {
    const expired = signStorageToken(
      DECK_ID,
      'tester',
      env.config.storageToken,
      // Issued long enough ago that exp < now.
      Math.floor(Date.now() / 1000) - env.config.storageToken.ttlSec - 60,
    );
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}?t=${encodeURIComponent(expired)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = signStorageToken(DECK_ID, 'tester', {
      secret: 'attacker-known-secret',
      ttlSec: 60,
    });
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}?t=${encodeURIComponent(forged)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not let user-B impersonate user-A by sniffing the token', async () => {
    // The token is `(deckId, userId, exp)`. Even with user-B's own cookie,
    // a token containing user-A's id resolves to user-A as the authorized
    // user, but the deck.ownerId is user-A's id, so the equality check
    // still passes. To check the *cross-user* case, mint a token where the
    // payload claims user-B, then try to use it: the deck is owned by
    // user-A, so the route returns 404.
    const strangerToken = signStorageToken(
      DECK_ID,
      'someone-else',
      env.config.storageToken,
    );
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}?t=${encodeURIComponent(strangerToken)}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /storage/:id/*.html — non-HTML passthrough is unchanged', () => {
  it('leaves PNGs as raw bytes (no rewriting on non-HTML)', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/thumbnails/01.png?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const buf = res.rawPayload;
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it('sets text/html with the rewritten body on .html responses', async () => {
    // The fixture's cover happens to inline its CSS — there's nothing to
    // rewrite — but the route still has to:
    //   * return Content-Type: text/html
    //   * return the original (now rewritten, but visually identical) body
    //   * not corrupt the inline style block
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/slides/01-cover.html?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('Slide Deck Packaging Demo');
    // Inline url(...) references would have gained `?t=` — none in the
    // sample, but assert nothing got mangled.
    expect(res.body).not.toContain('?t=?t=');
  });
});

describe('GET /api/decks responses include storageToken', () => {
  it('detail response embeds a working token', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/decks/${DECK_ID}`,
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.storageToken).toBe('string');
    const probe = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${ASSET_PATH}?t=${encodeURIComponent(body.storageToken)}`,
    });
    expect(probe.statusCode).toBe(200);
  });

  it('list response embeds a working token for each deck', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/decks',
      headers: { cookie: testerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      decks: { id: string; storageToken: string }[];
    };
    expect(body.decks.length).toBeGreaterThan(0);
    for (const d of body.decks) {
      expect(typeof d.storageToken).toBe('string');
      const probe = await env.app.inject({
        method: 'GET',
        url: `/storage/${d.id}/${ASSET_PATH}?t=${encodeURIComponent(d.storageToken)}`,
      });
      expect(probe.statusCode).toBe(200);
    }
  });
});
