# SlideStage Pro — Architecture (v0)

> Companion docs: [`API_CONTRACT.md`](API_CONTRACT.md) ·
> [`AUTH_FLOW.md`](AUTH_FLOW.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md) ·
> [`LITE_PACKAGE_BOUNDARY.md`](LITE_PACKAGE_BOUNDARY.md)

## 1. One-paragraph summary

SlideStage Pro is a **self-hosted `.stage` presentation platform**. It wraps
the open-source Lite runtime (`@slidestage/core`, `@slidestage/ui`,
`@slidestage/lite-preset`) with a thin server that adds **multi-user storage,
admin-controlled signup, server-side notes/annotations, and Docker-based
deployment**. v0 ships with a single SQLite database, a local filesystem
storage driver, and a closed-registration auth flow (Better Auth + invites).

## 2. Top-level diagram

```
              ┌─────────────────────────────┐
              │   Browser (any modern UA)   │
              │   - React 19 SPA            │
              │   - lite-preset DeckViewer  │
              │   - pro-preset (no-op v0)   │
              └──────────────┬──────────────┘
                             │ HTTP (port 80)
                             ▼
              ┌─────────────────────────────┐
              │   nginx (edge proxy)        │
              │   /        → web:8080       │
              │   /api/*   → api:3000       │
              └────────┬────────────────────┘
                       │           │
              ┌────────▼─┐   ┌─────▼──────────┐
              │  web     │   │  api           │
              │  nginx + │   │  Hono on Node22│
              │  Vite    │   │  Better Auth   │
              │  bundle  │   │  Prisma client │
              └──────────┘   │  Storage drv   │
                             └─────┬──────────┘
                                   │
                       ┌───────────┴────────────┐
                       │                        │
              ┌────────▼────────┐    ┌──────────▼─────────┐
              │ SQLite (WAL)    │    │ /data volume       │
              │ /data/slide…    │    │ decks/<deckId>/    │
              │   stage-pro.    │    │   <versionId>.stage│
              │   sqlite        │    │                    │
              └─────────────────┘    └────────────────────┘
```

## 3. Repository layout

| Path | Owner | Purpose |
|---|---|---|
| `apps/api/` | server | Hono server, Prisma client, Better Auth, storage |
| `apps/web/` | client | Vite + React 19 + react-router v7 |
| `packages/pro-preset/` | shared | Pro-only SlideStage plugin (`proPreset()`) |
| `packages/pro-shared/` | shared | Types + constants (zero runtime deps) |
| `prisma/schema.prisma` | single | Single SQLite schema — Better Auth tables + business + invites |
| `vendor/*.tgz` | bridge | v0-only vendored Lite packages |
| `infra/docker/` | infra | Multi-stage Dockerfiles (api, web) |
| `infra/nginx/` | infra | Edge proxy + SPA fallback config |
| `scripts/` | infra | Boundary checker, vendor sync, fixture builder |
| `docs/` | meta | Frozen contracts (API, Auth) + this file |

## 4. Module boundaries (`@slidestage/*` import graph)

```
                ┌───────────────────────────────┐
                │   @slidestage/core            │  ← vendor tarball (Lite)
                │     - manifestSchema          │
                │     - loadDeck                │
                │     - pathSafety              │
                │     - createSlideStage        │
                └────────────┬──────────────────┘
                             │
        ┌────────────────────┼─────────────────────────────┐
        ▼                    ▼                             ▼
┌───────────────┐  ┌───────────────────┐         ┌──────────────────────┐
│ @slidestage/  │  │ @slidestage/      │         │ @slidestage/         │
│   ui (Lite)   │  │   lite-preset     │         │   pro-preset (Pro)   │
└──────┬────────┘  └──────┬────────────┘         └──────┬───────────────┘
       │                  │                             │
       └──────────────────┴─────────────────────────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ apps/web (Pro SPA)  │
                  └─────────────────────┘

                  ┌─────────────────────┐         ┌──────────────────────┐
                  │ apps/api (Pro srv)  │ ◄────── │ @slidestage/         │
                  │                     │         │   pro-shared (Pro)   │
                  └─────────────────────┘         └──────────────────────┘
                             │
                             ▼
                     @slidestage/core
                     (manifestSchema, loadDeck, pathSafety only)
```

**Hard rules** (enforced by `scripts/check-boundaries.mjs`):

1. Pro never depends on the Lite checkout (`file:../SlideStageLite/...`).
2. Pro never re-implements `manifestSchema` / `loadDeck` / `pathSafety` — it
   always `import`s them from `@slidestage/core`.
3. No edition branching: no `isPro`, no `VITE_APP_EDITION`.
4. `apps/api` never imports `react` / `react-dom`.
5. `apps/web` never imports `@prisma/client`, `hono`, `better-sqlite3`, or
   `node:fs`.
6. Server modules (auth/db/storage) live only in `apps/api/src/`.

## 5. API request flow (upload as the canonical example)

1. Browser drags a `.stage` file onto `/decks/upload`.
2. SPA `POST /api/decks` with `multipart/form-data`, session cookie attached.
3. `attachSession` middleware → `requireAuth` → reject if not signed in.
4. Route handler calls `processUploadPipeline(buffer)` which executes the
   contract-frozen order:
   1. **Size guard** vs `UPLOAD_MAX_BYTES`.
   2. **`sha256(buffer)`** for de-duplication / ETag.
   3. **`loadDeck(buffer)`** from `@slidestage/core/deck/loadDeck` — fails
      `INVALID_STAGE_ZIP` if not a zip or `manifest.json` missing.
   4. **`manifestSchema.parse(json)`** — fails `INVALID_MANIFEST` on zod
      validation error.
   5. For every entry path: `normalizePackagePath` from
      `@slidestage/core/deck/pathSafety` — fails `UNSAFE_PATH` on `..`
      escapes, absolute paths, or backslashes.
   6. Compute fingerprint (deterministic from manifest).
   7. `storage.putObject(\`decks/<deckId>/<versionId>.stage\`, buffer)`.
   8. `prisma.$transaction([deck.create, deckVersion.create, deck.update])`.
5. Return `201` with the deck summary + manifest summary (see API_CONTRACT §3).
6. SPA navigates to `/decks/<newId>`; DeckDetail page calls
   `/api/decks/:id/blob` → `loadDeck(arrayBuffer)` → `DeckViewer`.

If **any** step fails the pipeline aborts and returns a structured error.
The Prisma transaction guarantees that a half-written deck never exists.

## 6. Persistence layer

### 6.1 Tables (see [`prisma/schema.prisma`](../prisma/schema.prisma))

| Table | Owned by | Purpose |
|---|---|---|
| `user`, `session`, `account`, `verification` | Better Auth | Identity + sessions. `user.role` is Pro's extension column. |
| `deck` | Pro | Logical deck handle (id, title, fingerprint, currentVersionId, ownerId). |
| `deck_version` | Pro | Each upload produces a new version; stores objectKey + manifestJson + sha256. |
| `slide_note` | Pro | Plain-text notes, keyed by `(deckId, slideIndex)`. |
| `slide_annotation` | Pro | Opaque JSON annotation payloads, keyed the same way. |
| `invite` | Pro | Admin-minted tokens used to gate `sign-up/email`. |

### 6.2 SQLite operational pragmas

Applied on every Prisma client construction (see
`apps/api/src/db/prisma.ts`):

```sql
PRAGMA journal_mode = WAL;   -- concurrent readers while a writer is active
PRAGMA busy_timeout = 5000;  -- wait 5s before SQLITE_BUSY
PRAGMA foreign_keys = ON;    -- enforce Prisma's onDelete: Cascade
```

### 6.3 Repository pattern

Route handlers never call `prisma.*` directly. They go through
`apps/api/src/db/repositories/{deck,version,note,annotation,invite,user}.ts`.
This isolation makes it trivial to swap SQLite for PostgreSQL: re-target
Prisma's datasource, regenerate the client, and the repository surface is
unchanged.

## 7. Storage driver

```ts
interface StorageDriver {
  putObject(key: string, bytes: Uint8Array | Buffer): Promise<void>;
  getObject(key: string): Promise<ReadableStream<Uint8Array> | Buffer>;
  deleteObject(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
```

v0 ships only `apps/api/src/storage/local.ts` (writes under
`config.storage.dataDir`). Adding S3 / MinIO is a matter of dropping a new
file at `apps/api/src/storage/s3.ts` and wiring it in `createStorage()`.
**No other code needs to change** — the upload pipeline, blob streaming, and
delete cascade all use the interface.

## 8. Auth (Better Auth + closed registration)

The full contract lives in [`AUTH_FLOW.md`](AUTH_FLOW.md). The short version:

- Login: `POST /api/auth/sign-in/email` (Better Auth standard).
- Signup: `POST /api/auth/sign-up/email` requires `inviteToken`; a server
  hook validates the invite **before** Better Auth creates the user, and
  another hook **marks the invite used + sets `user.role`** after.
- Bootstrap: on first boot with `user` table empty, the API reads
  `BOOTSTRAP_ADMIN_*` env and creates the first admin. If those env vars are
  absent it exits with code 2 — refusing to serve a publicly-writable site
  with no admin.
- Sessions: HttpOnly cookies; the SPA uses `better-auth/react`'s
  `useSession()`.

## 9. Pro plugin model

Pro features attach to a SlideStage instance via a plugin returned by
`proPreset()`:

```ts
// packages/pro-preset/src/proPreset.ts
export function proPreset(options: ProPresetOptions = {}): SlideStagePlugin {
  return {
    name: "pro",
    install(stage) {
      // future Pro capabilities register here
    },
  };
}
```

v0 the plugin is a no-op — it exists so the wiring is in place. **The
presence of the plugin in the bundle is how the app expresses "this is
Pro"**, not a boolean flag. This is the canonical way to keep Lite source
free of edition branches.

## 10. Vendor tarball bridge (temporary)

Until the Lite packages are published to npm, Pro consumes them as
vendored tarballs in `vendor/` (committed). `scripts/sync-vendor.mjs`
regenerates them from a local Lite checkout. See
[`LITE_PACKAGE_BOUNDARY.md`](LITE_PACKAGE_BOUNDARY.md) for the upgrade path.

## 11. Non-goals for v0

- OAuth providers (GitHub / Google).
- Passkey / WebAuthn / 2FA.
- Multi-tenant orgs.
- Real-time presence over WebSockets.
- Server-side rendering.
- S3 / MinIO storage (interface exists, only `local` is wired).
- Email-based password reset (admin re-issues an invite instead).

These all have well-marked extension points; v0 deliberately avoids them to
keep the surface small.
