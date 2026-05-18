import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import type { AppConfig } from '../config.js';
import { getPrisma } from '../db.js';
import { getOptionalUser } from '../auth.js';
import { signStorageToken, verifyStorageToken } from '../storage-token.js';

interface RouteDeps {
  config: AppConfig;
}

const paramsSchema = z.object({
  id: z.string().min(1),
  '*': z.string().min(1),
});

const querySchema = z
  .object({
    t: z.string().min(1).max(2048).optional(),
  })
  .passthrough();

interface ResolvedAuth {
  userId: string;
  /** The token actually used (or freshly minted) — propagated to subresources. */
  token: string;
}

/**
 * Resolve the user id allowed to read `deckId`. Order of attempts:
 *   1. Valid `?t=<storage-token>` for this deck → use the token verbatim.
 *   2. Session cookie → mint a fresh token so HTML rewriting can carry one.
 *
 * Returns `null` if neither path produces a user. The caller turns that into
 * 404 (not 401) to keep cross-user enumeration noisy-but-not-helpful.
 *
 * Why we don't try a path-scoped cookie fallback: sandboxed slide iframes run
 * at an opaque origin, so the browser treats every subresource request they
 * make as cross-site for SameSite purposes — Lax cookies are *not* sent, and
 * SameSite=None requires `Secure` (HTTPS) which breaks local dev. URL-based
 * tokens are the only mechanism that survives the opaque-origin sandbox.
 */
async function resolveAuthorizedUserId(
  req: FastifyRequest,
  config: AppConfig,
  deckId: string,
): Promise<ResolvedAuth | null> {
  const query = querySchema.parse(req.query ?? {});
  if (typeof query.t === 'string' && query.t.length > 0) {
    const payload = verifyStorageToken(query.t, config.storageToken);
    if (payload && payload.d === deckId) {
      return { userId: payload.u, token: query.t };
    }
    // Bad/expired token falls through to cookie.
  }

  const user = await getOptionalUser(req, config);
  if (!user) return null;
  return {
    userId: user.id,
    token: signStorageToken(deckId, user.id, config.storageToken),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};

function decodeStoragePath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    throw new SlideStageError(
      ERROR_CODES.EBADMANIFEST,
      'invalid storage path encoding',
      400,
    );
  }
}

function resolveStoragePath(deckRoot: string, rawRelativePath: string): string {
  const decoded = decodeStoragePath(rawRelativePath);
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new SlideStageError(ERROR_CODES.EZIPSLIP, 'invalid storage path', 400);
  }

  const normalized = path.posix.normalize(decoded);
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized.startsWith('..') ||
    normalized.includes('/../')
  ) {
    throw new SlideStageError(ERROR_CODES.EZIPSLIP, 'invalid storage path', 400);
  }

  const rootAbs = path.resolve(deckRoot);
  const targetAbs = path.resolve(rootAbs, ...normalized.split('/'));
  if (!targetAbs.startsWith(rootAbs + path.sep)) {
    throw new SlideStageError(ERROR_CODES.EZIPSLIP, 'invalid storage path', 400);
  }
  return targetAbs;
}

/**
 * File extensions whose bytes are immutable for the lifetime of a deck —
 * fonts, fingerprinted images, video, audio. We can hand them a long
 * `immutable` cache so HTTP cache covers re-visits across slide iframes
 * and across sessions, dramatically cutting the FOUT window for fonts.
 * HTML (rewritten per request) and CSS (small + often re-edited) stay on
 * the shorter `private, max-age=300` policy.
 */
const IMMUTABLE_EXTS = new Set([
  '.woff', '.woff2', '.ttf', '.otf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.mp4', '.webm', '.mp3', '.wav',
  '.pdf',
]);

function setStorageHeaders(reply: FastifyReply, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  reply.header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
  reply.header('X-Content-Type-Options', 'nosniff');
  if (IMMUTABLE_EXTS.has(ext)) {
    // 1y + immutable: deck contents are write-once (uploads create a new
    // deck id rather than mutating an existing one), so the byte payload
    // for a given URL never changes. Long cache => fonts stay warm across
    // slide iframes, eliminating per-slide font fetches on re-visits.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  } else {
    reply.header('Cache-Control', 'private, max-age=300');
  }

  if (ext === '.html' || ext === '.htm') {
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self' https:",
        "script-src 'self' 'unsafe-inline' https:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' https: data: blob:",
        "connect-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
      ].join('; '),
    );
  }
}

/**
 * Inline script injected into every slide HTML so the SPA's `DeckStage` can
 * tell when the iframe is *actually* visually stable, not just DOM-complete.
 *
 * The iframe `onload` event fires at `document.readyState === 'complete'`,
 * which is *before* webfonts have finished loading and swapping — that's
 * what produces the per-slide "font flash" on navigation. We wait for both
 * `document.fonts.ready` and `requestAnimationFrame` (so the post-swap
 * layout has been painted) and then `parent.postMessage` a small signal.
 *
 * Bounded by a hard timeout so a deck whose CSS never resolves doesn't
 * keep the prev slide pinned forever — the parent will promote anyway.
 *
 * The protocol is intentionally `parent`-targeted with `'*'`: the parent
 * window matches the message back to its iframe via `event.source`, so we
 * don't need an origin handshake here (the iframe also has no idea what
 * its parent's origin is — opaque-origin sandbox).
 */
const READY_SIGNAL_SCRIPT = `<script>(function(){
var sent=false;
function send(){
  if(sent)return;sent=true;
  try{parent.postMessage({type:'slidestage:ready',href:location.href},'*');}catch(_){}
}
function whenFontsReady(){
  if(document.fonts&&document.fonts.ready&&typeof document.fonts.ready.then==='function'){
    document.fonts.ready.then(function(){
      requestAnimationFrame(function(){requestAnimationFrame(send);});
    }).catch(send);
  }else{
    requestAnimationFrame(function(){requestAnimationFrame(send);});
  }
}
if(document.readyState==='complete'||document.readyState==='interactive'){
  whenFontsReady();
}else{
  document.addEventListener('DOMContentLoaded',whenFontsReady,{once:true});
}
setTimeout(send,1500);
})();</script>`;

/**
 * Insert the ready-signal script as late as possible so the slide's own
 * `<link>`/`<style>`/`<script>` have already been registered with the
 * browser by the time we ask `document.fonts.ready`. Preference order:
 *
 *   1. Right before `</body>` — best, runs after all sync resources
 *   2. Right before `</html>`
 *   3. Append to the end — last resort for malformed HTML
 */
function injectReadySignal(html: string): string {
  const lowerHtml = html.toLowerCase();
  const bodyClose = lowerHtml.lastIndexOf('</body>');
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + READY_SIGNAL_SCRIPT + html.slice(bodyClose);
  }
  const htmlClose = lowerHtml.lastIndexOf('</html>');
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + READY_SIGNAL_SCRIPT + html.slice(htmlClose);
  }
  return html + READY_SIGNAL_SCRIPT;
}

/**
 * Append `?t=<token>` to every relative URL referenced by the slide HTML.
 *
 * Why we have to: sandboxed slide iframes run at an opaque origin. Their
 * subresource requests (`../shared/tokens.css`, `assets/logo.png`, fonts,
 * inline-CSS `url(...)`) are therefore cross-site for SameSite purposes —
 * neither the SPA session cookie nor a `SameSite=Lax` path-scoped cookie
 * rides along. The only way the storage route can authenticate those
 * fetches is if the token is in the URL itself. The browser does *not*
 * inherit the parent iframe's `?t=` query when it resolves a relative
 * subresource URL, so we rewrite the HTML once on the way out instead.
 *
 * Scope: only `src`/`href`/`poster`/`srcset` attributes and inline
 * `url(...)` references that point to relative paths. Absolute URLs
 * (`http(s)://`, `//`, `data:`, `blob:`, `about:`, `mailto:`,
 * fragment-only `#...`) are left untouched.
 */
export function rewriteHtmlWithToken(html: string, token: string): string {
  const q = `t=${encodeURIComponent(token)}`;

  const isAbsolute = (url: string): boolean =>
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:|javascript:|about:|data:|blob:)/i.test(
      url,
    );

  const appendQuery = (url: string): string => {
    if (!url || isAbsolute(url)) return url;
    const hashAt = url.indexOf('#');
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const frag = hashAt >= 0 ? url.slice(hashAt) : '';
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${q}${frag}`;
  };

  // 1. `<tag ... attr="...">` and `<tag ... attr='...'>` for href/src/poster.
  let out = html.replace(
    /\b(href|src|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_match, attr: string, _quoted: string, dq?: string, sq?: string) => {
      const original = dq ?? sq ?? '';
      const rewritten = appendQuery(original);
      const quote = dq !== undefined ? '"' : "'";
      return `${attr}=${quote}${rewritten}${quote}`;
    },
  );

  // 2. `srcset="url 1x, url2 2x"` — comma-separated list, each entry has a
  // URL plus optional descriptor.
  out = out.replace(
    /\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_match, _quoted: string, dq?: string, sq?: string) => {
      const original = dq ?? sq ?? '';
      const rewritten = original
        .split(',')
        .map((entry) => {
          const trimmed = entry.trim();
          if (!trimmed) return entry;
          const parts = trimmed.split(/\s+/);
          const url = parts[0]!;
          const descriptors = parts.slice(1).join(' ');
          const newUrl = appendQuery(url);
          return descriptors ? `${newUrl} ${descriptors}` : newUrl;
        })
        .join(', ');
      const quote = dq !== undefined ? '"' : "'";
      return `srcset=${quote}${rewritten}${quote}`;
    },
  );

  // 3. Inline-CSS `url(...)` — `<style>` blocks and `style="..."` attrs both
  // funnel through the same regex (CSS URL syntax).
  out = out.replace(
    /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+))\s*\)/gi,
    (_match, dq?: string, sq?: string, bare?: string) => {
      const original = (dq ?? sq ?? bare ?? '').trim();
      const rewritten = appendQuery(original);
      if (dq !== undefined) return `url("${rewritten}")`;
      if (sq !== undefined) return `url('${rewritten}')`;
      return `url(${rewritten})`;
    },
  );

  return out;
}

export async function registerStorageRoute(
  app: FastifyInstance,
  { config }: RouteDeps,
): Promise<void> {
  const prisma = getPrisma();

  app.route<{ Params: { id: string; '*': string } }>({
    method: ['GET', 'HEAD'],
    url: '/storage/:id/*',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const params = paramsSchema.parse(req.params);
      const auth = await resolveAuthorizedUserId(req, config, params.id);

      const deck = await prisma.deck.findUnique({
        where: { id: params.id },
        select: { ownerId: true, storageRoot: true },
      });
      // Always 404 (never 401) so unauthenticated probes can't enumerate
      // which deck ids exist. A logged-out request to a non-existent deck
      // looks identical to one for someone else's deck.
      if (!deck || !auth || deck.ownerId !== auth.userId) {
        throw new SlideStageError(
          ERROR_CODES.EMISSINGFILE,
          `deck not found: ${params.id}`,
          404,
        );
      }

      const deckRoot = path.resolve(config.storageRoot, deck.storageRoot);
      const filePath = resolveStoragePath(deckRoot, params['*']);
      let stat;
      try {
        stat = await fs.stat(filePath);
        if (!stat.isFile()) throw new Error('not a file');
      } catch {
        throw new SlideStageError(
          ERROR_CODES.EMISSINGFILE,
          `storage file not found: ${params['*']}`,
          404,
        );
      }

      setStorageHeaders(reply, filePath);
      const ext = path.extname(filePath).toLowerCase();

      // HTML responses get rewritten so every relative URL inside carries
      // the same access token — see `rewriteHtmlWithToken` for the why —
      // and get a tiny `slidestage:ready` postMessage emitter injected so
      // `DeckStage` only promotes a buffered iframe once fonts have
      // actually swapped, removing the per-slide flash.
      if (ext === '.html' || ext === '.htm') {
        if (req.method === 'HEAD') {
          // HEAD skips the body but the GET body length differs from the
          // on-disk file (we inject a script + rewrite URLs), so we omit
          // Content-Length on HEAD — callers don't use it.
          return reply.send();
        }
        const raw = await fs.readFile(filePath, 'utf8');
        const rewritten = rewriteHtmlWithToken(raw, auth.token);
        const withReady = injectReadySignal(rewritten);
        const body = Buffer.from(withReady, 'utf8');
        reply.header('Content-Length', String(body.byteLength));
        return reply.send(body);
      }

      reply.header('Content-Length', String(stat.size));
      if (req.method === 'HEAD') {
        return reply.send();
      }
      return reply.send(createReadStream(filePath));
    },
  });
}
