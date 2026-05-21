import type { PrismaClient } from "@prisma/client";

export function createVersionRepository(prisma: PrismaClient) {
  return {
    async findById(id: string) {
      return prisma.deckVersion.findUnique({ where: { id } });
    },
    async listByDeck(deckId: string) {
      return prisma.deckVersion.findMany({
        where: { deckId },
        orderBy: { createdAt: "desc" },
      });
    },
    async findCurrent(deckId: string) {
      const deck = await prisma.deck.findUnique({
        where: { id: deckId },
        select: { currentVersionId: true },
      });
      if (!deck?.currentVersionId) return null;
      return prisma.deckVersion.findUnique({
        where: { id: deck.currentVersionId },
      });
    },
    async setObjectKey(id: string, objectKey: string) {
      return prisma.deckVersion.update({
        where: { id },
        data: { objectKey },
      });
    },
  };
}

export type VersionRepository = ReturnType<typeof createVersionRepository>;
