import type { PrismaClient } from "@prisma/client";

export function createUserRepository(prisma: PrismaClient) {
  return {
    async count() {
      return prisma.user.count();
    },
    async findById(id: string) {
      return prisma.user.findUnique({ where: { id } });
    },
    async findByEmail(email: string) {
      return prisma.user.findUnique({ where: { email } });
    },
    async list() {
      return prisma.user.findMany({ orderBy: { createdAt: "asc" } });
    },
    async update(id: string, data: { role?: "user" | "admin"; name?: string }) {
      return prisma.user.update({ where: { id }, data });
    },
    async deleteById(id: string) {
      return prisma.user.delete({ where: { id } });
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
