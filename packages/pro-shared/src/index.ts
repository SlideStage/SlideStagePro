/**
 * Pro-internal shared constants and types.
 *
 * Consumed by `@slidestage/pro-api`, `@slidestage/pro-web`, and
 * `@slidestage/pro-preset`. Keep this module runtime-dependency-free:
 * it must be safe to import from both Node and browser bundles.
 */

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

/** Role granted by an invite. */
export type InviteRole = "user" | "admin";

/** Deck visibility on a Pro instance. */
export type DeckVisibility = "private" | "unlisted" | "public";

/**
 * Canonical error codes returned by the Pro API.
 *
 * Strings are intentionally stable: callers (web UI, CLI, scripts) match on
 * the exact value. New codes are appended; renames are breaking changes.
 */
export type ErrorCode =
  | "INVITE_REQUIRED"
  | "INVITE_EXPIRED"
  | "INVITE_USED"
  | "INVITE_EMAIL_MISMATCH"
  | "UPLOAD_TOO_LARGE"
  | "INVALID_STAGE_ZIP"
  | "INVALID_MANIFEST"
  | "UNSAFE_PATH"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL";

/**
 * Wire-shape for an error response from the Pro API.
 *
 * `code` is typed as `ErrorCode | string` so callers can forward forward-compat
 * codes (e.g. future additions) without forcing a type cast.
 */
export interface ApiErrorPayload {
  code: ErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
}
