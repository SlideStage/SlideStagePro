import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;
  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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
