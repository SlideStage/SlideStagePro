import type { PrismaClient } from "@prisma/client";

export function createAnnotationRepository(prisma: PrismaClient) {
  return {
    async upsert(deckId: string, slideIndex: number, payloadJson: string) {
      return prisma.slideAnnotation.upsert({
        where: { deckId_slideIndex: { deckId, slideIndex } },
        update: { payloadJson },
        create: { deckId, slideIndex, payloadJson },
      });
    },
    async listForDeck(deckId: string) {
      return prisma.slideAnnotation.findMany({
        where: { deckId },
        orderBy: { slideIndex: "asc" },
      });
    },
    async delete(deckId: string, slideIndex: number) {
      return prisma.slideAnnotation
        .delete({ where: { deckId_slideIndex: { deckId, slideIndex } } })
        .catch((err: { code?: string }) => {
          if (err.code === "P2025") return null;
          throw err;
        });
    },
  };
}

export type AnnotationRepository = ReturnType<typeof createAnnotationRepository>;
