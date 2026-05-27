/**
 * Public API contract types — thin re-export of `@slidestage/pro-shared`.
 *
 * As of Phase C.3 (2026-05-27), the api-side and web-side contract type
 * declarations have been unified into the workspace package
 * `@slidestage/pro-shared`. This module re-exports them under their
 * existing names so the route handlers don't need a churn-PR that
 * touches every file.
 *
 * **Do not add new types to this file.** Add them to
 * `packages/pro-shared/src/index.ts` and they will be picked up here
 * automatically. The presence of `check-contract-drift.mjs` (Phase C.5)
 * enforces that every ApiError code stays in sync with the shared
 * `ErrorCode` union.
 */

export type {
  ApiErrorBody,
  ApiErrorPayload,
  AnnotationRecord,
  AnnotationsListResponse,
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
