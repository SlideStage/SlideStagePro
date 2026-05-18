# Bugs and Security Findings

This document records possible code errors and security vulnerabilities found
during source review. Each item includes the reviewed code path, why it looks
risky, and a suggested remediation.

## Reviewed So Far

- Project docs: `docs/ARCHITECTURE.md`, `docs/USER_MANAGEMENT.md`,
  `docs/REGISTRATION_LOCKDOWN.md`, `docs/SPEAKER_NOTES_EDITING.md`,
  `docs/slidestage-platform-spec.md`
- Backend core: `apps/server/src/server.ts`, `apps/server/src/auth.ts`,
  `apps/server/src/routes/auth.ts`, `apps/server/src/routes/admin.ts`,
  `apps/server/src/routes/decks.ts`, `apps/server/src/routes/annotations.ts`,
  `apps/server/src/routes/notes.ts`, `apps/server/src/routes/deck-info.ts`,
  `apps/server/src/routes/export.ts`, `apps/server/src/pipeline/*`
- Shared schemas: `packages/shared/src/manifest.ts`,
  `packages/shared/src/annotations.ts`, `packages/shared/src/notes.ts`,
  `packages/shared/src/deck-info.ts`
- Frontend routing/rendering/auth/presenter tools: `apps/web/src/main.tsx`,
  `apps/web/src/api/client.ts`, `apps/web/src/hooks/useAuth.ts`,
  `apps/web/src/components/DeckStage.tsx`, viewer/presenter/audience pages,
  `apps/web/src/presenter/*`, `apps/web/src/hooks/useStageLayout.ts`,
  `apps/web/src/hooks/useKeyboardNav.ts`
- Test harness: `apps/web/playwright.config.ts`,
  `apps/web/tests/e2e/auth-flow.spec.ts`

## Findings

### 1. Critical: Uploaded slide HTML runs same-origin and can call authenticated APIs (Fixed)

Reviewed paths:

- `apps/web/src/components/DeckStage.tsx`
- `apps/server/src/server.ts`

`DeckStage` renders uploaded slide HTML in an iframe with
`sandbox="allow-scripts allow-same-origin"`. The slide files are served from the
same origin under `/storage/...`, and the CSP for HTML allows inline scripts and
same-origin/default connections.

That means a malicious deck slide can execute JavaScript as a same-origin
document and issue credentialed requests to `/api/*` using the viewer's session
cookie. Even though the session cookie is HttpOnly, same-origin `fetch()` still
sends it. A malicious slide could delete decks, edit notes, export private
content, or use admin endpoints if an admin previews the deck.

Suggested fix:

- Serve uploaded slide content from an isolated origin that has no auth cookies.
- Or remove `allow-same-origin` and avoid any API connectivity from slide frames.
- Add an explicit restrictive CSP for slide HTML, especially `connect-src`.
- Treat slide HTML as untrusted active content in tests.

### 2. Critical: Any user can overwrite and take ownership of another user's deck by reusing `manifest.id` (Fixed)

Reviewed paths:

- `apps/server/src/routes/decks.ts`
- `apps/server/src/pipeline/index.ts`
- `apps/server/prisma/schema.prisma`

Deck IDs are global primary keys (`Deck.id == manifest.id`). During upload,
`ingestArchive()` promotes storage to `<storageRoot>/<manifest.id>`, then
`POST /api/decks` performs `prisma.deck.upsert({ where: { id: m.id }, update:
{ ownerId: userId, ... } })`.

If user B uploads a deck with the same `manifest.id` as user A's existing deck,
the code overwrites the shared storage directory and updates `ownerId` to user B.
This is an authorization failure and a data-loss bug.

Suggested fix:

- Make deck identity scoped by owner, for example a surrogate internal deck ID
  plus `(ownerId, manifestId)` uniqueness.
- If global manifest IDs must remain, reject upload when an existing deck with
  the same ID belongs to another user.
- Store per-upload content under an opaque internal directory, not directly
  under `manifest.id`.
- Add a regression test: user A uploads `sample-stage-a`, user B uploads another
  archive with the same `manifest.id`, user A must retain access and storage.

### 3. High: `/storage/*` is public and bypasses session ownership checks (Fixed)

Reviewed paths:

- `apps/server/src/server.ts`
- `apps/web/src/pages/DeckViewerPage.tsx`
- `apps/web/src/pages/PresenterViewPage.tsx`
- `apps/web/src/pages/AudienceViewPage.tsx`
- `apps/web/src/pages/DeckListPage.tsx`

API routes enforce session ownership, but static files are mounted globally via
`@fastify/static` at `/storage/` without authentication. Anyone who knows or can
guess a deck ID and file path can fetch slide HTML, images, thumbnails,
`manifest.json`, and `speaker-notes.json` directly.

This conflicts with the real-session model documented in
`docs/USER_MANAGEMENT.md`, where deck data is expected to be owner-isolated.

Suggested fix:

- Replace public static mounting with an authenticated file-serving route that
  checks deck ownership before reading from storage.
- Or issue short-lived signed URLs for slide assets.
- If public deck content is intentional, document that clearly and add sharing
  controls instead of assuming owner privacy.

### 4. High: Registration bootstrap has race and OAuth first-user role issues (Fixed)

Reviewed paths:

- `apps/server/src/routes/auth.ts`
- `apps/server/tests/registration-lockdown.test.ts`

Local registration decides bootstrap admin status from `existingUserCount` before
the user creation transaction. Two concurrent first registrations can both see
`User.count() === 0` and both create `admin` users.

OAuth auto-create has a related bootstrap mismatch: when registration is locked
down but the user table is empty, `isRegistrationAllowed()` allows auto-create,
but `findOrCreateOAuthUser()` creates the user without assigning `role:
'admin'`. The first OAuth login can leave the deployment with one normal user,
after which lockdown disables further self-registration and no admin exists.

Suggested fix:

- Move bootstrap role assignment into a transaction with an isolation/locking
  strategy appropriate for the database.
- Ensure every first-account path, including OAuth/OIDC auto-create, promotes
  the first user to admin.
- Add concurrent registration and OAuth-first bootstrap tests.

### 5. High: Upload promotes files before the DB transaction, which can desync storage and database (Fixed)

Reviewed paths:

- `apps/server/src/pipeline/index.ts`
- `apps/server/src/routes/decks.ts`

`ingestArchive()` renames the staged upload into final storage and removes the
previous storage backup before `routes/decks.ts` writes the DB transaction. If
the subsequent DB transaction fails, storage now contains the new deck while the
database may still point to the old manifest/metadata. On re-upload, the old
storage backup may already be deleted.

This can cause broken decks or silent content replacement after transient DB
failures.

Suggested fix:

- Use an opaque versioned staging directory and only switch a DB pointer after
  the DB transaction succeeds.
- Or keep the previous storage backup until after DB commit, and restore it if
  the DB write fails.
- Add a fault-injection test that forces the DB transaction to throw after
  storage promotion.

### 6. Medium: Annotation API accepts arbitrary slide indexes and large stroke payloads (Fixed)

Reviewed paths:

- `apps/server/src/routes/annotations.ts`
- `packages/shared/src/annotations.ts`

Annotation route params only enforce `slideIdx >= 0`. They do not verify that
the slide index exists in the deck. The body schema also allows unbounded stroke
counts, point counts, color string lengths, and coordinate magnitudes, limited
only by the server's 10 MB JSON body cap.

An authenticated user can fill the database with annotations for nonexistent
slides or send very large stroke arrays that are expensive to parse, stringify,
store, and broadcast.

Suggested fix:

- Check `slideIdx` against the deck's slide count before upsert/delete.
- Add schema limits for strokes per slide, points per stroke, color length,
  width range, and finite coordinate ranges.
- Consider per-user deck quotas and rate limits.

### 7. Medium: OAuth/OIDC account linking trusts email without checking provider-side verification (Fixed)

Reviewed paths:

- `apps/server/src/routes/auth.ts`

`findOrCreateOAuthUser()` links an OAuth account to an existing local user when
the profile email matches. The OIDC path reads `email` from claims/userinfo but
does not inspect `email_verified`. For providers that can return unverified or
administrator-controlled email claims, this can link an attacker-controlled OIDC
identity to an existing account.

Suggested fix:

- Require `email_verified === true` before email-based linking for OIDC.
- For providers without verified email semantics, require an existing logged-in
  session to link the account.
- Store provider-specific verification status in `Account` or reject linking.

### 8. Medium: No rate limiting on login, registration, OAuth start, or uploads (Fixed)

Reviewed paths:

- `apps/server/src/routes/auth.ts`
- `apps/server/src/routes/decks.ts`
- `apps/server/src/server.ts`

There is no application-level rate limiting. Password login can be brute-forced,
registration can be spammed while open, OAuth start can be used for redirect
churn, and uploads can repeatedly consume disk/CPU/memory until reverse-proxy
limits intervene.

Suggested fix:

- Add rate limits per IP and per account/email for auth endpoints.
- Add upload quotas per user and per deployment.
- Keep reverse-proxy limits, but do not rely on them as the only protection.

### 9. Medium: Export buffers the entire deck into memory (Fixed)

Reviewed paths:

- `apps/server/src/routes/export.ts`

The export route recursively reads every file into memory, adds each to an
`AdmZip` instance, and then calls `zip.toBuffer()`. A single export can hold
well over the deck size in memory; concurrent exports of near-limit decks can
cause memory pressure or process crashes.

Suggested fix:

- Replace `AdmZip` buffer creation with a streaming ZIP writer.
- Add response backpressure handling and concurrency limits.
- Consider export size limits and audit logging.

### 10. Low: Viewer slide URLs do not encode manifest file paths consistently (Fixed)

Reviewed paths:

- `apps/web/src/pages/DeckViewerPage.tsx`
- `apps/web/src/pages/PresenterViewPage.tsx`
- `apps/web/src/pages/AudienceViewPage.tsx`
- `apps/web/src/components/Overview.tsx`
- `apps/web/src/pages/DeckListPage.tsx`

`DeckListPage` encodes each path segment for thumbnails, but the main viewer,
presenter, audience, and overview slide URLs append `s.file` directly. Valid ZIP
entries with spaces, `#`, `?`, `%`, or non-ASCII path segments can produce
broken URLs or inconsistent behavior between thumbnails and live slides.

Suggested fix:

- Centralize storage URL construction and encode each path segment.
- Add tests with filenames containing spaces and Unicode characters.

### 11. Medium: Stroke sync tracks saved state globally instead of per slide (Fixed)

Reviewed paths:

- `apps/web/src/presenter/useStrokeSync.ts`
- `apps/web/src/pages/DeckViewerPage.tsx`
- `apps/web/src/pages/PresenterViewPage.tsx`

`useStrokeSync()` uses a single `lastSerializedRef` for all slides. The hook is
called with the current slide's strokes, but when navigation changes `slideIdx`,
the same `lastSerializedRef` is reused for the next slide.

This can cause false positives and false negatives:

- After saving a non-empty slide, navigating to an empty slide can schedule a
  `POST []` just because the global last-saved value belongs to the previous
  slide.
- If two slides happen to serialize to the same JSON, one slide's changes can be
  mistaken for already-saved data from another slide.
- If initial annotations have not finished loading, a cross-slide no-op write
  can still clobber stored annotations.

The comments in the hook describe protecting against empty-state clobbering, but
that guard is not keyed by slide.

Suggested fix:

- Store `lastSerializedRef` as `Map<number, string>` keyed by `slideIdx`.
- Seed each slide only after initial annotation load is known, or pass an
  explicit `hydrated` flag before allowing empty writes.
- Add an e2e/server-backed test that draws on slide 1, navigates to slide 2 with
  existing annotations, and verifies slide 2 is not overwritten.

### 12. Low: `AppConfig.databaseUrl` is ignored by the Prisma singleton (Fixed)

Reviewed paths:

- `apps/server/src/config.ts`
- `apps/server/src/db.ts`
- `apps/server/tests/helpers.ts`

`loadConfig()` computes `databaseUrl`, and tests construct an `AppConfig` with a
temporary database URL. However, `getPrisma()` creates `new PrismaClient()`
without using that config value. The actual database comes from
`process.env.DATABASE_URL`, so any caller that injects a config but forgets to
also mutate process env will connect to the wrong database or fail at runtime.

This contradicts the server factory's comment that tests can spin up the server
with an injected config/DB.

Suggested fix:

- Either remove `databaseUrl` from `AppConfig` and document that Prisma is
  environment-driven, or make `getPrisma()` accept/use the configured datasource
  URL.
- In tests, assert that `config.databaseUrl` and the Prisma datasource are the
  same to catch future drift.

### 13. Medium: E2E auth flow depends on stale fixed DB/storage and ambient registration config (Fixed)

Reviewed paths:

- `apps/web/playwright.config.ts`
- `apps/web/tests/e2e/auth-flow.spec.ts`
- `apps/server/src/config.ts`

The Playwright backend always uses fixed paths under `apps/server/e2e.db` and
`apps/server/e2e-storage`, then runs `prisma db push`. It does not remove the
old DB/storage before a CI run, and it does not set
`AUTH_ALLOW_REGISTRATION=true` explicitly.

I reproduced this as an E2E failure after earlier runs left state behind:
`auth-flow.spec.ts` navigated to `/register`, but the app redirected to login
with "Registration is disabled on this server." Because the first test assumes
open registration, stale users plus a disabled registration environment make
the suite order/state-dependent.

When rerun with `AUTH_ALLOW_REGISTRATION=true` set explicitly, the same E2E
suite passed 31/31, confirming the failure is harness configuration/state
rather than the happy-path auth UI itself.

Suggested fix:

- Create a per-run temporary E2E DB and storage directory, or delete the fixed
  `e2e.db` / `e2e-storage` before starting the web server.
- Set `AUTH_ALLOW_REGISTRATION=true` in the auth-flow project environment.
- Split lockdown specs into their own isolated project or backend instance.

### 14. High: Speaker-notes patch can leave disk and database out of sync when DB write fails (Fixed)

Reviewed paths:

- `apps/server/src/routes/notes.ts`

`PATCH /api/decks/:id/notes` writes `<storageRoot>/<deck>/manifest.json` and
`speaker-notes.json` before running the Prisma transaction. If the transaction
then fails, there is no catch block that restores either file. The route returns
an error, but exported decks and static storage now contain notes that the DB
`Deck.manifest`, `Slide.notes`, and `NoteEdit` audit log do not contain.

This is different from `routes/deck-info.ts`, which at least tries to restore
`manifest.json` if the DB transaction throws.

Suggested fix:

- Wrap the DB transaction in a try/catch and restore both disk files from
  captured originals on any DB failure.
- Prefer a versioned storage write: write new files to a staging directory,
  commit the DB update, then atomically swap the served version.
- Add a fault-injection test that makes `tx.slide.update()` or
  `tx.noteEdit.createMany()` throw after disk writes.

### 15. Medium: Concurrent notes/deck-info patches can silently overwrite each other (Fixed)

Reviewed paths:

- `apps/server/src/routes/notes.ts`
- `apps/server/src/routes/deck-info.ts`
- `apps/web/src/hooks/useNotesSync.ts`
- `apps/web/src/hooks/useDeckInfoSync.ts`

Both edit routes read the full `Deck.manifest` JSON once, mutate a subset of it,
then write the entire manifest mirror back to disk and DB. There is no optimistic
version check, row lock, or merge against the latest manifest inside the
transaction.

Two tabs can therefore lose edits:

- Tab A reads manifest, changes slide 1 notes.
- Tab B reads the same old manifest, changes slide 2 notes.
- Whichever request commits last writes a full manifest that lacks the other
  tab's change.

The same pattern applies to deck metadata and slide labels.

Suggested fix:

- Add an `updatedAt` / revision precondition to the PATCH body and reject stale
  edits with 409.
- Or refetch and merge the latest manifest inside a transaction before writing.
- Add concurrent PATCH tests for disjoint slide-note and slide-label edits.

### 16. Medium: ZIP extraction buffers entries and does not re-check the real per-file size (Fixed)

Reviewed paths:

- `apps/server/src/pipeline/extract.ts`

`safeExtract()` checks `entry.header.size` against `maxFileBytes`, then calls
`entry.getData()`, which materializes the full decompressed file in memory. If
the actual buffer length differs from the ZIP header, the code only re-checks
the cumulative decompressed limit. It does not re-check `buf.length` against
`maxFileBytes`, despite the comment saying caps are re-validated.

This leaves two risks: a crafted archive can bypass the per-file cap when the
header is misleading, and a very compressed entry is still inflated into memory
before the write path can stream/backpressure it.

Suggested fix:

- Re-check both `buf.length > maxFileBytes` and cumulative total after
  decompression.
- Prefer a streaming ZIP reader that counts bytes while extracting instead of
  buffering each file.
- Add tests with a corrupted/mismatched ZIP size header and a highly compressed
  large entry.

### 17. Medium: Thumbnail paths can probe outside the unpack directory (Fixed)

Reviewed paths:

- `packages/shared/src/manifest.ts`
- `apps/server/src/pipeline/validate.ts`

`manifestSchema` rejects `..` and absolute paths only for `slides[].file`.
`slides[].thumbnail`, asset file paths, and font file paths are not normalized
the same way. During upload validation, thumbnail paths are passed directly to
`path.join(unpackDir, s.thumbnail)` and `fs.stat()`.

That means a manifest can set a thumbnail like `../../../some/local/file`.
If the file exists on the server, validation keeps the thumbnail path; if it
does not, validation nulls it. The uploaded deck can therefore become a local
file-existence oracle, and the frontend may later emit malformed storage URLs
containing traversal segments.

Suggested fix:

- Reuse one manifest-path validator for slide files, thumbnails, asset files,
  and font files.
- Resolve each path and assert it remains under the unpack directory before
  touching the filesystem.
- For thumbnails, require a regular file when the path is kept.

### 18. Medium: Manifest and edit schemas allow very large strings/records (Fixed)

Reviewed paths:

- `packages/shared/src/manifest.ts`
- `packages/shared/src/notes.ts`
- `packages/shared/src/deck-info.ts`
- `apps/server/src/routes/notes.ts`
- `apps/server/src/routes/deck-info.ts`

Several user-controlled strings and records have no practical maximum length:
manifest title/subtitle/author/description, slide labels, notes, tokens, asset
arrays, and the sparse `notes` / `slideLabels` PATCH maps. Upload body limits
and the 10 MB JSON body cap provide a coarse ceiling, but a single request can
still store and return multi-megabyte manifest JSON, notes, or labels that the
UI tries to render and that every deck fetch/export carries.

Suggested fix:

- Add max lengths that match the UI constraints: title, subtitle, author,
  description, labels, and notes.
- Limit record sizes in `notesPatchBodySchema` and `deckInfoPatchBodySchema` to
  the deck's slide count before writing.
- Consider a separate quota for manifest JSON size after parsing.

### 19. Medium: Credentialed CORS allows any localhost origin (Fixed)

Reviewed paths:

- `apps/server/src/server.ts`

The CORS policy allows credentials and accepts every
`http://localhost:*` / `http://127.0.0.1:*` origin, regardless of
`WEB_ORIGIN`. During local use or self-hosting through localhost, any unrelated
local web app can make credentialed `fetch()` calls to this API. Because the
session cookie is scoped to the API host and localhost ports are same-site,
browser requests from another localhost port can include the user's session.

Suggested fix:

- Restrict wildcard localhost origins to an explicit development mode.
- In production, allow only `config.webOrigin`.
- Consider rejecting credentialed CORS for unknown origins even when they are
  localhost.

### 20. Critical: Slide CSS / images / fonts return 401 in viewer because sandboxed iframe subresources can't authenticate (Fixed)

Reviewed paths:

- `apps/server/src/routes/storage.ts`
- `apps/server/src/storage-token.ts`
- `apps/server/src/routes/decks.ts`
- `apps/web/src/utils/storageUrl.ts`
- `apps/web/src/components/DeckStage.tsx`

After fixing finding #1, slide iframes are sandboxed as `allow-scripts` only —
no `allow-same-origin` — which puts every slide document at an opaque origin.
Browsers then treat every subresource fetch from that iframe (`../shared/tokens.css`,
images, fonts, inline-CSS `url(...)`) as cross-site for SameSite cookie purposes,
so neither the SameSite=Lax session cookie nor any path-scoped Lax cookie rides
along. The `/storage/:id/*` route enforced cookie-only auth and therefore
returned 401 on every nested asset — uploaded decks rendered with no CSS, no
images, and no fonts. ORB compounded the breakage: the 401 JSON body would also
be blocked with `ERR_BLOCKED_BY_ORB` because the request expected `text/css`.

Fix:

- Mint short-lived (default 1h), HMAC-signed deck-scoped tokens
  (`{ d: deckId, u: userId, exp }`) keyed off `AUTH_STORAGE_TOKEN_SECRET`
  (auto-generated per-process if unset). Exposed via `signStorageToken` /
  `verifyStorageToken` in `storage-token.ts`.
- `/api/decks` and `/api/decks/:id` return a fresh `storageToken` alongside
  every deck so the SPA can hand it to `storageAssetUrl(deckId, file, token)`
  for any `<img>` thumbnail, iframe `src`, presenter/audience preview, etc.
- The `/storage/:id/*` route accepts `?t=<token>` first, falls back to the
  session cookie, and **rewrites every `.html` response** so that every
  relative `href`/`src`/`poster`/`srcset` attribute and every inline-CSS
  `url(...)` carries the token — the browser does *not* inherit the parent
  iframe's `?t=` when it resolves relative URLs, so without rewriting the
  subresource requests would still be unauthenticated. Absolute URLs (https,
  scheme-relative, data:, blob:, mailto:, fragment-only) are left alone.
- Unauthorised access (missing/bad token AND no cookie OR wrong owner) now
  returns 404 instead of 401 so unauthenticated probes can no longer
  enumerate which deck ids exist.
- Possession of a token IS the access grant (token payload pins the user
  id), so a stranger who somehow obtains a token URL can read the deck
  until the token expires — operators should treat token URLs the same way
  they would a signed S3 link.

### 21. Medium: Every slide turn shows a webfont swap flash (Fixed)

Reviewed paths:

- `apps/web/src/components/DeckStage.tsx`
- `apps/server/src/routes/storage.ts`
- `apps/web/src/hooks/useDeckFontWarmup.ts`
- `apps/web/src/pages/DeckViewerPage.tsx` / `PresenterViewPage.tsx` / `AudienceViewPage.tsx`

Each slide is rendered into its own sandboxed iframe at an opaque origin,
so each one carries an isolated `FontFaceSet`. Slide CSS commonly pulls
webfonts via `@import url("https://fonts.googleapis.com/...")` with
`font-display: swap`, which means every iframe goes through the fallback-→
-webfont swap on first paint. The old `DeckStage` promoted the buffered
iframe at `iframe.onload`, but `onload` fires at `document.readyState ===
'complete'` — *before* webfonts have actually finished loading. The user
saw a fallback-font flash on every page turn, plus a redundant network
round-trip for the same Google Fonts files on each fresh iframe.

Fix:

- The storage route injects a short `<script>` into every slide HTML
  (`injectReadySignal` in `routes/storage.ts`) that calls
  `document.fonts.ready`, waits two `requestAnimationFrame`s, then
  `parent.postMessage({type: 'slidestage:ready'}, '*')`. The script is
  bounded with `setTimeout(send, 1500)` so pathological decks can't
  pin the viewer on a stale slide.
- `DeckStage` now requires **both** signals (`iframe.onload` AND
  `slidestage:ready`) before promoting a buffered slot. The old slot
  stays visible until the new one is stable, eliminating the swap
  flash. A 2s client-side safety net force-promotes if the iframe is
  silent.
- Immutable assets (fonts, images, video, audio) are served with
  `Cache-Control: private, max-age=31536000, immutable` so subsequent
  iframe mounts hit disk cache. HTML and JSON keep the short
  `max-age=300` policy.
- `useDeckFontWarmup` preloads every CSS asset in the deck manifest
  into the SPA's HTTP cache (`<link rel="preload" as="style">` + a
  `media="print"` stylesheet so the browser also follows `@import` and
  caches the woff2 payloads). This makes even the very first slide
  load fast instead of waiting on Google Fonts.

### 22. Medium: Ready-gate fix for #21 made every keypress feel laggy (Fixed)

Reviewed paths:

- `apps/web/src/components/DeckStage.tsx`

The initial fix for #21 had `DeckStage` block the iframe `data-active`
flip on the `slidestage:ready` postMessage, which meant every navigation
waited for the destination's webfonts to load before becoming visible.
That eliminated the font swap flash but turned every arrow keypress into
a noticeable 100-300ms lag — the very thing that double-buffered
implementations of this pattern often regress to.

Fix:

- `DeckStage` now keeps a **persistent pool** of `POOL_SIZE` (=3)
  iframes — the active slide plus its preload neighbours — mounted at
  the same time. React keys each slot by index, *not* by URL, so when
  the LRU policy reassigns a slot's `src` the underlying iframe DOM
  node (and its FontFaceSet) is reused. Sequential navigation finds the
  next slide already loaded *and* ready in the pool, so the active
  flip is a single-rAF CSS opacity change — zero latency, zero flash.
- Non-sequential jumps (overview pick, Goto N) may land on a slot the
  pool hadn't warmed yet. The visibility resolver falls back to the
  most-recently displayed slot (`lastVisibleSrc`) until the new active
  slot's `data-ready` flag flips, so the user sees a continuous prior
  slide rather than a blank frame.
- The 1.5s server-side ready timeout and 2s client-side safety net are
  retained so a deck with broken fonts or scripts can't pin the
  viewer indefinitely.
