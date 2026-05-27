import type { Deck, Prisma, PrismaClient } from "@prisma/client";

export interface DeckListInput {
  ownerId: string | null; // null means "all" (admin view)
  cursor?: string;
  limit: number;
}

export interface DeckListResult {
  items: Array<Deck & { _slideCount: number }>;
  nextCursor: string | null;
}

export function createDeckRepository(prisma: PrismaClient) {
  return {
    async list({ ownerId, cursor, limit }: DeckListInput): Promise<DeckListResult> {
      const where: Prisma.DeckWhereInput = ownerId ? { ownerId } : {};
      const rows = await prisma.deck.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          versions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, manifestJson: true },
          },
        },
      });
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map((d) => {
        let slideCount = 0;
        const v0 = d.versions[0];
        if (v0) {
          try {
            const m = JSON.parse(v0.manifestJson) as { totalSlides?: number; slides?: unknown[] };
            slideCount =
              typeof m.totalSlides === "number"
                ? m.totalSlides
                : Array.isArray(m.slides)
                  ? m.slides.length
                  : 0;
          } catch {
            slideCount = 0;
          }
        }
        // strip versions from outer object, attach slideCount
        const { versions: _v, ...rest } = d;
        return { ...rest, _slideCount: slideCount } as Deck & { _slideCount: number };
      });
      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]!.id : null,
      };
    },

    async findById(id: string) {
      return prisma.deck.findUnique({
        where: { id },
        include: {
          versions: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
    },

    async findByIdForOwnerOrAdmin(id: string, userId: string, isAdmin: boolean) {
      const deck = await prisma.deck.findUnique({
        where: { id },
        include: {
          versions: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
      if (!deck) return null;
      if (!isAdmin && deck.ownerId !== userId) return null;
      return deck;
    },

    /**
     * Insert a deck + its first version atomically.
     *
     * Phase C.1 (2026-05-27): the caller now supplies `id` / `version.id`
     * pre-generated (via `crypto.randomUUID()` at the route layer) so the
     * blob can be written to its FINAL `objectKey` BEFORE the transaction
     * runs. This eliminates the old `objectKey = "PENDING"` exposure
     * window — see `routes/decks.ts` POST handler for the surrounding
     * "blob-first, DB-second, cleanup-on-DB-failure" flow.
     *
     * Prisma's `@default(cuid())` is preserved as a backstop: if `id`
     * is omitted the row still gets a cuid. New call sites should always
     * pass it explicitly to keep the crash-safety guarantee.
     */
    async createWithVersion(input: {
      id?: string;
      ownerId: string;
      title: string;
      fingerprint: string;
      visibility?: "private" | "unlisted" | "public";
      version: {
        id?: string;
        objectKey: string;
        manifestJson: string;
        sizeBytes: number;
        sha256: string;
      };
    }) {
      return prisma.$transaction(async (tx) => {
        const deck = await tx.deck.create({
          data: {
            ...(input.id ? { id: input.id } : {}),
            ownerId: input.ownerId,
            title: input.title,
            fingerprint: input.fingerprint,
            visibility: input.visibility ?? "private",
          },
        });
        const version = await tx.deckVersion.create({
          data: {
            ...(input.version.id ? { id: input.version.id } : {}),
            deckId: deck.id,
            objectKey: input.version.objectKey,
            manifestJson: input.version.manifestJson,
            sizeBytes: input.version.sizeBytes,
            sha256: input.version.sha256,
          },
        });
        const updated = await tx.deck.update({
          where: { id: deck.id },
          data: { currentVersionId: version.id },
          include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
        });
        return { deck: updated, version };
      });
    },

    async deleteById(id: string) {
      return prisma.deck.delete({ where: { id } });
    },

    async listVersionKeys(deckId: string) {
      return prisma.deckVersion.findMany({
        where: { deckId },
        select: { id: true, objectKey: true },
      });
    },
  };
}

export type DeckRepository = ReturnType<typeof createDeckRepository>;
