/**
 * Derive the `<iframe sandbox="...">` token set for a live slide based on the
 * deck manifest's `compat.requires` array.
 *
 * Baseline: every live slide runs with `allow-scripts` so author HTML can
 * animate / wire up presenter hooks. Optional trust capabilities loosen the
 * sandbox per spec §6.3 / Lite trust model:
 *
 *   - `same-origin-storage` / `broadcast-channel` → add `allow-same-origin`
 *     so `localStorage`, `IndexedDB`, `BroadcastChannel`, and `cookie` work
 *     inside the slide iframe's opaque blob origin.
 *   - `window-open` → add `allow-popups allow-popups-to-escape-sandbox` so
 *     `window.open(...)` can succeed.
 *
 * Decks that declare neither (the default for Pro packages today) keep the
 * minimum surface and load with `allow-scripts` only.
 */
import type { ManifestCompat, TrustCapability } from '@slidestage/shared';

const BASELINE_TOKEN = 'allow-scripts';

const CAPABILITY_TOKENS: Record<TrustCapability, readonly string[]> = {
  'same-origin-storage': ['allow-same-origin'],
  'broadcast-channel': ['allow-same-origin'],
  'window-open': ['allow-popups', 'allow-popups-to-escape-sandbox'],
};

export function sandboxTokensForCompat(
  compat?: ManifestCompat | null,
): string[] {
  const tokens = new Set<string>([BASELINE_TOKEN]);
  const requires = compat?.requires ?? [];
  for (const capability of requires) {
    const extra = CAPABILITY_TOKENS[capability];
    if (!extra) continue;
    for (const token of extra) tokens.add(token);
  }
  return Array.from(tokens).sort();
}

/** Same as {@link sandboxTokensForCompat} but as a space-joined attribute value. */
export function sandboxForCompat(compat?: ManifestCompat | null): string {
  return sandboxTokensForCompat(compat).join(' ');
}
