/**
 * Web-side API contract types — thin re-export of `@slidestage/pro-shared`.
 *
 * As of Phase C.3 (2026-05-27), api and web no longer maintain their own
 * hand-aligned copies of these interfaces. The single source of truth is
 * `packages/pro-shared/src/index.ts`. Renames or new fields belong there.
 *
 * Drift fixed at unification:
 *   - `UserRecord.name` was `string | null` here while api / Prisma both
 *     said `string` (non-null). The shared type ships `string`.
 *   - `PageResponse<T>` and `PageEnvelope<T>` were the same shape under
 *     two names; both names are re-exported so callers don't break.
 */

export type {
  AnnotationRecord,
  AnnotationsListResponse,
  ApiErrorBody,
  ApiErrorPayload,
  DeckCurrentVersion,
  DeckCreatedResponse,
  DeckDetail,
  DeckSummary,
  ErrorCode,
  HealthResponse,
  InviteRecord,
  ManifestSummary,
  NoteRecord,
  NotesListResponse,
  PageEnvelope,
  PageResponse,
  Role,
  UserRecord,
  UserRole,
  Visibility,
} from "@slidestage/pro-shared";
