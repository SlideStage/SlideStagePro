import type {
  DeckInfoPatchBody,
  DeckInfoPatchResponse,
  Manifest,
  NotesAuditResponse,
  NotesPatchBody,
  NotesPatchResponse,
  Stroke,
} from '@slidestage/shared';

export interface DeckListItem {
  id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  totalSlides: number;
  width: number;
  height: number;
  sizeBytes: number;
  coverThumbnail: string | null;
  uploadedAt: string;
  updatedAt: string;
  /**
   * Short-lived deck-scoped access token used to authenticate `/storage/...`
   * subresource requests made by sandboxed slide iframes (which can't carry
   * the SameSite=Lax session cookie because they run at an opaque origin).
   * Pass it as `?t=<token>` via `storageAssetUrl(deckId, file, token)`.
   */
  storageToken: string;
  /**
   * Compact summary of `manifest.offline`. `null` when the deck pre-dates
   * the offline-mirror feature or shipped without a mirror pass. Used by
   * the library UI to render a one-line "offline ready" badge without
   * round-tripping the full manifest.
   */
  offline: {
    ready: boolean;
    mirroredAt: string;
    mirroredAssets: number;
    skippedUrls: number;
  } | null;
}

export interface DeckDetail extends DeckListItem {
  manifest: Manifest;
  storageRoot: string;
}

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    let payload: { message?: string; error?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // non-JSON error
    }
    throw new ApiError(
      payload.message ?? `Request failed: ${res.status}`,
      res.status,
      payload.error,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: (): Promise<{ status: string; schema: string }> =>
    request('/api/health'),

  listDecks: (): Promise<{ decks: DeckListItem[] }> => request('/api/decks'),

  getDeck: (id: string): Promise<DeckDetail> => request(`/api/decks/${id}`),

  deleteDeck: (id: string): Promise<void> =>
    request(`/api/decks/${id}`, { method: 'DELETE' }),

  uploadDeck: async (
    file: File,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ id: string; manifest: Manifest }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/decks');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (ev): void => {
        if (ev.lengthComputable && onProgress) {
          onProgress(ev.loaded, ev.total);
        }
      };
      xhr.onload = (): void => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(e);
          }
        } else {
          let msg = `Upload failed: ${xhr.status}`;
          let code: string | undefined;
          try {
            const body = JSON.parse(xhr.responseText);
            msg = body.message ?? msg;
            code = body.error;
          } catch {
            /* ignore */
          }
          reject(new ApiError(msg, xhr.status, code));
        }
      };
      xhr.onerror = (): void =>
        reject(new ApiError('network error', 0));
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  },

  getAnnotations: (
    deckId: string,
  ): Promise<{ annotations: Record<number, Stroke[]> }> =>
    request(`/api/decks/${deckId}/annotations`),

  getSlideAnnotations: (
    deckId: string,
    slideIdx: number,
  ): Promise<{ strokes: Stroke[] }> =>
    request(`/api/decks/${deckId}/annotations/${slideIdx}`),

  putSlideAnnotations: (
    deckId: string,
    slideIdx: number,
    strokes: Stroke[],
  ): Promise<{ ok: true; count: number }> =>
    request(`/api/decks/${deckId}/annotations/${slideIdx}`, {
      method: 'POST',
      body: JSON.stringify({ strokes }),
    }),

  /**
   * Patch one or more slides' speaker notes. Keys are 1-based slide indices
   * (matching `manifest.slides[].index`). Send an empty string or null to
   * clear the note for that slide.
   */
  updateNotes: (
    deckId: string,
    notes: NotesPatchBody['notes'],
  ): Promise<NotesPatchResponse> =>
    request(`/api/decks/${deckId}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes } satisfies NotesPatchBody),
    }),

  /**
   * Patch the deck-level metadata (title / subtitle / author / description)
   * and / or per-slide labels. Only the fields you include in `patch` are
   * touched. The server enforces title-non-empty + ownership.
   */
  updateDeckInfo: (
    deckId: string,
    patch: DeckInfoPatchBody,
  ): Promise<DeckInfoPatchResponse> =>
    request(`/api/decks/${deckId}/info`, {
      method: 'PATCH',
      body: JSON.stringify(patch satisfies DeckInfoPatchBody),
    }),

  /**
   * Fetch a paginated page of the speaker-notes edit history (newest first).
   * `cursor` should be `nextCursor` from the previous page; omit for page 1.
   */
  getNotesAudit: (
    deckId: string,
    opts?: { cursor?: number; limit?: number },
  ): Promise<NotesAuditResponse> => {
    const params = new URLSearchParams();
    if (opts?.cursor !== undefined) params.set('cursor', String(opts.cursor));
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const query = params.toString();
    return request(
      `/api/decks/${deckId}/notes/audit${query ? `?${query}` : ''}`,
    );
  },

  /**
   * Trigger a browser-side download of the current deck repacked as a fresh
   * `.stage` zip (includes any speaker-note edits made via `updateNotes`).
   */
  exportDeck: async (deckId: string): Promise<void> => {
    const res = await fetch(`/api/decks/${deckId}/export`, {
      credentials: 'include',
    });
    if (!res.ok) {
      let msg = `Export failed: ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) msg = body.message;
      } catch {
        /* ignore */
      }
      throw new ApiError(msg, res.status);
    }
    const blob = await res.blob();
    // Pull the filename from Content-Disposition; fall back to `<id>.stage`.
    const cd = res.headers.get('content-disposition') ?? '';
    const match = cd.match(/filename="?([^"]+)"?/i);
    const filename = match?.[1] ?? `${deckId}.stage`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

export { ApiError };
