import type { PrismaClient } from "@prisma/client";

export interface CreateInviteInput {
  token: string;
  email: string | null;
  role: "user" | "admin";
  createdById: string;
  expiresAt: Date;
}

export function createInviteRepository(prisma: PrismaClient) {
  return {
    async list() {
      return prisma.invite.findMany({ orderBy: { createdAt: "desc" } });
    },
    async findById(id: string) {
      return prisma.invite.findUnique({ where: { id } });
    },
    async findByToken(token: string) {
      return prisma.invite.findUnique({ where: { token } });
    },
    async create(input: CreateInviteInput) {
      return prisma.invite.create({
        data: {
          token: input.token,
          email: input.email,
          role: input.role,
          createdById: input.createdById,
          expiresAt: input.expiresAt,
        },
      });
    },
    async deleteById(id: string) {
      return prisma.invite
        .delete({ where: { id } })
        .catch((err: { code?: string }) => {
          if (err.code === "P2025") return null;
          throw err;
        });
    },
    async markUsed(id: string, email: string) {
      return prisma.invite.update({
        where: { id },
        data: { usedAt: new Date(), usedByEmail: email },
      });
    },
  };
}

export type InviteRepository = ReturnType<typeof createInviteRepository>;
