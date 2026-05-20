# SlideStage Pro v0 — API Contract

> Status: **frozen contract for Phase 1 parallel agents**. Any change must be
> proposed in a separate PR with sign-off from Agent A (API owner) and the
> coordinator. This file is the single source of truth that Agent A, Agent B,
> Agent D, and Agent E all consume.

## Conventions

- All endpoints are mounted under `/api`.
- All request/response bodies are JSON unless explicitly marked `multipart/form-data` or `application/octet-stream`.
- Authentication uses Better Auth session cookies (`better-auth.session_token`). Cookies are HttpOnly + SameSite=Lax + Secure in production.
- Errors follow this shape:
  ```json
  { "error": { "code": "string", "message": "string", "details": {} } }
  ```
- Pagination uses `?limit=20&cursor=<opaqueCursor>`; responses return `{ items, nextCursor }`.
- Timestamps are RFC 3339 strings.
- IDs are CUIDs (~25 chars, opaque strings).

## Auth state

- **Public** endpoints: anyone, no session required.
- **Authenticated** endpoints: any valid session.
- **Admin** endpoints: session user must have `role = "admin"`.

The `requireAuth` and `requireAdmin` middleware live in `apps/api/src/middleware/auth.ts`.

---

## 1. Health

### `GET /api/health` — Public

Liveness + readiness probe.

**Response 200**:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 1234,
  "checks": {
    "db": "ok",
    "storage": "ok"
  }
}
```

`checks.db` is `"ok"` when a `SELECT 1` succeeds. `checks.storage` is `"ok"`
when the storage driver can list its root (or `DATA_DIR` is writable).

If any check fails, return **503** with the same shape but `"status": "degraded"`.

---

## 2. Auth (Better Auth handler)

Better Auth mounts itself under `/api/auth/*` via Hono.

### `POST /api/auth/sign-in/email` — Public
Better Auth standard sign-in.

Body: `{ "email": "...", "password": "..." }`

### `POST /api/auth/sign-out` — Authenticated
Better Auth standard sign-out.

### `POST /api/auth/sign-up/email` — Public, but **always rejects unless invite token is provided**

Body: `{ "email": "...", "password": "...", "name": "...", "inviteToken": "..." }`

`inviteToken` is required; if missing or invalid, return 403 with
`{ "error": { "code": "INVITE_REQUIRED", ... } }`.

On success Better Auth creates the user; our hook then marks the invite as used
and assigns the invite's `role` to the new user.

### `GET /api/auth/get-session` — Public

Returns `{ session: {...}, user: {...} }` or `null`.

---

## 3. Decks

### `GET /api/decks` — Authenticated

List decks owned by the current user, or all decks if user is admin.

Query: `?limit=20&cursor=<id>`.

**Response 200**:
```json
{
  "items": [
    {
      "id": "ckxyz...",
      "title": "Q3 Roadmap",
      "fingerprint": "sha256-...",
      "currentVersionId": "ver_...",
      "visibility": "private",
      "ownerId": "usr_...",
      "createdAt": "2026-05-20T10:00:00Z",
      "updatedAt": "2026-05-20T10:05:00Z",
      "slideCount": 23
    }
  ],
  "nextCursor": "..."
}
```

### `POST /api/decks` — Authenticated, `multipart/form-data`

Upload a new `.stage` and create a new deck.

Form field:
- `file` — the `.stage` zip (required, max `UPLOAD_MAX_BYTES`)
- `title` — optional override; if absent, server uses manifest.title

Server pipeline (Agent A must implement in this exact order):
1. Reject if file > `UPLOAD_MAX_BYTES`.
2. Hash the upload buffer → `sha256`.
3. Load the zip with `@slidestage/core/deck/loadDeck`.
4. Validate manifest with `@slidestage/core/deck/manifestSchema`.
5. Validate every internal path with `@slidestage/core/deck/pathSafety`.
6. Compute fingerprint per manifest (deterministic).
7. Write the bytes to storage at `decks/<deckId>/<versionId>.stage`.
8. Persist `Deck` + `DeckVersion` rows via Prisma in a single transaction.

**Response 201**:
```json
{
  "id": "ckxyz...",
  "title": "Q3 Roadmap",
  "fingerprint": "sha256-...",
  "currentVersionId": "ver_...",
  "createdAt": "2026-05-20T10:00:00Z",
  "manifestSummary": {
    "slideCount": 23,
    "title": "Q3 Roadmap",
    "createdAt": "...",
    "schema": "slidestage@1.0"
  }
}
```

**Error codes**:
- `400 UPLOAD_TOO_LARGE`
- `400 INVALID_STAGE_ZIP` (not a zip / no manifest.json)
- `400 INVALID_MANIFEST` (zod validation failed; include details)
- `400 UNSAFE_PATH` (zip entries outside root or absolute paths)

### `GET /api/decks/:id` — Authenticated

Return deck metadata + manifest summary.

**Response 200**:
```json
{
  "id": "...",
  "title": "...",
  "fingerprint": "...",
  "currentVersion": {
    "id": "ver_...",
    "sizeBytes": 1234567,
    "sha256": "...",
    "createdAt": "..."
  },
  "manifest": {
    "schema": "slidestage@1.0",
    "title": "...",
    "slides": [...]
  },
  "ownerId": "...",
  "visibility": "private",
  "createdAt": "...",
  "updatedAt": "..."
}
```

**404** if deck does not exist or user has no read access.

### `GET /api/decks/:id/blob` — Authenticated

Stream the raw `.stage` bytes back to the client. The web app uses this to feed
`@slidestage/core/deck/loadDeck` on the browser side.

- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="<sanitized-title>.stage"`
- `ETag: "sha256-<hex>"`

### `DELETE /api/decks/:id` — Authenticated (owner) or Admin

Soft-cascade: Prisma `onDelete: Cascade` drops versions, notes, annotations.
Also remove the storage object(s). Return **204**.

---

## 4. Notes

### `PUT /api/decks/:id/notes/:slideIndex` — Authenticated (deck reader)

Upsert a note. Body: `{ "body": "string up to 10000 chars" }`.

**Response 200**:
```json
{
  "deckId": "...",
  "slideIndex": 3,
  "body": "...",
  "updatedAt": "..."
}
```

### `GET /api/decks/:id/notes` — Authenticated (deck reader)

List all notes for a deck.

**Response 200**:
```json
{
  "items": [
    { "slideIndex": 0, "body": "...", "updatedAt": "..." },
    ...
  ]
}
```

### `DELETE /api/decks/:id/notes/:slideIndex` — Authenticated (deck owner) or Admin

Delete a single note. Return **204**.

---

## 5. Annotations

Same shape as notes, but body is `{ "payload": <JSON> }` — opaque to the server.

- `PUT /api/decks/:id/annotations/:slideIndex`
- `GET /api/decks/:id/annotations`
- `DELETE /api/decks/:id/annotations/:slideIndex`

Server validates that `payload` is JSON-serializable and ≤ `ANNOTATION_MAX_BYTES`
(default 64 KB). It does NOT inspect contents.

---

## 6. Invites (admin only)

### `GET /api/invites` — Admin

**Response 200**:
```json
{
  "items": [
    {
      "id": "...",
      "token": "...",
      "email": null,
      "role": "user",
      "createdAt": "...",
      "expiresAt": "...",
      "usedAt": null,
      "usedByEmail": null,
      "createdById": "..."
    }
  ]
}
```

### `POST /api/invites` — Admin

Body: `{ "email"?: "string", "role"?: "user"|"admin", "ttlHours"?: number }`
(defaults: `role=user`, `ttlHours=72`).

**Response 201**: same shape as the items above, plus `token`.

### `DELETE /api/invites/:id` — Admin

Revoke an invite. Return **204**.

---

## 7. Users (admin only)

### `GET /api/users` — Admin
List users.

### `PATCH /api/users/:id` — Admin
Body: `{ "role"?: "user"|"admin", "name"?: "string" }`. Cannot change own role
to non-admin.

### `DELETE /api/users/:id` — Admin
Hard delete (cascades to sessions/accounts; sets `Deck.ownerId = null`).
Returns **204**. Admin cannot delete themselves.

---

## Type aliases shared with the web client

Agent A exports these from `apps/api/src/types/contract.ts`; Agent B imports
the same types via a relative path **inside this repo only** (NOT via runtime
import — types-only via `import type`). The same types are also written to
`docs/api-types.d.ts` for tooling.

```ts
export type DeckSummary = {
  id: string;
  title: string;
  fingerprint: string;
  currentVersionId: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  slideCount: number;
};

export type DeckDetail = DeckSummary & {
  currentVersion: { id: string; sizeBytes: number; sha256: string; createdAt: string } | null;
  manifest: unknown; // SlideStageManifest from @slidestage/core
};

export type NoteRecord = { deckId: string; slideIndex: number; body: string; updatedAt: string };
export type AnnotationRecord = { deckId: string; slideIndex: number; payload: unknown; updatedAt: string };
export type InviteRecord = {
  id: string; token: string; email: string | null; role: 'user' | 'admin';
  createdAt: string; expiresAt: string; usedAt: string | null;
  usedByEmail: string | null; createdById: string;
};
```

## Non-goals (explicitly out of scope for v0)

- OAuth providers (GitHub/Google) — left as Better Auth config extension.
- File-level access control beyond owner / admin / role.
- WebSocket presence.
- Server-side rendering / SSR.
- Multi-tenancy / orgs.
- S3 / MinIO storage driver (interface exists, only `local` is wired up).
