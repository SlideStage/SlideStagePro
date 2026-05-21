import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { buildTestApp, cookieHeader, resetTables, signUpUser, teardownTestEnv, } from "./helpers/testApp.js";
function buildValidStageZip() {
    const manifest = {
        schema: "slidestage@1.0",
        id: "deck-test-001",
        version: "1.0.0",
        title: "Test Deck",
        subtitle: null,
        author: null,
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        architecture: "multi-file",
        dimensions: { width: 1920, height: 1080 },
        totalSlides: 2,
        slides: [
            {
                index: 1,
                id: "s0",
                label: "Hello",
                file: "slides/01.html",
                thumbnail: null,
                notes: null,
            },
            {
                index: 2,
                id: "s1",
                label: "World",
                file: "slides/02.html",
                thumbnail: null,
                notes: null,
            },
        ],
    };
    const files = {
        "manifest.json": strToU8(JSON.stringify(manifest)),
        "slides/01.html": strToU8("<!doctype html><title>1</title><body>hi</body>"),
        "slides/02.html": strToU8("<!doctype html><title>2</title><body>bye</body>"),
    };
    const zipped = zipSync(files);
    return Buffer.from(zipped);
}
let ctx;
let userCookies;
beforeAll(async () => {
    ctx = await buildTestApp();
    await resetTables(ctx.prisma);
    // Bootstrap an admin then create a regular user.
    await signUpUser(ctx, {
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
    });
    const userResult = await signUpUser(ctx, {
        email: "alice@example.com",
        name: "Alice",
    });
    userCookies = userResult.cookies;
});
afterAll(async () => {
    await teardownTestEnv();
});
describe("POST /api/decks (upload)", () => {
    it("rejects upload without a session", async () => {
        const zip = buildValidStageZip();
        const form = new FormData();
        form.append("file", new File([new Uint8Array(zip)], "test.stage", { type: "application/zip" }));
        const res = await ctx.app.request("http://127.0.0.1:3000/api/decks", {
            method: "POST",
            body: form,
        });
        expect(res.status).toBe(401);
    });
    it("accepts a valid .stage upload and returns 201", async () => {
        const zip = buildValidStageZip();
        const form = new FormData();
        form.append("file", new File([new Uint8Array(zip)], "test.stage", { type: "application/zip" }));
        const res = await ctx.app.request("http://127.0.0.1:3000/api/decks", {
            method: "POST",
            headers: { Cookie: cookieHeader(userCookies) },
            body: form,
        });
        expect(res.status).toBe(201);
        const body = (await res.json());
        expect(body.title).toBe("Test Deck");
        expect(body.fingerprint.startsWith("sha256-")).toBe(true);
        expect(body.manifestSummary.slideCount).toBe(2);
        expect(body.manifestSummary.schema).toBe("slidestage@1.0");
        // Verify storage actually has the bytes via the blob endpoint.
        const blob = await ctx.app.request(`http://127.0.0.1:3000/api/decks/${body.id}/blob`, { headers: { Cookie: cookieHeader(userCookies) } });
        expect(blob.status).toBe(200);
        const buf = Buffer.from(await blob.arrayBuffer());
        expect(buf.byteLength).toBe(zip.byteLength);
    });
    it("rejects a non-zip payload with INVALID_STAGE_ZIP", async () => {
        const form = new FormData();
        form.append("file", new File([new Uint8Array(Buffer.from("not a zip"))], "broken.stage", {
            type: "application/zip",
        }));
        const res = await ctx.app.request("http://127.0.0.1:3000/api/decks", {
            method: "POST",
            headers: { Cookie: cookieHeader(userCookies) },
            body: form,
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body?.error?.code).toBe("INVALID_STAGE_ZIP");
    });
    it("rejects a zip without manifest.json", async () => {
        const zip = Buffer.from(zipSync({ "slides/01.html": strToU8("<html></html>") }));
        const form = new FormData();
        form.append("file", new File([new Uint8Array(zip)], "nomf.stage", { type: "application/zip" }));
        const res = await ctx.app.request("http://127.0.0.1:3000/api/decks", {
            method: "POST",
            headers: { Cookie: cookieHeader(userCookies) },
            body: form,
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body?.error?.code).toBe("INVALID_STAGE_ZIP");
    });
});
