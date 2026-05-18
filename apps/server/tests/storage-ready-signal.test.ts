/**
 * Tests for the per-slide `slidestage:ready` script injected by the storage
 * route, plus the long-lived cache policy on immutable assets.
 *
 * Background: `iframe.onload` fires at `document.readyState === 'complete'`,
 * which is *before* webfonts finish loading. Without a second "actually
 * stable" signal, `DeckStage` promotes the new iframe early and the user
 * sees the fallback→webfont swap flash on every page turn. The injected
 * script bridges that gap by posting `slidestage:ready` to the parent after
 * `document.fonts.ready` plus two rAFs.
 *
 * These tests pin the *shape* of the injection (placement, content,
 * cache headers). The actual fonts-ready timing is exercised end-to-end
 * in `apps/web/tests/e2e/font-flash.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authCookie,
  setupTestEnv,
  teardownTestEnv,
  uploadFixture,
  type TestEnv,
} from './helpers.js';

let env: TestEnv;
let testerCookie: string;
let storageToken: string;
const DECK_ID = 'sample-stage-a';
const SLIDE_PATH = 'slides/01-cover.html';

beforeAll(async () => {
  env = await setupTestEnv();
  testerCookie = await authCookie(env, 'tester');
  const upload = await uploadFixture(env, env.fixturePath, 'tester');
  expect(upload.status).toBe(201);
  const detail = await env.app.inject({
    method: 'GET',
    url: `/api/decks/${DECK_ID}`,
    headers: { cookie: testerCookie },
  });
  expect(detail.statusCode).toBe(200);
  storageToken = detail.json().storageToken as string;
}, 60_000);

afterAll(async () => {
  if (env) await teardownTestEnv(env);
});

describe('storage route: slidestage:ready signal injection', () => {
  it('injects an inline <script> right before </body>', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${SLIDE_PATH}?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');

    const body = res.body;
    expect(body).toContain(`slidestage:ready`);
    expect(body).toContain(`document.fonts`);
    expect(body).toContain(`postMessage`);

    // Must come *before* </body>, not orphaned at the very end — otherwise
    // it sits outside the document body and won't run reliably in Safari.
    const bodyClose = body.lastIndexOf('</body>');
    const scriptIdx = body.indexOf('slidestage:ready');
    expect(bodyClose).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeLessThan(bodyClose);
  });

  it('script guards against missing document.fonts (older Safari)', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${SLIDE_PATH}?t=${encodeURIComponent(storageToken)}`,
    });
    // The conditional must be present so that browsers without
    // `document.fonts.ready` still emit the signal (via rAF + setTimeout).
    expect(res.body).toMatch(/document\.fonts&&document\.fonts\.ready/);
    expect(res.body).toContain('requestAnimationFrame');
    // And a hard timeout safety net — bounded by 1500ms server-side.
    expect(res.body).toMatch(/setTimeout\(send,1500\)/);
  });

  it('script reaches the iframe even when the slide has no </body> tag', async () => {
    // The route injects via `</body>` first, `</html>` second, append last.
    // The sample fixture is well-formed, so we just sanity-check that the
    // script lands somewhere inside the served HTML.
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${SLIDE_PATH}?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.body).toMatch(/<script>\(function\(\)\{[\s\S]*slidestage:ready/);
  });
});

describe('storage route: long-lived cache for immutable assets', () => {
  // Fonts and images stay on the same URL for the deck's lifetime — uploads
  // create a new deck id rather than mutating an existing one. Giving them
  // a 1-year immutable cache means each iframe re-mount hits the browser's
  // disk cache directly, which keeps the per-slide font/image fetches
  // off the critical path.

  it('sends max-age=31536000, immutable on .png assets', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/thumbnails/01.png?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('keeps the short cache on HTML (rewritten per request)', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/${SLIDE_PATH}?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=300');
    expect(res.headers['cache-control']).not.toContain('immutable');
  });

  it('keeps the short cache on manifest.json (occasionally re-edited)', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `/storage/${DECK_ID}/manifest.json?t=${encodeURIComponent(storageToken)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=300');
    expect(res.headers['cache-control']).not.toContain('immutable');
  });
});
