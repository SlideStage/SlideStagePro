import type {
  AnnotationRecord,
  ApiErrorBody,
  DeckDetail,
  DeckSummary,
  HealthResponse,
  InviteRecord,
  NoteRecord,
  PageResponse,
  UserRecord,
  UserRole,
} from "./types";

// Fetch wrapper for the Pro REST API.
//
// - Always sends `credentials: 'include'` so Better Auth session cookies travel.
// - Normalizes all error responses into `ApiError` so callers can branch on
//   `err.code` (e.g. `INVITE_REQUIRED`, `UPLOAD_TOO_LARGE`).
// - 204 responses resolve to `undefined`.

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | null;
  query?: Record<string, string | number | boolean | null | undefined>;
};

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parseError(res: Response): Promise<ApiError> {
  const fallback = `HTTP_${res.status}`;
  try {
    const data = (await res.json()) as Partial<ApiErrorBody>;
    const err = data?.error;
    if (err && typeof err.code === "string") {
      return new ApiError(
        err.code,
        typeof err.message === "string" ? err.message : res.statusText,
        res.status,
        err.details,
      );
    }
  } catch {
    // fall through to default
  }
  return new ApiError(fallback, res.statusText || "Request failed", res.status);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, headers, ...rest } = options;
  const init: RequestInit = {
    credentials: "include",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(headers ?? {}),
    },
  };

  if (body !== undefined && body !== null) {
    if (
      typeof body === "string" ||
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      body instanceof URLSearchParams ||
      // ReadableStream is body-init too; let the browser handle it.
      (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
    ) {
      init.body = body as BodyInit;
    } else {
      init.body = JSON.stringify(body);
      init.headers = {
        ...(init.headers as Record<string, string>),
        "Content-Type": "application/json",
      };
    }
  }

  const res = await fetch(buildUrl(path, query), init);

  if (!res.ok) {
    throw await parseError(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  // Caller expected JSON but got something else: surface as text in the error.
  if (contentType.startsWith("text/")) {
    return (await res.text()) as unknown as T;
  }
  return undefined as T;
}

// ---------- Decks ----------

type DeckListParams = { limit?: number; cursor?: string };

type DeckCreateProgress = (loaded: number, total: number) => void;

function createDeck(
  file: File,
  options: { title?: string; onProgress?: DeckCreateProgress; signal?: AbortSignal } = {},
): Promise<DeckSummary> {
  const form = new FormData();
  form.set("file", file);
  if (options.title) form.set("title", options.title);

  return new Promise<DeckSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/decks");
    xhr.withCredentials = true;
    xhr.responseType = "json";

    if (options.onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          options.onProgress?.(event.loaded, event.total);
        }
      });
    }

    xhr.addEventListener("load", () => {
      const status = xhr.status;
      const body = (xhr.response ?? {}) as Partial<ApiErrorBody> & Partial<DeckSummary>;
      if (status >= 200 && status < 300 && body && "id" in body && typeof body.id === "string") {
        resolve(body as DeckSummary);
        return;
      }
      const err = (body as ApiErrorBody | undefined)?.error;
      reject(
        new ApiError(
          err?.code ?? `HTTP_${status || "ERR"}`,
          err?.message ?? xhr.statusText ?? "Upload failed",
          status || 0,
          err?.details,
        ),
      );
    });
    xhr.addEventListener("error", () => {
      reject(new ApiError("NETWORK_ERROR", "Network error while uploading", 0));
    });
    xhr.addEventListener("abort", () => {
      reject(new ApiError("ABORTED", "Upload aborted", 0));
    });

    options.signal?.addEventListener(
      "abort",
      () => {
        try {
          xhr.abort();
        } catch {
          // ignore
        }
      },
      { once: true },
    );

    xhr.send(form);
  });
}

async function fetchDeckBlob(id: string): Promise<{ bytes: ArrayBuffer; filename: string }> {
  const res = await fetch(`/api/decks/${encodeURIComponent(id)}/blob`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await parseError(res);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1]) : `deck-${id}.stage`;
  const bytes = await res.arrayBuffer();
  return { bytes, filename };
}

// ---------- Notes ----------

type NotesListResponse = { items: Array<Omit<NoteRecord, "deckId">> };

// ---------- Annotations ----------

type AnnotationsListResponse = { items: Array<Omit<AnnotationRecord, "deckId">> };

// ---------- Public surface ----------

export const api = {
  health: () => request<HealthResponse>("/api/health"),

  decks: {
    list: (params: DeckListParams = {}) =>
      request<PageResponse<DeckSummary>>("/api/decks", { query: params }),
    get: (id: string) =>
      request<DeckDetail>(`/api/decks/${encodeURIComponent(id)}`),
    blob: (id: string) => fetchDeckBlob(id),
    create: createDeck,
    delete: (id: string) =>
      request<void>(`/api/decks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  notes: {
    list: (deckId: string) =>
      request<NotesListResponse>(`/api/decks/${encodeURIComponent(deckId)}/notes`),
    upsert: (deckId: string, slideIndex: number, body: string) =>
      request<NoteRecord>(
        `/api/decks/${encodeURIComponent(deckId)}/notes/${slideIndex}`,
        { method: "PUT", body: { body } },
      ),
    delete: (deckId: string, slideIndex: number) =>
      request<void>(
        `/api/decks/${encodeURIComponent(deckId)}/notes/${slideIndex}`,
        { method: "DELETE" },
      ),
  },

  annotations: {
    list: (deckId: string) =>
      request<AnnotationsListResponse>(
        `/api/decks/${encodeURIComponent(deckId)}/annotations`,
      ),
    upsert: (deckId: string, slideIndex: number, payload: unknown) =>
      request<AnnotationRecord>(
        `/api/decks/${encodeURIComponent(deckId)}/annotations/${slideIndex}`,
        { method: "PUT", body: { payload } },
      ),
    delete: (deckId: string, slideIndex: number) =>
      request<void>(
        `/api/decks/${encodeURIComponent(deckId)}/annotations/${slideIndex}`,
        { method: "DELETE" },
      ),
  },

  invites: {
    list: () => request<{ items: InviteRecord[] }>("/api/invites"),
    create: (input: { email?: string; role?: UserRole; ttlHours?: number }) =>
      request<InviteRecord>("/api/invites", { method: "POST", body: input }),
    delete: (id: string) =>
      request<void>(`/api/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  users: {
    list: () => request<{ items: UserRecord[] }>("/api/users"),
    update: (id: string, input: { role?: UserRole; name?: string }) =>
      request<UserRecord>(`/api/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: input,
      }),
    delete: (id: string) =>
      request<void>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
};

export type Api = typeof api;
