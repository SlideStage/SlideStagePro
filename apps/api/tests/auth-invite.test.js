import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, resetTables, signUpUser, teardownTestEnv, } from "./helpers/testApp.js";
let ctx;
let adminId;
beforeEach(async () => {
    if (!ctx) {
        ctx = await buildTestApp();
    }
    await resetTables(ctx.prisma);
    // Bootstrap an admin so subsequent sign-ups require an invite (the hook
    // bypasses the check only when user count is 0).
    const { userId } = await signUpUser(ctx, {
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
    });
    adminId = userId;
});
afterAll(async () => {
    await teardownTestEnv();
});
async function attemptSignUp(body) {
    return ctx.app.request("http://127.0.0.1:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
describe("POST /api/auth/sign-up/email — invite lockdown", () => {
    it("rejects sign-up without inviteToken (INVITE_REQUIRED)", async () => {
        const res = await attemptSignUp({
            email: "alice@example.com",
            password: "Passw0rd!Test",
            name: "Alice",
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body?.code ?? body?.error?.code).toBe("INVITE_REQUIRED");
    });
    it("rejects sign-up with expired invite (INVITE_EXPIRED)", async () => {
        const token = randomBytes(16).toString("hex");
        await ctx.prisma.invite.create({
            data: {
                token,
                role: "user",
                createdById: adminId,
                expiresAt: new Date(Date.now() - 60_000),
            },
        });
        const res = await attemptSignUp({
            email: "expired@example.com",
            password: "Passw0rd!Test",
            name: "Expired",
            inviteToken: token,
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body?.code ?? body?.error?.code).toBe("INVITE_EXPIRED");
    });
    it("rejects sign-up with already-used invite (INVITE_USED)", async () => {
        const token = randomBytes(16).toString("hex");
        await ctx.prisma.invite.create({
            data: {
                token,
                role: "user",
                createdById: adminId,
                expiresAt: new Date(Date.now() + 60_000),
                usedAt: new Date(),
                usedByEmail: "first@example.com",
            },
        });
        const res = await attemptSignUp({
            email: "used@example.com",
            password: "Passw0rd!Test",
            name: "Used",
            inviteToken: token,
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body?.code ?? body?.error?.code).toBe("INVITE_USED");
    });
    it("rejects sign-up when email-bound invite mismatches (INVITE_EMAIL_MISMATCH)", async () => {
        const token = randomBytes(16).toString("hex");
        await ctx.prisma.invite.create({
            data: {
                token,
                role: "user",
                createdById: adminId,
                expiresAt: new Date(Date.now() + 60_000),
                email: "expected@example.com",
            },
        });
        const res = await attemptSignUp({
            email: "wrong@example.com",
            password: "Passw0rd!Test",
            name: "Wrong",
            inviteToken: token,
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body?.code ?? body?.error?.code).toBe("INVITE_EMAIL_MISMATCH");
    });
    it("creates user with invite.role and marks invite used on success", async () => {
        const token = randomBytes(16).toString("hex");
        await ctx.prisma.invite.create({
            data: {
                token,
                role: "user",
                createdById: adminId,
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const res = await attemptSignUp({
            email: "alice@example.com",
            password: "Passw0rd!Test",
            name: "Alice",
            inviteToken: token,
        });
        expect(res.status).toBe(200);
        const created = await ctx.prisma.user.findUnique({
            where: { email: "alice@example.com" },
        });
        expect(created).toBeTruthy();
        expect(created.role).toBe("user");
        const invite = await ctx.prisma.invite.findUnique({ where: { token } });
        expect(invite.usedAt).not.toBeNull();
        expect(invite.usedByEmail).toBe("alice@example.com");
    });
});
