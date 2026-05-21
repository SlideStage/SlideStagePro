import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp,
  resetTables,
  teardownTestEnv,
  type TestApp,
} from "./helpers/testApp.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
  await resetTables(ctx.prisma);
});

afterAll(async () => {
  await teardownTestEnv();
});

describe("GET /api/health", () => {
  it("returns ok when db + storage are reachable", async () => {
    const res = await ctx.app.request("http://127.0.0.1:3000/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      uptimeSeconds: number;
      checks: { db: string; storage: string };
    };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(body.checks.db).toBe("ok");
    expect(body.checks.storage).toBe("ok");
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
  });

  it("returns 503 when storage probe fails", async () => {
    const broken = await buildTestApp({
      storage: {
        async putObject() {},
        async getObject() {
          throw new Error("nope");
        },
        async deleteObject() {},
        async exists() {
          return false;
        },
        async health() {
          return { ok: false, detail: "broken storage" };
        },
      },
    });
    const res = await broken.app.request("http://127.0.0.1:3000/api/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: { db: string; storage: string };
    };
    expect(body.status).toBe("degraded");
    expect(body.checks.storage).toBe("fail");
  });
});
