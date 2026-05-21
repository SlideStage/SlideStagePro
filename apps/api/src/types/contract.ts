/**
 * Public API contract types — mirror of `docs/API_CONTRACT.md` §8.
 * Imported via `import type` by web client to stay in sync.
 */

export type Visibility = "private" | "unlisted" | "public";
export type Role = "user" | "admin";

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

export interface DeckDetail extends DeckSummary {
  currentVersion: {
    id: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
  } | null;
  manifest: unknown;
}

export interface ManifestSummary {
  slideCount: number;
  title: string;
  createdAt: string;
  schema: string;
}

export interface DeckCreatedResponse {
  id: string;
  title: string;
  fingerprint: string;
  currentVersionId: string;
  createdAt: string;
  manifestSummary: ManifestSummary;
}

export interface PageEnvelope<T> {
  items: T[];
  nextCursor: string | null;
}

export interface NoteRecord {
  deckId: string;
  slideIndex: number;
  body: string;
  updatedAt: string;
}

export interface AnnotationRecord {
  deckId: string;
  slideIndex: number;
  payload: unknown;
  updatedAt: string;
}

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

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  checks: { db: "ok" | "fail"; storage: "ok" | "fail" };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
