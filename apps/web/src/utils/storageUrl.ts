/**
 * Build a `/storage/<deckId>/<path>` URL. When `token` is supplied it's
 * appended as `?t=<token>`, which is the only way sandboxed (no
 * `allow-same-origin`) slide iframes can authenticate against `/storage` —
 * SameSite=Lax session cookies never ride along on opaque-origin subresource
 * requests. The SPA itself can still drop the token; the storage route falls
 * back to the session cookie when no token is present.
 */
export function storageAssetUrl(
  deckId: string,
  relativePath: string,
  token?: string,
): string {
  const encodedPath = relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
  const url = `/storage/${encodeURIComponent(deckId)}/${encodedPath}`;
  return token ? `${url}?t=${encodeURIComponent(token)}` : url;
}
