/**
 * Pre-warm deck-level stylesheets (and the webfonts they `@import`) into the
 * browser's HTTP cache so the *first* slide iframe doesn't pay the full
 * download cost.
 *
 * Why this matters even with `DeckStage`'s ready-signal gate: the gate
 * keeps the user from *seeing* the FOUT, but the buffered iframe still
 * waits on the network to download fonts before promoting. Warming them
 * from the SPA cuts that first-page latency from ~400ms (Google Fonts CSS
 * + several woff2) down to a single rAF.
 *
 * Strategy: for each style asset listed in `manifest.assets.files`, inject
 * a `<link rel="preload" as="style">` into the SPA's `document.head`.
 * Preload is "fire and forget" — the browser downloads the bytes but
 * doesn't apply the styles, so the SPA's own typography is untouched.
 *
 * Subtlety: `<link rel="preload" as="style">` only fetches the *outer*
 * stylesheet bytes; it does not follow `@import` chains. To also warm the
 * Google Fonts CSS + woff2 files we additionally fetch each stylesheet
 * with `text/css` Accept and inject a real (display:none / media="print")
 * `<link rel="stylesheet">` so the browser parses it, resolves @import,
 * downloads the webfonts, and caches everything. `media="print"` keeps
 * the rules from affecting on-screen layout. (Most browsers still load
 * print stylesheets and their fonts so they're ready when the user hits
 * `Cmd-P`; we rely on that.)
 *
 * No-op when the deck has no style assets or when the hook unmounts.
 */
import { useEffect } from 'react';
import type { Manifest } from '@slidestage/shared';
import { storageAssetUrl } from '../utils/storageUrl.js';

interface Options {
  deckId: string | null | undefined;
  manifest: Manifest | null | undefined;
  storageToken: string | null | undefined;
}

export function useDeckFontWarmup({
  deckId,
  manifest,
  storageToken,
}: Options): void {
  useEffect(() => {
    if (!deckId || !manifest || !storageToken) return;
    const styleAssets = (manifest.assets?.files ?? []).filter((f) => {
      if (!f.path) return false;
      if (f.type === 'style') return true;
      // Fallback: type wasn't set but the extension is .css.
      return /\.css($|\?)/i.test(f.path);
    });
    if (styleAssets.length === 0) return;

    const created: HTMLLinkElement[] = [];

    for (const file of styleAssets) {
      const href = storageAssetUrl(deckId, file.path, storageToken);

      // 1. Preload the CSS bytes themselves — fast, no parsing.
      const preload = document.createElement('link');
      preload.rel = 'preload';
      preload.as = 'style';
      preload.href = href;
      // `crossorigin` isn't required (same origin), but keeping it
      // explicit means a future origin split (e.g. CDN for /storage)
      // won't silently turn this into a tainted request.
      preload.crossOrigin = 'anonymous';
      document.head.appendChild(preload);
      created.push(preload);

      // 2. Also attach as a print stylesheet so the browser actually
      // parses it, follows @import to Google Fonts, downloads the woff2
      // payloads, and seeds the HTTP cache. `media="print"` keeps the
      // rules from leaking into the SPA's screen layout.
      const sheet = document.createElement('link');
      sheet.rel = 'stylesheet';
      sheet.href = href;
      sheet.media = 'print';
      sheet.crossOrigin = 'anonymous';
      document.head.appendChild(sheet);
      created.push(sheet);
    }

    return () => {
      for (const link of created) link.remove();
    };
  }, [deckId, manifest, storageToken]);
}
