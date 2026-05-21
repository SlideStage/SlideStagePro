import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";

export interface AuthBuildOptions {
  prisma: PrismaClient;
  config: Config;
}

export function buildAuth({ prisma, config }: AuthBuildOptions) {
  const options: BetterAuthOptions = {
    database: prismaAdapter(prisma, { provider: "sqlite" }),
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthURL,
    trustedOrigins: config.corsOrigins,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "user",
          input: false,
        },
      },
    },
    advanced: {
      cookiePrefix: "slidestage-pro",
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            // Bootstrap path: when the user table is empty, the very first
            // sign-up is the bootstrap admin and bypasses the invite check.
            // This makes the hook self-consistent without needing a special
            // ctx flag that Better Auth doesn't natively support.
            const existingUserCount = await prisma.user.count();
            if (existingUserCount === 0) {
              return { data: user };
            }

            const body =
              (ctx as unknown as { body?: { inviteToken?: unknown } } | undefined)?.body ??
              (ctx?.context as { body?: { inviteToken?: unknown } } | undefined)?.body;
            const inviteToken =
              typeof body?.inviteToken === "string" ? body.inviteToken : undefined;
            if (!inviteToken) {
              throw new APIError("FORBIDDEN", {
                code: "INVITE_REQUIRED",
                message: "Invite token required",
              });
            }
            const invite = await prisma.invite.findUnique({
              where: { token: inviteToken },
            });
            if (!invite) {
              throw new APIError("FORBIDDEN", {
                code: "INVITE_REQUIRED",
                message: "Invalid invite",
              });
            }
            if (invite.expiresAt < new Date()) {
              throw new APIError("FORBIDDEN", {
                code: "INVITE_EXPIRED",
                message: "Invite expired",
              });
            }
            if (invite.usedAt) {
              throw new APIError("FORBIDDEN", {
                code: "INVITE_USED",
                message: "Invite already used",
              });
            }
            if (invite.email && invite.email !== user.email) {
              throw new APIError("FORBIDDEN", {
                code: "INVITE_EMAIL_MISMATCH",
                message: "Invite email mismatch",
              });
            }
            return { data: user };
          },
          after: async (user, ctx) => {
            const body =
              (ctx as unknown as { body?: { inviteToken?: unknown } } | undefined)?.body ??
              (ctx?.context as { body?: { inviteToken?: unknown } } | undefined)?.body;
            const inviteToken =
              typeof body?.inviteToken === "string" ? body.inviteToken : undefined;
            if (!inviteToken) return;
            const invite = await prisma.invite.findUnique({
              where: { token: inviteToken },
            });
            if (!invite) return;
            const role = invite.role === "admin" ? "admin" : "user";
            await prisma.$transaction([
              prisma.invite.update({
                where: { id: invite.id },
                data: { usedAt: new Date(), usedByEmail: user.email },
              }),
              prisma.user.update({
                where: { id: user.id },
                data: { role },
              }),
            ]);
            if (role === "admin") {
              console.warn(
                `[auth] admin user created via invite ${invite.id} (email=${user.email})`,
              );
            }
          },
        },
      },
    },
  };

  return betterAuth(options);
}

export type Auth = ReturnType<typeof buildAuth>;
export type AuthSession = Auth["$Infer"]["Session"];
