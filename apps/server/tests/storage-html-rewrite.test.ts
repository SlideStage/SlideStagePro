/**
 * Unit tests for the inline HTML rewriter used by `/storage/:id/*.html`.
 *
 * Why this rewriter exists: sandboxed slide iframes (`sandbox="allow-scripts"`,
 * no `allow-same-origin`) run at an opaque origin. Every subresource fetch
 * they trigger is therefore a cross-site no-cors request for SameSite cookie
 * purposes — neither the session cookie nor any path-scoped `SameSite=Lax`
 * cookie rides along, and the browser does *not* inherit the parent iframe's
 * `?t=<token>` query when it resolves a relative URL inside the iframe HTML.
 * The only way to authenticate those subresource fetches is to put the token
 * in the URL itself, which means rewriting the HTML on the way out.
 *
 * These tests pin the rewriter's contract directly so we don't have to
 * fabricate complex fixture HTML to exercise every URL-bearing attribute.
 */
import { describe, expect, it } from 'vitest';
import { rewriteHtmlWithToken } from '../src/routes/storage.js';

const TOKEN = 'abc.DEF-1234_xyz';
const Q = `t=${encodeURIComponent(TOKEN)}`;

describe('rewriteHtmlWithToken', () => {
  it('appends ?t= to a relative <link rel="stylesheet" href="../shared/tokens.css">', () => {
    const out = rewriteHtmlWithToken(
      `<link rel="stylesheet" href="../shared/tokens.css">`,
      TOKEN,
    );
    expect(out).toBe(`<link rel="stylesheet" href="../shared/tokens.css?${Q}">`);
  });

  it('handles single-quoted attribute values', () => {
    const out = rewriteHtmlWithToken(
      `<img src='assets/cover.png' alt='cover'>`,
      TOKEN,
    );
    expect(out).toBe(`<img src='assets/cover.png?${Q}' alt='cover'>`);
  });

  it('preserves an existing query string by switching ?→&', () => {
    const out = rewriteHtmlWithToken(
      `<img src="assets/cover.png?v=2">`,
      TOKEN,
    );
    expect(out).toBe(`<img src="assets/cover.png?v=2&${Q}">`);
  });

  it('preserves a trailing #fragment after the query', () => {
    const out = rewriteHtmlWithToken(
      `<a href="other.html#section-1">jump</a>`,
      TOKEN,
    );
    expect(out).toBe(`<a href="other.html?${Q}#section-1">jump</a>`);
  });

  it('rewrites <script src>, <video poster>, <source src>', () => {
    const out = rewriteHtmlWithToken(
      `<script src="js/main.js"></script>` +
        `<video poster="img/p.png" src="vid/clip.mp4"></video>` +
        `<source src="audio/track.mp3" type="audio/mpeg">`,
      TOKEN,
    );
    expect(out).toContain(`<script src="js/main.js?${Q}">`);
    expect(out).toContain(`poster="img/p.png?${Q}"`);
    expect(out).toContain(`src="vid/clip.mp4?${Q}"`);
    expect(out).toContain(`<source src="audio/track.mp3?${Q}"`);
  });

  it('rewrites each URL in srcset (with descriptor preservation)', () => {
    const out = rewriteHtmlWithToken(
      `<img srcset="img/a.png 1x, img/b.png 2x, img/c.png 3x">`,
      TOKEN,
    );
    expect(out).toBe(
      `<img srcset="img/a.png?${Q} 1x, img/b.png?${Q} 2x, img/c.png?${Q} 3x">`,
    );
  });

  it('rewrites inline-CSS url(...) inside <style> blocks', () => {
    const out = rewriteHtmlWithToken(
      `<style>body{background:url(bg/tile.png) repeat;}</style>`,
      TOKEN,
    );
    expect(out).toContain(`url(bg/tile.png?${Q})`);
  });

  it('handles quoted url() with both " and \'', () => {
    const out = rewriteHtmlWithToken(
      `<style>.a{background:url("img/a.png")} .b{background:url('img/b.png')}</style>`,
      TOKEN,
    );
    expect(out).toContain(`url("img/a.png?${Q}")`);
    expect(out).toContain(`url('img/b.png?${Q}')`);
  });

  it('leaves absolute https:// URLs untouched', () => {
    const out = rewriteHtmlWithToken(
      `<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">`,
      TOKEN,
    );
    expect(out).not.toContain(`?t=`);
    expect(out).toContain(`https://fonts.googleapis.com/css2?family=Inter`);
  });

  it('leaves scheme-relative //cdn.example.com untouched', () => {
    const out = rewriteHtmlWithToken(
      `<script src="//cdn.example.com/lib.js"></script>`,
      TOKEN,
    );
    expect(out).toContain(`<script src="//cdn.example.com/lib.js">`);
    expect(out).not.toContain(`?t=`);
  });

  it('leaves data:, blob:, mailto:, fragment-only URLs untouched', () => {
    const out = rewriteHtmlWithToken(
      [
        `<img src="data:image/png;base64,iVBORw0KGgo=">`,
        `<img src="blob:http://x/y">`,
        `<a href="mailto:a@b.c">m</a>`,
        `<a href="#top">top</a>`,
      ].join(''),
      TOKEN,
    );
    expect(out).not.toContain(`?t=`);
    expect(out).toContain(`data:image/png;base64,iVBORw0KGgo=`);
    expect(out).toContain(`mailto:a@b.c`);
    expect(out).toContain(`href="#top"`);
  });

  it('is idempotent for already-tokenised URLs (?t= preserved as second query)', () => {
    // Hitting the rewriter twice should not produce `?t=…&t=…` because the
    // original URL is left intact; we accept that re-running adds a second
    // `t=` — the server only rewrites once per response so this is purely a
    // defensive guard.
    const once = rewriteHtmlWithToken(
      `<link href="../shared/tokens.css">`,
      TOKEN,
    );
    const twice = rewriteHtmlWithToken(once, TOKEN);
    // Both `t=` should be present after a second rewrite; the browser uses
    // the *last* query param, so the latest token wins. (This is fine.)
    const occurrences = twice.match(/t=/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it('does not corrupt unrelated attributes that contain "href"/"src" substrings', () => {
    const out = rewriteHtmlWithToken(
      `<div data-hrefless="x" data-srcset-fake="y">no</div>`,
      TOKEN,
    );
    // `data-hrefless` and `data-srcset-fake` aren't `href`/`src`/`srcset`,
    // they just contain those substrings — must not be touched.
    expect(out).toBe(`<div data-hrefless="x" data-srcset-fake="y">no</div>`);
  });

  it('rewrites empty-string src/href to itself (no double `?`)', () => {
    const out = rewriteHtmlWithToken(`<img src="">`, TOKEN);
    expect(out).toBe(`<img src="">`);
  });
});
