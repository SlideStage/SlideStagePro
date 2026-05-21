import type { PrismaClient } from "@prisma/client";

export function createNoteRepository(prisma: PrismaClient) {
  return {
    async upsert(deckId: string, slideIndex: number, body: string) {
      return prisma.slideNote.upsert({
        where: { deckId_slideIndex: { deckId, slideIndex } },
        update: { body },
        create: { deckId, slideIndex, body },
      });
    },
    async listForDeck(deckId: string) {
      return prisma.slideNote.findMany({
        where: { deckId },
        orderBy: { slideIndex: "asc" },
      });
    },
    async delete(deckId: string, slideIndex: number) {
      return prisma.slideNote
        .delete({ where: { deckId_slideIndex: { deckId, slideIndex } } })
        .catch((err: { code?: string }) => {
          if (err.code === "P2025") return null;
          throw err;
        });
    },
  };
}

export type NoteRepository = ReturnType<typeof createNoteRepository>;
