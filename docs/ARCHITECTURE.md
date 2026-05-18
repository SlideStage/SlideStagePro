# slidestage Platform — Architecture & Handoff Guide

> **Audience.** Another coding agent (or human engineer) picking the project up.
> Goal: get oriented in <10 minutes, run the stack locally, find the right file
> for any feature, and know exactly which seams are stable vs. where Stage B
> work begins.
>
> **Scope of this doc.** Everything currently merged on `main` (Stage A MVP).
> Treat the [slidestage Platform Spec](../slidestage-platform-spec.md) as the
> *contract*; this document is the *implementation map*.

---

## 1. Project at a glance

`slidestage-platform` is a self-hosted host for `.stage` packages — a ZIP
container that holds `manifest.json + slides/*.html + assets/* + thumbnails/*`.
The **package** is content-only. The **platform** owns the runtime: navigation,
PowerPoint-style presenter tools, annotations, and cross-window mirroring. See
spec §1 for the rationale; the short version is that upgrading the runtime
(e.g. shipping a smarter laser, adding cloud annotations) **must not require
re-packing every existing deck**.

Stage A (this codebase, version `0.1.0`) ships:

| Area | What works | Spec § |
|---|---|---|
| Upload pipeline | Multipart upload → safe extract → manifest validate → atomic promote | §5 |
| Storage / serving | `/storage/<id>/...` static, hardened with CSP | §6.3 |
| REST API | Decks CRUD + annotations CRUD + health | §5.5 / §8.4 |
| Library / Upload UI | React + Vite, fake login via `x-user-id` | — |
| Single-window viewer | iframe stage, letterbox scale, keyboard nav, Overview, Speaker | §6, §10, §11 |
| PowerPoint-style presenter | Right-dock toolbar, audience pop-out, BroadcastChannel sync, timer | §7, §9 |
| Nine-tool presenter set | mouse / laser / pen / highlighter / eraser / spotlight / blackout / whiteout | §7.1 |
| Annotations | Stroke schema, per-(deck,user,slide) persistence, debounced sync | §8 |
| Speaker-notes editing | Owner-side `PATCH /notes` updates DB + manifest mirror + on-disk manifest.json + speaker-notes.json; auto-save 800 ms debounce, slide-change & unmount flush; lock-by-default Edit mode + per-slide audit log (`GET /notes/audit`) | §9 |
| Deck info editing | Owner-side `PATCH /decks/:id/info` updates DB columns + manifest mirror + on-disk manifest.json + `Slide.label` rows; auto-save 800 ms debounce, flush-on-close; covers `title` / `subtitle` / `author` / `description` and per-slide `label`. `title` cannot be cleared. | §9 |
| Deck export | `GET /decks/:id/export` re-packs the current storage dir into a fresh `.stage` zip (incl. edited notes and edited deck info) for download | §15 (FAQ) |
| Tests | vitest server suite (incl. notes/export) + 4× Playwright e2e suites | §14 |

Out of scope for Stage A (search this doc for "TODO" — §13):
multi-user real-time co-annotation, cloud-side packer, real auth, thumbnail
auto-generation, schema migration tooling, mobile / touch-first polish.

---

## 2. Repository layout

```
SlideStage/
├── apps/
│   ├── server/                     # Fastify + Prisma backend (Node 20+)
│   │   ├── src/
│   │   │   ├── main.ts             # bootstrap + signal handling
│   │   │   ├── server.ts           # buildServer() factory (used by tests too)
│   │   │   ├── config.ts           # AppConfig + env parsing + sane defaults
│   │   │   ├── db.ts               # Prisma singleton + disconnect
│   │   │   ├── auth.ts             # Stage-A fake login (x-user-id header)
│   │   │   ├── pipeline/
│   │   │   │   ├── extract.ts      # zip-slip / zip-bomb / symlink defenses
│   │   │   │   ├── validate.ts     # manifest.json + on-disk slide existence
│   │   │   │   └── index.ts        # ingestArchive() orchestration + atomic promote
│   │   │   └── routes/
│   │   │       ├── decks.ts        # POST/GET/DELETE /api/decks
│   │   │       ├── annotations.ts  # GET/POST/PATCH/DELETE /api/decks/:id/annotations
│   │   │       ├── notes.ts        # PATCH /api/decks/:id/notes (owner-only)
│   │   │       └── export.ts       # GET   /api/decks/:id/export → .stage zip
│   │   ├── prisma/
│   │   │   └── schema.prisma       # SQLite; Deck / Slide / Annotation
│   │   ├── tests/
│   │   │   ├── helpers.ts          # spins up Fastify with isolated tmp DB + storage
│   │   │   └── upload.test.ts      # vitest: ingest + annotation API
│   │   ├── .env.example
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   └── web/                        # React + Vite SPA
│       ├── src/
│       │   ├── main.tsx            # router + StrictMode root
│       │   ├── App.tsx             # shell (header/nav)
│       │   ├── api/client.ts       # fetch wrapper, deck + annotation endpoints
│       │   ├── hooks/
│       │   │   ├── useAuth.ts          # localStorage-backed user id
│       │   │   ├── useDeckLoader.ts    # GET deck + initial annotations (also exposes setDeck)
│       │   │   ├── useKeyboardNav.ts   # nav + Overview/Speaker/Fullscreen keys
│       │   │   ├── useNotesSync.ts     # debounced PATCH /notes + dirty/saving/saved status
│       │   │   └── useStageLayout.ts   # ResizeObserver letterbox math + viewportToStage()
│       │   ├── components/
│       │   │   ├── DeckStage.tsx       # iframe + transform stage
│       │   │   ├── EditableNotes.tsx   # textarea editor (panel + strip variants)
│       │   │   ├── Overview.tsx        # all-slides grid (O)
│       │   │   └── SpeakerNotes.tsx    # one-pane speaker view (S)
│       │   ├── presenter/
│       │   │   ├── types.ts            # Tool union, PEN_COLORS, widths
│       │   │   ├── usePresenter.ts     # reducer + shortcut hook
│       │   │   ├── usePresentationSync.ts  # BroadcastChannel wrapper
│       │   │   ├── useStrokeSync.ts    # debounced PUT to /annotations/:idx
│       │   │   ├── AnnotationOverlay.tsx   # SVG strokes + pointer capture + draft preview
│       │   │   ├── LaserPointer.tsx    # 14px dot + 800ms trail (local + mirror)
│       │   │   ├── Spotlight.tsx       # radial-gradient mask
│       │   │   ├── Blackout.tsx        # solid #000/#fff overlay
│       │   │   └── Toolbar.tsx         # auto-hide bottom bar OR right-dock variant
│       │   ├── pages/
│       │   │   ├── DeckListPage.tsx    # /decks
│       │   │   ├── UploadPage.tsx      # /decks/upload
│       │   │   ├── DeckViewerPage.tsx  # /decks/:id          (single-window)
│       │   │   ├── PresenterViewPage.tsx # /decks/:id/presenter (PowerPoint-style)
│       │   │   └── AudienceViewPage.tsx  # /decks/:id/audience  (mirror, pure read)
│       │   └── styles/globals.css      # all CSS lives here for now (~400 lines)
│       ├── tests/e2e/
│       │   ├── deck-flow.spec.ts       # upload → list → navigate → overview → speaker
│       │   ├── notes-edit.spec.ts      # edit notes → reload → still there → export zip verifies
│       │   ├── presenter-tools.spec.ts # toolbar + draw pen + ctrl+z + persistence
│       │   └── dual-window.spec.ts     # presenter ⇄ audience BroadcastChannel sync
│       ├── index.html
│       ├── vite.config.ts              # proxies /api + /storage to backend
│       ├── playwright.config.ts        # spins up backend + frontend webServers
│       └── tsconfig.json
├── packages/
│   └── shared/                     # @slidestage/shared (zero runtime deps)
│       ├── src/
│       │   ├── manifest.ts         # Zod schema + types (mirror of spec §3)
│       │   ├── annotations.ts      # strokeSchema + REST body schemas
│       │   ├── notes.ts            # notesPatchBodySchema + types (PATCH /notes)
│       │   ├── errors.ts           # ERROR_CODES + SlideStageError class
│       │   └── index.ts
│       └── package.json
├── scripts/
│   └── build-fixture.mjs           # generates fixtures/out/sample.stage (zero-dep ZIP)
├── fixtures/out/sample.stage    # built on demand by `pnpm fixtures` (gitignored)
├── slidestage-platform-spec.md       # source-of-truth spec — read me first
├── docs/ARCHITECTURE.md            # ← you are here
├── package.json                    # workspace root
├── pnpm-workspace.yaml             # apps/* + packages/*
├── tsconfig.base.json
└── pnpm-lock.yaml
```

> **Workspace scopes.** `@slidestage/server`, `@slidestage/web`, `@slidestage/shared`.
> `shared` is built (`tsc → dist/`) and consumed by the others via
> `workspace:*`, so changes to schemas need a `pnpm build:shared` (or a
> running `pnpm --filter @slidestage/shared dev`) before TypeScript-aware
> tooling sees them.

---

## 3. Quickstart

### 3.1 Prereqs

- Node ≥ 20 (`engines.node` enforces it)
- pnpm 10.x (`packageManager` pins `pnpm@10.28.0`)
- Nothing else: SQLite is bundled with Prisma, the test fixture is built in pure
  Node, no Docker required for dev.

### 3.2 First-time setup

```bash
pnpm install
pnpm build:shared                                 # builds @slidestage/shared/dist
pnpm --filter @slidestage/server exec prisma generate
pnpm --filter @slidestage/server exec prisma db push --skip-generate
pnpm fixtures                                     # → fixtures/out/sample.stage
```

### 3.3 Run dev servers

```bash
# both at once (web on :5173, server on :4000)
pnpm dev

# or individually
pnpm dev:server     # tsx watch, picks up apps/server/.env
pnpm dev:web        # vite, proxies /api + /storage to the server
```

Open http://localhost:5173 → upload `fixtures/out/sample.stage` → click into
the deck. The browser stores `slidestage.userId` in `localStorage`; change it via
DevTools to simulate another user (the backend trusts the `x-user-id` header
verbatim — see §3.5 of this doc and `apps/server/src/auth.ts`).

### 3.4 Tests

```bash
pnpm test:server                                  # vitest (server-only)
pnpm --filter @slidestage/web test:e2e:install      # one-off: download chromium
pnpm test:e2e                                     # Playwright; auto-spins backend on :4001 + web on :5173
```

The Playwright config builds a *separate* SQLite (`apps/server/e2e.db`) and
storage (`apps/server/e2e-storage/`) — see `apps/web/playwright.config.ts`.
That keeps your dev DB alone.

### 3.5 Auth model

There is no real auth. Every request reads `x-user-id` (or `?userId=`) and
treats that string as the owner. The web UI sets the header automatically from
`localStorage['slidestage.userId']` (default `demo-user`). When a real auth
provider lands, **only `apps/server/src/auth.ts` and `apps/web/src/hooks/useAuth.ts`
need to change**; the rest of the code uses `getUserId(req)` / `getCurrentUserId()`.

### 3.6 Useful one-liners

```bash
# rebuild the test deck after editing scripts/build-fixture.mjs
pnpm fixtures

# nuke the dev database and re-apply schema (loses uploaded decks)
pnpm --filter @slidestage/server exec prisma migrate reset --force --skip-seed

# inspect the SQLite DB
pnpm --filter @slidestage/server exec prisma studio

# typecheck everything (no emit) without running tests
pnpm -r exec tsc -p tsconfig.json --noEmit
```

---

## 4. Backend — `@slidestage/server`

### 4.1 Boot path

`main.ts` → `loadConfig()` → `buildServer(config)` → `app.listen()`.
`buildServer` is the testable factory; `apps/server/tests/helpers.ts` re-uses
it with an isolated config so vitest never binds a port.

```22:33:apps/server/src/main.ts
const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

Plugins registered in order:

1. `@fastify/cors` — allows the configured `WEB_ORIGIN` *plus any localhost
   port* (DX).
2. `@fastify/multipart` — `fileSize: maxUploadBytes`, single file per request.
3. `@fastify/static` — mounts `STORAGE_ROOT` at `/storage/` with **per-file
   CSP** for HTML responses (frame-ancestors 'self', script-src self+inline+https,
   etc. — see spec §6.3). The route enforces deck ownership and accepts either a
   short-lived `?t=<storage-token>` query parameter (HMAC-signed, `{deckId,
   userId, exp}`) **or** the session cookie. Tokens are required for any
   sandboxed slide iframe because the iframe runs at an opaque origin, which
   means SameSite cookies never ride along on its subresource requests. HTML
   responses are rewritten on the way out so that every relative `href`/`src`/
   `poster`/`srcset` attribute and every inline-CSS `url(...)` carries the
   token — see `routes/storage.ts › rewriteHtmlWithToken` and finding #20 in
   `docs/bugs.md`.
4. `GET /api/health` — used by E2E `webServer.url`.
5. `registerDeckRoutes(app, { config })`
6. `registerAnnotationRoutes(app)`
7. `registerNotesRoute(app, { config })`
8. `registerExportRoute(app, { config })`
9. Final error handler → maps `SlideStageError` to its `statusCode` + `code`, and `ZodError` (anywhere a route uses Zod parsing) to a 400 with `EBADMANIFEST` so request-body validation never leaks to a 500.

### 4.2 Configuration

`apps/server/src/config.ts` reads (env var → fallback):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `HOST` | `0.0.0.0` | |
| `STORAGE_ROOT` | `apps/server/storage/` | resolved from cwd if relative |
| `DATABASE_URL` | `file:apps/server/dev.db` | SQLite |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS allowlist |
| `LOG_LEVEL` | `info` | pino levels |
| `MAX_UPLOAD_BYTES` | `200 MB` | spec §2.5 |
| `MAX_DECOMPRESSED_BYTES` | `1 GB` | zip-bomb guard |
| `MAX_FILE_BYTES` | `100 MB` | per-file cap |
| `MAX_SLIDES` | `500` | refuses huge decks |
| `AUTH_STORAGE_TOKEN_SECRET` | random per-process | HMAC secret for `/storage/*?t=` tokens — set this in prod so a restart doesn't invalidate live links |
| `AUTH_STORAGE_TOKEN_TTL_SEC` | `3600` (1h) | how long a minted storage token stays valid |

`.env.example` lives at `apps/server/.env.example`; copy to `.env` and tweak.

### 4.3 Database

Single SQLite file. Three tables:

```17:43:apps/server/prisma/schema.prisma
model Deck {
  id           String   @id          // == manifest.id (slug)
  ownerId      String
  schemaVer    String
  title        String
  ...
  manifest     String                // full manifest.json as TEXT
  storageRoot  String                // relative to STORAGE_ROOT
  sizeBytes    Int
  uploadedAt   DateTime @default(now())
  updatedAt    DateTime @updatedAt
  slides       Slide[]
  annotations  Annotation[]
}
```

Notes:

- The `manifest` column duplicates what's on disk so `GET /api/decks/:id` is
  one row read. Keep them in sync inside the upload transaction (see
  `routes/decks.ts`).
- `Annotation` is keyed by `(deckId, userId, slideIdx)` — strokes are stored as
  a JSON-stringified array (`String`) because we run on SQLite. Any future
  Postgres migration can switch this to `jsonb`; the API contract stays the
  same.

### 4.4 Upload pipeline

`POST /api/decks` → `routes/decks.ts` → streams the multipart body to a
temp file → calls `ingestArchive()` (`pipeline/index.ts`).

`ingestArchive()` is pure (no DB, no HTTP):

1. **Stage** — `mkdtemp` under `os.tmpdir()`.
2. **Extract** — `pipeline/extract.ts::safeExtract`. Walks every entry and
   rejects:
   - `..` / absolute paths / null-bytes (zip-slip, `EZIPSLIP`)
   - non-regular / non-directory entries (`EZIPSLIP`)
   - per-file > `maxFileBytes` (`EBOMB`)
   - cumulative > `maxDecompressedBytes` (`EBOMB`)
3. **Validate** — `pipeline/validate.ts::readAndValidateManifest` parses
   `manifest.json`, runs the Zod schema from `@slidestage/shared`, then verifies
   that every `slides[].file` actually exists on disk (else `EMISSINGFILE`).
   Missing thumbnails are **silently nulled**, not rejected.
4. **Promote** — `rename(stagingDir, <STORAGE_ROOT>/<deckId>)`. If a deck
   with the same id existed it's moved to `<deckId>.replaced-<uuid>` first;
   on success the backup is purged.

The route then upserts the `Deck` row + recreates `Slide` rows in a single
transaction. Re-uploads with the same `manifest.id` overwrite the previous
deck. Annotations are kept (`onDelete: Cascade` only fires on `prisma.deck.delete`).

### 4.5 REST endpoints — full reference

All routes below live under `/api`. Auth: send `x-user-id: <whatever>`. JSON
in / JSON out unless noted. Errors are `{ error: ERROR_CODE, message: string }`
with the HTTP status set per spec §13.

#### Decks

| Method | Path | Body | Response | Notes |
|---|---|---|---|---|
| GET | `/api/health` | — | `{ status, schema, storageRoot }` | Used by Playwright `webServer.url` |
| POST | `/api/decks` | `multipart/form-data` field `file=<.stage>` | `201 { id, manifest, storageRoot }` | enforces all size limits |
| GET | `/api/decks` | — | `{ decks: DeckListItem[] }` | filtered by `ownerId == x-user-id` |
| GET | `/api/decks/:id` | — | `DeckDetail` | 404 if not yours |
| GET | `/api/decks/:id/manifest` | — | raw `Manifest` JSON | also 404 if not yours |
| PATCH | `/api/decks/:id/notes` | `{ notes: Record<"<1-based-idx>", string \| null> }` | `{ ok, updated, manifestUpdatedAt }` | owner-only; sparse update; sinks DB + manifest.json + speaker-notes.json + appends `NoteEdit` audit rows |
| GET | `/api/decks/:id/notes/audit` | — | `{ entries: NoteEditEntry[] }` | owner-only; newest-first; capped to 200 |
| GET | `/api/decks/:id/export` | — | `application/vnd.stage+zip` (binary) | re-packs `<storage>/<id>` into `<id>-YYYY-MM-DD-HH-mm-ss.stage` |
| DELETE | `/api/decks/:id` | — | `204` | rm -rf storage + DB cascade |

`DeckDetail` schema (see `apps/web/src/api/client.ts`):

```ts
interface DeckDetail {
  id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  totalSlides: number;
  width: number; height: number;
  sizeBytes: number;
  uploadedAt: string; updatedAt: string;
  manifest: Manifest;          // full manifest.json
  storageRoot: string;         // relative path under STORAGE_ROOT
}
```

#### Annotations  (per-(deck, user, slide))

`slideIdx` is a **0-based** integer in the URL (matches spec §8.4). The web app
currently uses **1-based** indices internally and POSTs them verbatim — this is
fine because both ends agree, but if you wire up a different client be aware
the `routes/annotations.ts` handlers do not subtract 1.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/decks/:id/annotations` | — | `{ annotations: Record<number, Stroke[]> }` |
| GET | `/api/decks/:id/annotations/:slideIdx` | — | `{ strokes: Stroke[] }` |
| POST | `/api/decks/:id/annotations/:slideIdx` | `{ strokes: Stroke[] }` | `{ ok: true, count }` (replace) |
| PATCH | `/api/decks/:id/annotations/:slideIdx` | `{ append: Stroke[] }` **or** `{ remove: number[] }` | `{ ok: true, count }` |
| DELETE | `/api/decks/:id/annotations/:slideIdx` | — | `204` |

`Stroke` schema lives in `packages/shared/src/annotations.ts`:

```ts
interface Stroke {
  tool: 'pen' | 'highlighter';
  color: string;        // CSS color, e.g. '#FF3B30' or 'rgba(255,215,0,0.42)'
  width: number;        // logical-pixel stroke width
  points: [number, number][];   // logical (manifest.dimensions) coords
  cid?: string;         // client id for multi-device dedup (§8.6)
}
```

#### Static

| Path | Notes |
|---|---|
| `/storage/<deckId>/manifest.json` | served as JSON |
| `/storage/<deckId>/slides/01.html` etc. | served as text/html with hardened CSP; relative URLs in body are rewritten with `?t=<token>` |
| `/storage/<deckId>/thumbnails/01.png` | image/png |

All `/storage/<deckId>/*` requests accept `?t=<storage-token>` (HMAC-signed,
deck-scoped, default TTL 1h) **or** a valid session cookie. Unauthorized
requests return 404 (not 401) so callers can't enumerate which deck ids
exist. Tokens are returned by `/api/decks` and `/api/decks/:id` as
`storageToken` and are the only auth that works inside opaque-origin slide
iframes — see finding #20 in `docs/bugs.md`.
| `/storage/<deckId>/assets/...` | media |

The web app serves the iframe from this path directly (`apps/web/src/components/DeckStage.tsx`).

### 4.6 Error codes

`packages/shared/src/errors.ts` exports the canonical list. Both server &
client know them; the UI shows whatever `message` the server emits.

| Code | Status | Used by |
|---|---|---|
| `EUNZIP` | 400 | malformed zip |
| `ENOMANIFEST` | 400 | manifest.json missing |
| `EBADMANIFEST` | 400 | JSON parse / Zod validation fail |
| `EBADSCHEMA` | 400 | reserved (currently unused) |
| `EZIPSLIP` | 400 | zip-slip / unsupported entry |
| `EBOMB` | 413 | size limit hit |
| `ETOOLARGE` | 413 | maxUploadBytes / maxSlides |
| `EMISSINGFILE` | 400 / 404 | slide file or deck not found |
| `EINTERNAL` | 500 | catch-all |

---

## 5. Frontend — `@slidestage/web`

### 5.1 Routing

`apps/web/src/main.tsx` mounts a `createBrowserRouter` with these routes
(everything wrapped in `App` shell):

| Path | Component | Description |
|---|---|---|
| `/decks` | `DeckListPage` | library grid + delete |
| `/decks/upload` | `UploadPage` | xhr-based progress upload |
| `/decks/:deckId#<idx>` | `DeckViewerPage` | single-window viewer (laptop screen presenting) |
| `/decks/:deckId/presenter#<idx>` | `PresenterViewPage` | PowerPoint-style speaker console |
| `/decks/:deckId/audience#<idx>` | `AudienceViewPage` | projection-only mirror |
| `/` and `/*` | redirect → `/decks` | |

The slide index lives in the URL hash (`#3` = slide 3). `DeckViewerPage` and
`PresenterViewPage` write the hash on every nav so external links / refreshes
keep position.

### 5.2 Stage rendering — letterbox math

Every slide HTML is rendered inside an iframe at the manifest's logical
dimensions (typically 1920×1080). The iframe is wrapped in a `div` that gets a
CSS `transform: translate(...) scale(...)` so the logical canvas fits whatever
viewport is available. **All annotation, laser, and spotlight coordinates are
in logical space**, not viewport pixels — that way they survive resizes /
fullscreen / dual-window mirroring without re-projection.

Two pieces of code make this work and *must stay in sync*:

1. `apps/web/src/hooks/useStageLayout.ts::useStageLayout` — ResizeObserver
   driven; returns `{ scale, offsetX, offsetY, containerWidth, containerHeight }`.
2. `apps/web/src/components/DeckStage.tsx` — applies the same transform to the
   iframe wrapper.
3. `apps/web/src/presenter/AnnotationOverlay.tsx`, `LaserPointer.tsx`,
   `Spotlight.tsx` — apply the same transform to their SVG / fixed elements
   so they line up exactly.

Helper: `viewportToStage(clientX, clientY, wrapperRect, layout)` (same file as
`useStageLayout`) converts a `PointerEvent` into logical coords. Use it
*every* time a tool reads pointer input.

### 5.3 Presenter state machine

`apps/web/src/presenter/usePresenter.ts` is the single source of truth for
tool / color / strokes. Backed by `useReducer`. Mounted by both the
single-window viewer *and* the presenter window — they each maintain their own
copy and synchronize via BroadcastChannel (see §6 of this doc).

```112:128:apps/web/src/presenter/usePresenter.ts
export interface PresenterApi {
  state: PresenterState;
  setTool: (tool: Tool) => void;
  setColor: (color: PenColor) => void;
  loadStrokes: (strokes: Record<number, Stroke[]>) => void;
  appendStroke: (slideIdx: number, stroke: Stroke) => void;
  removeStroke: (slideIdx: number, strokeIdx: number) => void;
  removeStrokeByCid: (slideIdx: number, cid: string) => void;
  replaceSlideStrokes: (slideIdx: number, strokes: Stroke[]) => void;
  undo: (slideIdx: number) => void;
  clearSlide: (slideIdx: number) => void;
  isDrawingTool: boolean;
  needsPointerCapture: boolean;
}
```

Tool union (`apps/web/src/presenter/types.ts`):

```ts
type Tool = 'mouse' | 'laser' | 'pen' | 'highlighter' | 'eraser'
          | 'spotlight' | 'blackout' | 'whiteout';
```

Pen colors are hard-coded to a 5-swatch palette
(`PEN_COLORS = ['#FF3B30','#FF9500','#FFCC00','#0A84FF','#34C759']`). The
toolbar surfaces them as 1-5 keys when a drawing tool is active.

### 5.4 Keyboard map

Two hooks cooperate without stepping on each other:

- `useKeyboardNav` (`apps/web/src/hooks/useKeyboardNav.ts`) — nav (`←/→/Home/End/PageUp/PageDown/Space`), mode toggles (`O` overview, `S` speaker, `F` fullscreen), and digit jumps `1-9`.
- `usePresenterShortcuts` (`apps/web/src/presenter/usePresenter.ts`) — tool keys (`Shift+L/P/H/E/S/M`), `B` blackout, `W` whiteout, `Esc` → mouse, `Ctrl/Cmd+Z` undo, `Shift+Delete/Backspace` clear current slide, pen-color `1-5` *while a drawing tool is active*, and `[` / `]` *while the spotlight is active* (shrink / grow aperture by 16 px).

The hand-off: `usePresenterShortcuts` returns `isToolDigitContext` which
`useKeyboardNav` consumes via `digitsOwnedByTool` so digit `1-5` does *not*
double-fire (tool color **xor** slide jump, never both).

### 5.5 Toolbar — two layouts, one component

`apps/web/src/presenter/Toolbar.tsx` implements both:

- **`auto-hide`** (default; used by `DeckViewerPage`) — bottom-center bar that
  reveals when the cursor enters the lower 60% of the host, then auto-fades
  after 2 s of inactivity.
- **`right-dock`** (used by `PresenterViewPage` only) — collapses to a "Tools"
  handle on the right edge; expands on hover *or* whenever a drawing tool is
  active so the user doesn't chase the dock mid-stroke.

Both modes expose the same `data-testid` selectors so e2e tests don't care
which layout they're driving.

### 5.6 Single window vs. PowerPoint mode

| | `DeckViewerPage` | `PresenterViewPage` + `AudienceViewPage` |
|---|---|---|
| Toolbar | auto-hide bottom | right-dock (presenter only) |
| Speaker notes | optional `S` toggle, side panel | always visible at bottom of presenter |
| Up-next preview | hidden | always shown in side panel |
| Timer | — | yes (resettable) |
| Tools work? | yes | yes (presenter), mirrored (audience) |
| Cross-window sync | none | BroadcastChannel (next section) |

`AudienceViewPage` is a *pure* mirror: it disables pointer capture in the
overlay (`readOnly` prop on `AnnotationOverlay`), never persists anything,
and ignores keyboard shortcuts.

---

## 6. Cross-window sync protocol

Spec §9.3 mandates BroadcastChannel for same-origin presenter ↔ audience
pairing. We open a channel named `slidestage-deck::<deckId>` so two decks open
in parallel don't cross-talk.

The presenter window is **authoritative**. The audience window only ever
mutates its local presenter store via incoming messages and never sends
authoritative state back. (It *does* send `hello` and `request-snapshot`.)

Wire format — `apps/web/src/presenter/usePresentationSync.ts::SyncMessage`:

| `type` | Direction | Payload | When sent |
|---|---|---|---|
| `hello` | both | `{ role: 'presenter' \| 'audience' }` | on channel open |
| `request-snapshot` | audience → presenter | — | when audience finishes loading the deck |
| `snapshot` | presenter → audience | `{ state: SnapshotState }` | in response to `hello` (audience) or `request-snapshot` |
| `slide` | presenter → audience | `{ slideIdx: number }` | on every slide change |
| `tool` | presenter → audience | `{ tool: Tool }` | tool switch incl. blackout/whiteout/spotlight |
| `color` | presenter → audience | `{ color: PenColor }` | swatch change |
| `strokes` | presenter → audience | `{ slideIdx, strokes: Stroke[] }` | full replacement after every commit (incl. undo, clear) |
| `draft` | presenter → audience | `{ slideIdx, stroke: Stroke \| null }` | rAF-throttled while drawing; `null` clears |
| `pointer` | presenter → audience | `{ pos: { x, y } \| null }` | rAF-throttled cursor for laser/spotlight (logical coords) |
| `spotlight-radius` | presenter → audience | `{ radius: number }` | spotlight aperture changed (wheel / `[` / `]` / slider) |

Snapshot shape:

```ts
interface SnapshotState {
  slideIdx: number;
  tool: Tool;
  penColor: PenColor;
  strokesByIdx: Record<number, Stroke[]>;
  blackoutAt: { x: number; y: number } | null;   // reserved; currently always null
  pointerPos: { x: number; y: number } | null;
  spotlightRadius?: number;                       // CSS px; audience mirrors this
}
```

Implementation knobs:

- `lastSentRef: Map<slideIdx, Stroke[]>` in `PresenterViewPage` dedups `strokes`
  broadcasts (we only re-send on reference change).
- Draft + pointer broadcasts go through `requestAnimationFrame` so we never
  flood the channel during a fast drag.
- `AnnotationOverlay` accepts an `externalDraft?: Stroke | null` prop; on the
  audience side it's rendered as a separate `<path data-draft="external">`
  alongside committed strokes.

If you need to add a new sync message:

1. Add the variant to `SyncMessage` in `usePresentationSync.ts`.
2. Send it from `PresenterViewPage` (look for `sync.send(...)` callsites).
3. Handle it in `AudienceViewPage::handleMessage`.

---

## 7. Coordinate system & invariants

These are the rules every UI component is expected to obey. Break one and
strokes / lasers will drift on resize.

1. **Logical space only.** A `Stroke.points[i]` is `[x, y]` in
   `manifest.dimensions` units. Never store viewport pixels.
2. **Single transform, three places.** `DeckStage`, `AnnotationOverlay`'s SVG
   wrapper, and `LaserPointer`'s viewport projection must all read the same
   `StageLayout`.
3. **Pointer math via `viewportToStage()`.** Don't compute it inline.
4. **Eraser hit-testing in logical space.** `AnnotationOverlay::hitTestStroke`
   uses a `Math.max(stroke.width, 12)` tolerance in logical pixels.
5. **Per-stroke `cid`.** Generated client-side (`crypto.randomUUID()` with a
   timestamped fallback). Used by `removeStrokeByCid` for future multi-device
   dedup. The server stores it but doesn't otherwise care.

---

## 8. Annotation persistence flow

```
┌──────────────────┐                                ┌────────────────────┐
│ AnnotationOverlay│  pointerDown→Move→Up           │     usePresenter   │
│  (pen / hl /eraser) ─── appendStroke / remove ───▶│  reducer           │
└──────────────────┘                                └─────────┬──────────┘
                                                              │ state.strokesByIdx
                                                              ▼
                                                    ┌────────────────────┐
                                                    │   useStrokeSync     │
                                                    │   debounce 800 ms   │
                                                    │   POST replace      │
                                                    └─────────┬──────────┘
                                                              │
                                                              ▼
                                            POST /api/decks/:id/annotations/:slideIdx
```

Subtleties to know about:

- The hook **seeds `lastSerializedRef` with `JSON.stringify([])`** so the
  initial-empty placeholder never POSTs and clobbers existing strokes (this
  bit us hard with React 18 StrictMode dev-mode mount/unmount/mount).
- On slide change, the *outgoing* slide gets an immediate flush; the new
  slide starts a new debounce timer.
- On unmount, only flush if state diverged from `lastSerializedRef` —
  protects against StrictMode and back/forward navigation.

`useDeckLoader.useInitialAnnotations` does the inverse: one-shot
`GET /annotations` on deck mount → `presenter.loadStrokes(...)`.

---

## 8.5 Speaker-notes editing & deck export

Stage A.5 ships an owner-side notes editor and a one-click `.stage`
export. Speaker-notes are **deck content** (per spec §9.1 they live in
`manifest.slides[].notes`), so this flow deliberately mutates the deck
instead of the per-user Annotation table — it's the same mental model as
PowerPoint's "save to deck" rather than "annotate over deck".

### 8.5.1 Data model

```
PATCH /api/decks/:id/notes  →  one transaction touches FOUR sinks:

   ┌─────────────────────────────────────────┐
   │ 1. Slide.notes  (one row per slide)     │  Prisma DB
   │ 2. Deck.manifest (TEXT mirror)          │  Prisma DB
   │ 3. <storage>/<id>/manifest.json         │  on-disk (atomic write)
   │ 4. <storage>/<id>/speaker-notes.json    │  on-disk (atomic write)
   └─────────────────────────────────────────┘

   plus an append-only audit row per *actually-changed* slide:

   ┌─────────────────────────────────────────┐
   │ NoteEdit                                │
   │  id PK  deckId  userId  slideIdx        │
   │  previousNotes  newNotes  editedAt      │  Prisma DB (note_edits)
   └─────────────────────────────────────────┘
```

Disk writes go via a `<file>.tmp-<uuid>` + `rename` so a crash mid-write
never leaves the manifest half-written; the DB transaction only fires
after the disk-side commit succeeds. Cross-user PATCH attempts return 404
(same enumeration-resistant strategy as `/decks/:id`).

The schema lives in `packages/shared/src/notes.ts`:

```ts
const notesPatchBodySchema = z.object({
  notes: z.record(
    z.string().regex(/^\d+$/),  // 1-based slide index keys
    z.string().nullable(),       // empty string == clear
  ),
}).strict();
```

### 8.5.2 Frontend sync flow

```
┌──────────────────┐     setNote(idx, value)     ┌────────────────────┐
│  EditableNotes   │ ───────────────────────────▶│   useNotesSync     │
│  (textarea)      │                             │   debounce 800 ms  │
└──────────────────┘                             │   slide-change flush│
        ▲                                        │   unmount flush     │
        │ value / status / error                 │   error retain     │
        │                                        └─────────┬──────────┘
        │                                                  │
        └─────────  notes / status / errorMessage ◀────────┘
                                                            │
                                                            ▼
                                       PATCH /api/decks/:id/notes
                                       — onPersisted updates the page-side
                                         deck mirror (no full reload)
```

Knobs to mind:

- `useNotesSync` keeps `serverNotes` (last-known-good from manifest) and
  `pending` (unsynced edits). The `notes` shown to the editor is
  `{ ...serverNotes, ...pending }` so typing is never blocked on the
  server roundtrip.
- The `manifest` reset effect refreshes `serverNotes` whenever the parent
  passes a new manifest reference, but **does not** touch `pending` — that
  way `onPersisted` ⇒ `setDeck` ⇒ new manifest doesn't clobber edits the
  user typed during the request.
- `deckId` change is the only path that wipes `pending` (different deck =
  different notes).
- The placeholder `EMPTY_MANIFEST` constant in the page files keeps the
  manifest reference stable while `useDeckLoader` is loading; without it
  every parent re-render would create a fresh `{ slides: [] }` and re-run
  the manifest effect.

### 8.5.3 UI surfaces

| Surface | Layout | Component | Trigger |
|---|---|---|---|
| `DeckViewerPage` Speaker side panel | `editable-notes-panel` (full-height read-only `<pre>` until Edit) | `<SpeakerNotes>` → `<EditableNotes variant="panel" />` | press `S` |
| `PresenterViewPage` bottom strip | `editable-notes-strip` (compact read-only `<pre>` until Edit) | `<EditableNotes variant="strip" />` | always visible |
| Audience window | (read-only mirror — doesn't include the editor) | n/a | n/a |

Both surfaces share the same `useNotesSync` instance per page, so a typed
edit in either surface flushes through the same debounce timer and the
same PATCH.

**Edit-mode lock.** Each surface starts with the textarea **hidden** and a
read-only `<pre>` of the current note instead. A page-level boolean
(`notesEditing` in `DeckViewerPage` / `PresenterViewPage`) gates the
swap. Reasons:

- `useKeyboardNav` deliberately bails out when the focus target is an
  input/textarea/contenteditable so users can type without fighting nav
  shortcuts. While that's correct *during* editing, it would also mean a
  presenter who absent-mindedly clicks the notes area mid-talk loses
  ←/→/Space until they Tab away. Lock-by-default keeps the keyboard
  reserved for nav until the owner explicitly says "I want to edit".
- `Esc` on the textarea exits Edit mode, calls `notesSync.flush()`, and
  blurs the element. The page also auto-exits Edit mode when the speaker
  side panel is closed.

### 8.5.4 Audit log

`PATCH /notes` appends one row to `NoteEdit` for every slide whose value
actually changed (no-op patches insert nothing — see the vitest
`skips no-op PATCH calls` case). The schema mirrors §8.5.1; cleanup is
handled by the existing `Deck` cascade-delete.

`GET /api/decks/:id/notes/audit` returns up to 200 most-recent rows
(newest first) for owner-side surfacing of "who/when/what" history. The
endpoint exists today as the data backbone — a UI panel that consumes it
is open work tracked in §13.

### 8.5.5 Export flow

`GET /api/decks/:id/export` is a thin wrapper that:

1. ownership-checks via `x-user-id` (404 cross-user, same as the rest)
2. walks `<storage>/<id>` recursively (skipping `.*` and `*.tmp-*` files
   left by an interrupted atomic-write)
3. feeds every regular file into a fresh `AdmZip` instance
4. responds with `application/vnd.stage+zip` + a
   `Content-Disposition` filename of `<id>-YYYY-MM-DD-HH-mm-ss.stage`

The web client (`api.exportDeck`) issues the GET, blob-converts the body,
parses the disposition filename, and triggers a browser download via a
synthetic `<a download>` click. The result is the same byte-for-byte zip
the upload pipeline accepts (verified by the round-trip vitest case in
`apps/server/tests/notes.test.ts`).

UI entry points:
- `DeckListPage` deck-card actions (next to **Delete**)
- `DeckViewerPage` toolbar (between Speaker / Present)
- `PresenterViewPage` toolbar (between Overview / Audience window)

All three call `notesSync.flush()` first (when applicable), so an export
clicked mid-typing always carries the very last keystroke.

---

## 9. Manifest schema (mirror of spec §3)

`packages/shared/src/manifest.ts` is the canonical Zod schema. Highlights you
should know without re-reading the spec:

- `schema` is fixed to `"slidestage@1.0"`. `SUPPORTED_SCHEMA_VERSIONS` is
  the migration knob.
- `id` is slug `[a-z0-9\-_\u4e00-\u9fff]{1,64}` (CJK allowed).
- `architecture ∈ {multi-file, multi-file-flat, single-file-deckstage,
  single-file-html}`. The schema enforces that non-flat layouts keep slides
  under `slides/`.
- `slides[].index` MUST be 1-based and equal `i + 1` (Zod `superRefine`).
- `totalSlides` MUST equal `slides.length`.
- `platform.minSchemaVersion` is checked against
  `PLATFORM_SCHEMA_VERSION = '1.0'` via `compareSemver`. Reject if higher.
- The schema is `.passthrough()` so unknown top-level fields are tolerated
  (forward-compat per spec §12.3).
- Optional `provenance` (`packages/shared/src/manifest.ts → provenanceSchema`)
  captures `sourceKind` / `conversionMode` / `sourceEntry` / `converter` and is
  stored verbatim — purely diagnostic, never used for rendering decisions.
- Optional `compat` (`compatSchema`) declares trust capabilities. `requires`
  accepts `string[]` and is normalized via `normalizeTrustCapabilities` —
  unknown values are dropped, the result is deduped and sorted into a
  `TrustCapability[]`. `compat.requires` then drives the per-deck iframe
  sandbox via `apps/web/src/utils/iframeSandbox.ts`.

When you bump support to `slidestage@1.1`:

1. Add `'slidestage@1.1'` to `SUPPORTED_SCHEMA_VERSIONS`.
2. Update `PLATFORM_SCHEMA_VERSION`.
3. Add new fields with `.optional().default(...)` so old packages still parse.
4. Touch `apps/server/prisma/schema.prisma` only if the new fields need to be
   indexed/queried — otherwise the existing `manifest TEXT` column suffices.

---

## 10. Test harness

### 10.1 Server (vitest)

`apps/server/tests/helpers.ts` does the heavy lifting:

- creates `tmpRoot` + `tmpRoot/test.db` + `tmpRoot/storage`
- runs `npx prisma db push --skip-generate` against the temp DB
- exports a fixture builder that calls `scripts/build-fixture.mjs::build({ targetPath })`
- exposes `uploadFixture(env, filePath, userId)` that crafts a multipart body
  and `app.inject()`s it (no real socket)

`upload.test.ts` covers:

- happy-path upload + indexing
- list / detail / manifest fetch
- per-user isolation (404 across users)
- adversarial: zip-slip → `EZIPSLIP`, missing manifest → `ENOMANIFEST`, broken
  manifest → `EBADMANIFEST`, missing slide files → `EMISSINGFILE`
- annotation roundtrip (POST replace, PATCH append, cross-user 404)

`notes.test.ts` covers:

- `PATCH /notes` updates Slide row + Deck.manifest mirror + on-disk
  manifest.json + on-disk speaker-notes.json (all four sinks asserted in
  the same case)
- empty string clears the note (`null` in manifest)
- out-of-range slide index → 400
- malformed body shape → 400 (verifies the global Zod → 400 error mapping
  in `server.ts`)
- cross-user PATCH → 404
- `GET /export` streams a `.stage` zip whose `manifest.json` reflects
  the latest edits and still contains the original slides + thumbnails
- cross-user export → 404
- `GET /notes/audit` returns rows newest-first with the documented schema
- a no-op PATCH (same value as already on disk) writes **zero** audit
  rows (`updated: 0`)
- cross-user audit GET → 404

### 10.2 Web (Playwright)

`apps/web/playwright.config.ts` boots a *real* backend on `:4001` (separate
DB + storage from dev) and Vite on `:5173`. `pnpm test:e2e` chains
`prisma db push` before launch. **Workers fixed at `1`** because every spec
shares deck id `sample-stage-a` — split decks first if you need parallelism.

| Spec | Coverage |
|---|---|
| `deck-flow.spec.ts` | Upload → list → viewer → keyboard nav → Overview → Speaker view. Plus a negative test: non-zip file rejected. |
| `notes-edit.spec.ts` | (1) Edit notes in Speaker side panel → autosave → Esc exits Edit mode → reload → still there → click **Export ↓** → unzip the download → assert `manifest.json` and `speaker-notes.json` carry the new note. (2) Edit in the PresenterView bottom strip and confirm the same value appears in the Speaker side panel after a navigation. (3) **Edit-mode lock**: while the speaker panel is open and editor is locked, ←/→ keep advancing slides; entering Edit mode captures the keyboard; pressing Esc returns control. |
| `presenter-tools.spec.ts` | Toolbar visible, shortcut switching, blackout/whiteout/spotlight visible, draw a pen stroke and verify backend persistence + reload. |
| `dual-window.spec.ts` | Open `/presenter` + `/audience` in the same context, exercise BroadcastChannel: slide propagation, in-flight draft, committed strokes, blackout/whiteout/spotlight, right-dock collapse, snapshot-on-join with a pre-seeded stroke. |

### 10.3 Fixture builder

`scripts/build-fixture.mjs` is **dependency-free**. It writes a 4-page deck
(`封面 / 议程 / 数据 / 总结`) at 1920×1080 with PNG thumbnails and speaker
notes, then ZIPs it with a hand-rolled PKZip writer (deflate via `node:zlib`).
Both the vitest helpers and the Playwright suite import its `build()` and
`makeZip()` exports — keep both in `module.exports` if you refactor.

To regenerate after tweaking the fixture:

```bash
pnpm fixtures
ls -lh fixtures/out/sample.stage
```

---

## 11. Common tasks (copy-paste)

### Add a new server endpoint

1. Pick a route file (`apps/server/src/routes/<area>.ts`) or create one.
2. Register it inside `buildServer()` (`apps/server/src/server.ts`).
3. Validate request bodies with Zod from `@slidestage/shared` (add new schemas
   to `packages/shared/src/...` and re-export from `index.ts`).
4. Throw `SlideStageError` for user-facing failures so the global error handler
   formats them consistently.
5. Add a vitest case in `apps/server/tests/`.

### Add a new presenter tool

1. Append to `Tool` union in `apps/web/src/presenter/types.ts`.
2. Add a reducer action / API method in `usePresenter.ts` if it has state.
3. Create a sibling component under `apps/web/src/presenter/` (mirror
   `Spotlight.tsx` / `LaserPointer.tsx` for "pointer-driven mask" tools, or
   `AnnotationOverlay.tsx` for "draws strokes" tools).
4. Wire it into both `DeckViewerPage.tsx` and `PresenterViewPage.tsx` /
   `AudienceViewPage.tsx`. The audience version must read its state from
   `presenter` (already kept in sync via `tool`/`pointer` messages); add a
   new `SyncMessage` if it needs more.
5. Add a button + shortcut row to `Toolbar.tsx`'s `TOOLS` array, plus a
   `Shift+<key>` mapping in `usePresenterShortcuts`.
6. Cover with an e2e in `presenter-tools.spec.ts` or `dual-window.spec.ts`.

### Add a new field to the manifest

1. Edit `packages/shared/src/manifest.ts` — make it `.optional()` for forward
   compat.
2. Run `pnpm build:shared`.
3. If the server needs to query it, add a column in `apps/server/prisma/schema.prisma`
   and `pnpm --filter @slidestage/server exec prisma migrate dev`.
4. Update the upload route (`routes/decks.ts`) to read it out and pass to
   Prisma.
5. Update `scripts/build-fixture.mjs` so e2e covers the field.

### Add an owner-side manifest mutation (e.g. edit slide titles)

The notes editor in §8.5 is the model. To add another field that owners
can edit live:

1. Add a Zod body schema in `packages/shared/src/<feature>.ts` and re-export
   from `index.ts`. Build the package (`pnpm build:shared`).
2. Mirror the disk-then-DB pattern in `apps/server/src/routes/notes.ts`:
   read the manifest from `Deck.manifest`, mutate it, atomic-write the
   on-disk `manifest.json`, then a single Prisma transaction updates
   `Deck.manifest` + any per-row mirror tables.
3. Owner-only check: load the deck, compare `ownerId` to `getUserId(req)`,
   404 if mismatched (don't 403 — id enumeration).
4. Front-end: build a parallel of `useNotesSync` if you want autosave;
   otherwise plain `api.<endpoint>` works. The page-level `setDeck`
   callback returned by `useDeckLoader` is the cheapest way to reflect
   the new manifest after a successful mutation.
5. vitest: add a case in `apps/server/tests/<feature>.test.ts` that asserts
   the four sinks if you also touched per-row mirrors.
6. Playwright: write a "edit → reload → still there → export → zip carries
   it" test mirroring `notes-edit.spec.ts`.

---

## 12. Security checklist

What's in place (don't regress these):

- **Zip-slip guard** — path normalization + `..`/absolute checks +
  `target.startsWith(destAbs + sep)` (`pipeline/extract.ts`).
- **Zip-bomb guard** — per-file + cumulative byte caps before disk writes.
- **Symlink / device file rejection** — POSIX file-type mask check.
- **CSP on slide HTML** — `frame-ancestors 'self'`, no `unsafe-eval`,
  font-src restricted to `https://fonts.gstatic.com` + data URIs.
- **iframe sandbox** — baseline `sandbox="allow-scripts"` (no
  `allow-same-origin`) for live slides, `sandbox=""` for the inert thumbnails
  in `Overview`/`SpeakerNotes`. The live baseline is **elevated per deck** by
  `apps/web/src/utils/iframeSandbox.ts` when the manifest declares
  `compat.requires`: `same-origin-storage` / `broadcast-channel` add
  `allow-same-origin`, `window-open` adds
  `allow-popups allow-popups-to-escape-sandbox`. Unknown capabilities are
  filtered out server-side (see §9.4 of `slidestage-platform-spec.md`).
  Subresources authenticate via short-lived HMAC `?t=<storage-token>` query
  parameters because SameSite cookies don't ride along on opaque-origin
  iframe fetches — see finding #20 in `docs/bugs.md`.
- **No per-slide font flash, no per-keypress lag** — `DeckStage` holds a
  small **persistent pool** (default 3 slots) of mounted iframes covering
  the active slide plus its preload neighbours (from `preloadSrcs`).
  React keys slots by index, not by URL, so when the user advances the
  pool simply repoints `src` on the LRU slot and flips a CSS opacity —
  the underlying `<iframe>` DOM node, and therefore its `FontFaceSet`,
  stays warm. Sequential navigation is a zero-latency, zero-flash
  opacity flip. For non-sequential jumps (overview pick, Goto N) the
  pool's `slidestage:ready` signal lets the previously-displayed iframe
  stay on screen until the destination is fully painted. Companion
  `useDeckFontWarmup` hook preloads the deck's CSS assets (and the
  webfonts they `@import`) into the SPA's HTTP cache so the first slide
  doesn't pay the full download cost. Immutable assets (fonts, images,
  video) carry `Cache-Control: max-age=31536000, immutable` so any
  later iframe mount goes straight to disk cache. See findings #21
  and #22 in `docs/bugs.md`.
- **CORS** — explicit `WEB_ORIGIN` allowlist, plus localhost-any-port for DX.
- **Per-user ownership** — every read/write checks `ownerId`; cross-user
  access returns 404 (not 403, to avoid id enumeration).

What's *not* protected (Stage B work):

- No real auth. Anyone who can hit the backend can claim any `x-user-id`.
- No rate limit on `/api/decks` upload — wrap behind a reverse proxy in prod.
- No content-type sniffing on `/storage`. We trust the deck packer.
- No virus scan / sandboxed renderer for embedded HTML beyond the CSP/iframe.

---

## 13. TODO / deferred work

Pulled from the spec gap analysis + scattered TODO-shaped seams in code.

**Backend**

- [ ] Real auth (replace `x-user-id` trust with JWT/session). One-file change
      in `apps/server/src/auth.ts`.
- [ ] Postgres migration: switch `Annotation.strokes`/`Deck.manifest` to `jsonb`,
      run `prisma migrate diff` against the SQLite baseline.
- [ ] Auto-thumbnail generation for slides that ship without `thumbnails/*` —
      headless Chromium screenshot + downscale (spec §10).
- [ ] Multi-version retention. `pipeline/index.ts` overwrites the previous
      deck on re-upload; spec §12 hints we should keep version history.
      `PATCH /notes` likewise overwrites in place — once retention exists,
      both flows can branch a snapshot before mutating.
- [ ] Stronger rate limits / upload quotas; `bodyLimit` is global only.
- [ ] Stream the export zip instead of `zip.toBuffer()`-into-memory. Fine
      for ≤200 MB decks (the spec cap) but worth a refactor before quotas
      are loosened.
- [ ] Surface `GET /notes/audit` in the UI as a "history" drawer in the
      speaker panel (server side already returns the rows; only the
      frontend timeline component is missing).
- [ ] Pagination for the audit endpoint once decks accumulate >200 edits.

**Frontend**

- [ ] Touch-first polish: `pointer-events: coarse` paths, larger handles for
      tablet / Apple Pencil. `AnnotationOverlay` uses PointerEvents already
      so the wiring works, but UI affordances are mouse-shaped.
- [ ] Real fullscreen presentation mode for `PresenterViewPage` (today the
      `F` key only fullscreens the document; the side panel is still visible).
- [ ] Mobile / iframe orientation handling (currently always landscape 16:9).
- [ ] Annotation per-user color picker beyond the 5 swatches.
- [ ] "Undo redo stack" — current `undo()` only pops the most recent stroke.
- [ ] Audience-window picture-in-picture mode for projection setups.
- [ ] Localization. UI strings hard-coded in JSX.

**Cross-window sync**

- [ ] Network fallback (BroadcastChannel only works same-origin same-browser).
      Spec §9.3 mentions WebRTC DataChannel / WebSocket as the next step.
- [ ] Multiple audience windows: today only one is "live"; second join works
      but presenter `audienceConnected` flips on first hello and stays.

**Tooling**

- [ ] CI workflow (`.github/workflows/ci.yml` not in repo).
- [ ] Per-spec deck ids in Playwright so we can drop `workers: 1`.
- [ ] Prettier / ESLint configs are not present in repo; current style is
      tsc-strict only.

---

## 14. Pointers for the next agent

- **Read the spec first** — `slidestage-platform-spec.md` is ~870 lines but
  most sections are reference. §1, §3, §6, §7, §8, §11 cover what the
  runtime has to do. Stage A diverges only where called out above.
- **Run the e2e suite once** before changing anything UI-shaped. It catches
  letterbox/coordinate regressions in <30 s.
- **Use `pnpm fixtures` after every fixture-related change.** The vitest
  helpers regenerate inside their tmp dir but Playwright reads the
  committed-but-gitignored `fixtures/out/sample.stage`.
- **Think in logical (1920×1080) coords** as soon as you touch anything in
  `apps/web/src/presenter/`. The number-one bug class in this codebase is
  someone forgetting `viewportToStage()` and getting strokes that drift on
  resize.
- **Don't bypass `usePresenter`.** All tool/state mutations go through it so
  the audience mirror stays correct.

If anything in this document is contradicted by the actual code, the **code
wins** and this doc is wrong — please patch it in the same PR that introduced
the drift.
