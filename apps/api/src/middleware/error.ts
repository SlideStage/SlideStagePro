import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorCode } from "@slidestage/pro-shared";

/**
 * Server-side ApiError. Route handlers throw this; the {@link errorHandler}
 * below converts it into the documented `{ error: { code, message, details? } }`
 * envelope.
 *
 * Phase C.4/C.5 (2026-05-27): `code` is now typed as `ErrorCode` (the
 * canonical union exported from `@slidestage/pro-shared`). Adding a
 * brand-new code requires editing `pro-shared/src/index.ts` first — TS
 * will fail compilation here otherwise. This is the contract-drift
 * gate that replaces a static-analysis script.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Format an error body. Accepts `string` (not `ErrorCode`) because the
 * generic HTTP-fallthrough path (`httpCodeFor`) emits dynamic
 * `HTTP_<status>` strings for unknown statuses — those are diagnostic,
 * not part of the public contract, and intentionally not in the
 * `ErrorCode` union.
 */
function formatBody(code: string, message: string, details?: unknown) {
  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: { code, message },
  };
  if (details !== undefined) body.error.details = details;
  return body;
}

export const errorHandler: ErrorHandler = (err, c: Context) => {
  if (err instanceof ApiError) {
    return c.json(formatBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    const message = err.message || "HTTP error";
    return c.json(formatBody(httpCodeFor(status), message), status);
  }
  console.error("[api] unhandled error", err);
  return c.json(
    formatBody(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Internal server error",
    ),
    500,
  );
};

export const notFoundHandler: NotFoundHandler = (c) =>
  c.json(formatBody("NOT_FOUND", `Route not found: ${c.req.path}`), 404);

function httpCodeFor(status: ContentfulStatusCode): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "RATE_LIMITED";
    default:
      return `HTTP_${status}`;
  }
}
