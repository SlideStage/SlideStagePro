import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { applySqlitePragmas, createPrismaClient, } from "../../src/db/prisma.js";
import { createApp } from "../../src/server.js";
const REPO_ROOT = (() => {
    // Repo root is two levels up from apps/api/
    return new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
})();
const SCHEMA_PATH = `${REPO_ROOT}/prisma/schema.prisma`;
let workerEnv = null;
/** Set up a fresh SQLite database + storage dir for the test worker. */
export async function setupTestEnv() {
    if (workerEnv)
        return workerEnv;
    const tempDir = mkdtempSync(join(tmpdir(), "slidestage-pro-api-test-"));
    const dbPath = join(tempDir, "test.sqlite");
    const dataDir = join(tempDir, "data");
    const databaseUrl = `file:${dbPath}`;
    process.env.DATABASE_URL = databaseUrl;
    // `prisma db push` against the temp DB. We use exec rather than the JS
    // API because the CLI handles migration generation more robustly.
    execFileSync("pnpm", [
        "exec",
        "prisma",
        "db",
        "push",
        "--schema",
        SCHEMA_PATH,
        "--skip-generate",
        "--accept-data-loss",
    ], {
        cwd: `${REPO_ROOT}/apps/api`,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
    });
    const prisma = createPrismaClient({ databaseUrl });
    await applySqlitePragmas(prisma);
    workerEnv = { tempDir, dbPath, dataDir, prisma };
    return workerEnv;
}
export async function teardownTestEnv() {
    if (!workerEnv)
        return;
    await workerEnv.prisma.$disconnect();
    rmSync(workerEnv.tempDir, { recursive: true, force: true });
    workerEnv = null;
}
export async function resetTables(prisma) {
    // FK order matters.
    await prisma.$transaction([
        prisma.slideAnnotation.deleteMany({}),
        prisma.slideNote.deleteMany({}),
        prisma.deckVersion.deleteMany({}),
        prisma.deck.deleteMany({}),
        prisma.invite.deleteMany({}),
        prisma.session.deleteMany({}),
        prisma.account.deleteMany({}),
        prisma.verification.deleteMany({}),
        prisma.user.deleteMany({}),
    ]);
}
export async function buildTestApp(opts = {}) {
    const env = await setupTestEnv();
    const config = {
        nodeEnv: "test",
        isProduction: false,
        databaseUrl: `file:${env.dbPath}`,
        storage: { driver: "local", dataDir: env.dataDir },
        http: { port: 0, host: "127.0.0.1" },
        betterAuthSecret: "test-secret-must-be-at-least-32-chars-long-aaa",
        betterAuthURL: "http://127.0.0.1:3000",
        bootstrapAdmin: null,
        uploadMaxBytes: opts.uploadMaxBytes ?? 100 * 1024 * 1024,
        annotationMaxBytes: opts.annotationMaxBytes ?? 64 * 1024,
        corsOrigins: ["http://127.0.0.1:5173", "http://127.0.0.1:3000"],
    };
    const built = createApp({
        config,
        prisma: env.prisma,
        ...(opts.storage ? { storage: opts.storage } : {}),
    });
    return { ...built, prisma: env.prisma, config };
}
/**
 * Sign up a user via Better Auth. If `inviteToken` is not provided, a
 * one-shot invite row is created and consumed so the call succeeds even
 * after the bootstrap admin exists.
 *
 * Returns the Set-Cookie headers (Better Auth auto-signs in by default) and
 * the user row.
 */
export async function signUpUser(app, input) {
    const userCount = await app.prisma.user.count();
    let inviteToken = input.inviteToken;
    if (userCount > 0 && !inviteToken) {
        // Pick any admin (or any user) as createdBy.
        const creator = await app.prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
        if (!creator)
            throw new Error("no creator available");
        const token = randomBytes(16).toString("hex");
        await app.prisma.invite.create({
            data: {
                token,
                role: input.role ?? "user",
                createdById: creator.id,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                email: null,
            },
        });
        inviteToken = token;
    }
    const body = {
        email: input.email,
        password: input.password ?? "Passw0rd!Test",
        name: input.name ?? input.email,
    };
    if (inviteToken)
        body.inviteToken = inviteToken;
    const res = await app.app.request("http://127.0.0.1:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`sign-up failed (${res.status}): ${text}`);
    }
    // Better Auth sets multiple Set-Cookie headers.
    const cookies = [];
    const setCookie = res.headers.get("set-cookie");
    if (setCookie)
        cookies.push(setCookie);
    // Newer Node uses getSetCookie() for multiple values.
    const sch = res.headers.getSetCookie?.();
    if (sch && sch.length > 0) {
        cookies.splice(0, cookies.length, ...sch);
    }
    const user = await app.prisma.user.findUnique({ where: { email: input.email } });
    if (!user)
        throw new Error("user not created");
    // Promote to admin if requested AND invite didn't already set the role.
    if (input.role === "admin" && user.role !== "admin") {
        await app.prisma.user.update({
            where: { id: user.id },
            data: { role: "admin" },
        });
    }
    return { cookies, userId: user.id };
}
/** Sign in by email/password and return cookies. */
export async function signInUser(app, email, password = "Passw0rd!Test") {
    const res = await app.app.request("http://127.0.0.1:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`sign-in failed (${res.status}): ${text}`);
    }
    const cookies = [];
    const sch = res.headers.getSetCookie?.();
    if (sch && sch.length > 0)
        cookies.push(...sch);
    else {
        const sc = res.headers.get("set-cookie");
        if (sc)
            cookies.push(sc);
    }
    return { cookies };
}
/** Join cookies into a single Cookie header for outgoing requests. */
export function cookieHeader(cookies) {
    return cookies
        .map((c) => c.split(";")[0])
        .filter(Boolean)
        .join("; ");
}
