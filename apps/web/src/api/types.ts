// Mirror of `apps/api/src/types/contract.ts` (the same shapes also live in
// `docs/api-types.d.ts`). Kept hand-aligned with `docs/API_CONTRACT.md` §8 —
// the contract is FROZEN for Phase 1. If you change something here without
// updating the contract doc + Agent A, you will break the boundary.

export type DeckSummary = {
  id: string;
  title: string;
  fingerprint: string;
  currentVersionId: string | null;
  visibility: "private" | "unlisted" | "public";
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  slideCount: number;
};

export type DeckCurrentVersion = {
  id: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export type DeckDetail = DeckSummary & {
  currentVersion: DeckCurrentVersion | null;
  manifest: unknown;
};

export type NoteRecord = {
  deckId: string;
  slideIndex: number;
  body: string;
  updatedAt: string;
};

export type AnnotationRecord = {
  deckId: string;
  slideIndex: number;
  payload: unknown;
  updatedAt: string;
};

export type UserRole = "user" | "admin";

export type InviteRecord = {
  id: string;
  token: string;
  email: string | null;
  role: UserRole;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
  createdById: string;
};

export type UserRecord = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

export type PageResponse<T> = {
  items: T[];
  nextCursor?: string | null;
};

export type HealthResponse = {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  checks: Record<string, "ok" | "fail">;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
