/**
 * `@slidestage/pro-shared` — single source of truth for the Pro API contract,
 * error codes, request/response payloads, and size limits.
 *
 * Consumed by:
 *   - `@slidestage/pro-api`   — server route handlers + Hono types
 *   - `@slidestage/pro-web`   — REST client + UI types
 *   - `@slidestage/pro-preset` — capability registration (future)
 *
 * Hard rules:
 *   - Runtime-dependency-free: this module must be safe to import from both
 *     Node (api) and browser (web) bundles. No `node:*` imports, no React,
 *     no Prisma, no fflate.
 *   - The `ErrorCode` union below is THE list of canonical Pro error codes.
 *     A `node scripts/check-contract-drift.mjs` CI gate (Phase C.5) enforces
 *     that every `throw new ApiError(_, code, _)` in `apps/api/src/routes/`
 *     uses a value from this union.
 *   - Renaming any exported name here is a breaking change.
 *   - Adding new fields to existing interfaces is allowed only as
 *     `?: T` optional — server is free to add fields, client may not rely
 *     on their presence.
 *
 * Drift history fixed when this file was unified (2026-05-27, Phase C.3):
 *   - `UserRecord.name` was `string` on the api side and `string | null`
 *     on the web side. Prisma column is `String` (non-null), so we keep
 *     the api shape and tighten the web side.
 *   - The list-pagination envelope existed as both `PageEnvelope<T>`
 *     (api) and `PageResponse<T>` (web). We now ship `PageEnvelope<T>`
 *     as the canonical name; `PageResponse<T>` remains as a deprecated
 *     alias so the web client doesn't break.
 *   - The session-cookie `Role` union and the invite/web `UserRole` alias
 *     are now the same type, exposed under both names.
 */

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

/** Hours an invite token stays valid after creation. */
export const INVITE_TOKEN_TTL_HOURS = 72;

/** Default upload size cap (bytes) for `.stage` archives. */
export const UPLOAD_MAX_BYTES_DEFAULT = 100 * 1024 * 1024;

/** Hard cap (bytes) for a single annotation payload. */
export const ANNOTATION_MAX_BYTES = 64 * 1024;

/** Hard cap (bytes) for a single speaker-note payload. */
export const NOTE_MAX_BYTES = 10 * 1024;

/** Cookie name used by better-auth for session transport. */
export const SESSION_COOKIE_NAME = "better-auth.session_token";

// ──────────────────────────────────────────────────────────────────────
// Discriminated unions (visibility, role)
// ──────────────────────────────────────────────────────────────────────

/** Deck visibility on a Pro instance. */
export type DeckVisibility = "private" | "unlisted" | "public";

/** Same as `DeckVisibility`, kept under the api-side name for symmetry. */
export type Visibility = DeckVisibility;

/** User role for the role-based access gates. */
export type Role = "user" | "admin";

/** Alias of `Role` historically used by web invite/admin forms. */
export type UserRole = Role;

/** Role granted by an invite (subset of `Role`). */
export type InviteRole = Role;

// ──────────────────────────────────────────────────────────────────────
// ErrorCode union — single source of truth
//
// Every code emitted by `apps/api/src/**` (via `new ApiError(_, code, _)`
// or via `formatBody(code, ...)` in `middleware/error.ts`) MUST appear
// below. Phase C.5 ships a `scripts/check-contract-drift.mjs` that fails
// CI if a new code slips in without being added here first.
//
// Codes are grouped by where they fire. Strings are intentionally stable:
// renames are breaking changes for any caller that branches on them.
// ──────────────────────────────────────────────────────────────────────

export type ErrorCode =
  // ── Auth / session ──────────────────────────────────────────────
  | "UNAUTHORIZED"
  | "FORBIDDEN"

  // ── Invite flow ─────────────────────────────────────────────────
  | "INVITE_REQUIRED"
  | "INVITE_EXPIRED"
  | "INVITE_USED"
  | "INVITE_EMAIL_MISMATCH"

  // ── Generic HTTP fallthrough (middleware/error.ts httpCodeFor) ──
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE_ENTITY"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INTERNAL_ERROR"

  // ── Request validation ──────────────────────────────────────────
  | "INVALID_BODY"
  | "INVALID_QUERY"
  | "INVALID_PAYLOAD"
  | "INVALID_SLIDE_INDEX"
  | "FILE_REQUIRED"

  // ── Deck upload pipeline (`runDeckPipeline` + storage write) ────
  | "UPLOAD_TOO_LARGE"
  | "INVALID_STAGE_ZIP"
  | "INVALID_MANIFEST"
  | "UNSAFE_PATH"
  | "STORAGE_WRITE_FAILED"

  // ── Deck blob fetch ─────────────────────────────────────────────
  | "NO_VERSION"
  | "BLOB_MISSING"

  // ── User management ─────────────────────────────────────────────
  | "CANNOT_DEMOTE_SELF"
  | "CANNOT_DELETE_SELF";

/**
 * Wire shape for an error response from the Pro API.
 *
 * `code` is typed as `ErrorCode | string` so forward-compat callers can
 * still forward an unknown code without a type cast. Server code MUST
 * narrow to `ErrorCode` when emitting.
 */
export interface ApiErrorPayload {
  code: ErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Envelope returned on `4xx`/`5xx` responses. The api always wraps the
 * payload in `{ error: ... }` so the same parser can be reused on both
 * sides (`apps/web/src/api/client.ts#parseError`).
 */
export interface ApiErrorBody {
  error: ApiErrorPayload;
}

// ──────────────────────────────────────────────────────────────────────
// Pagination
// ──────────────────────────────────────────────────────────────────────

/** Cursor-paged list envelope. `nextCursor` is `null` on the last page. */
export interface PageEnvelope<T> {
  items: T[];
  nextCursor: string | null;
}

/** Deprecated alias for `PageEnvelope<T>`. Use `PageEnvelope` in new code. */
export type PageResponse<T> = PageEnvelope<T>;

// ──────────────────────────────────────────────────────────────────────
// Deck contract
// ──────────────────────────────────────────────────────────────────────

/**
 * Summary row returned by `GET /api/decks` and embedded inside `DeckDetail`.
 *
 * `slideCount` is computed server-side from the persisted manifest; it can
 * be `0` for decks whose manifest failed to parse (we don't reject reads
 * just because the manifest is corrupt — that's a separate cleanup gate).
 */
export interface DeckSummary {
  id: string;
  title: string;
  fingerprint: string;
  currentVersionId: string | null;
  visibility: Visibility;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  slideCount: number;
}

/**
 * Version row shape embedded inside `DeckDetail.currentVersion`.
 *
 * Kept as a named type so the web client can hold a reference to "the
 * currently visible version" without redeclaring its anonymous shape.
 */
export interface DeckCurrentVersion {
  id: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** Full detail row returned by `GET /api/decks/:id`. */
export interface DeckDetail extends DeckSummary {
  currentVersion: DeckCurrentVersion | null;
  /** Parsed `.stage` manifest. `null` when storage round-trip failed. */
  manifest: unknown;
}

/** Manifest summary embedded in `POST /api/decks` 201 response. */
export interface ManifestSummary {
  slideCount: number;
  title: string;
  createdAt: string;
  schema: string;
}

/** Response shape for `POST /api/decks` (deck created). */
export interface DeckCreatedResponse {
  id: string;
  title: string;
  fingerprint: string;
  currentVersionId: string;
  createdAt: string;
  manifestSummary: ManifestSummary;
}

// ──────────────────────────────────────────────────────────────────────
// Notes contract
// ──────────────────────────────────────────────────────────────────────

/** Speaker-note row returned by `GET/PUT /api/decks/:id/notes(/:slideIndex)`. */
export interface NoteRecord {
  deckId: string;
  slideIndex: number;
  body: string;
  updatedAt: string;
}

/** List-endpoint shape — `deckId` is omitted because it's redundant with the URL. */
export interface NotesListResponse {
  items: Array<Omit<NoteRecord, "deckId">>;
}

// ──────────────────────────────────────────────────────────────────────
// Annotations contract
// ──────────────────────────────────────────────────────────────────────

/** Annotation row returned by `GET/PUT /api/decks/:id/annotations(/:slideIndex)`. */
export interface AnnotationRecord {
  deckId: string;
  slideIndex: number;
  payload: unknown;
  updatedAt: string;
}

/** List-endpoint shape — `deckId` is omitted (redundant with the URL). */
export interface AnnotationsListResponse {
  items: Array<Omit<AnnotationRecord, "deckId">>;
}

// ──────────────────────────────────────────────────────────────────────
// Invites contract
// ──────────────────────────────────────────────────────────────────────

/** Invite row returned by `GET /api/invites` and `POST /api/invites`. */
export interface InviteRecord {
  id: string;
  token: string;
  email: string | null;
  role: Role;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
  createdById: string;
}

// ──────────────────────────────────────────────────────────────────────
// Users contract
// ──────────────────────────────────────────────────────────────────────

/**
 * User row returned by `GET /api/users` and the user-management endpoints.
 *
 * NOTE on `name`: Prisma `User.name` is non-null (`String`), so this field
 * is `string`, NOT `string | null`. The web-side type previously had it
 * typed as `string | null` (drift); fixed during Phase C.3 unification.
 */
export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Health contract
// ──────────────────────────────────────────────────────────────────────

/** Status returned by `GET /api/health`. */
export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  checks: { db: "ok" | "fail"; storage: "ok" | "fail" };
}
