import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import type { StorageDriver } from "../storage/types.js";
import type { HealthResponse } from "../types/contract.js";

export interface HealthDeps {
  prisma: PrismaClient;
  storage: StorageDriver;
  version: string;
  startedAt: number;
}

export function createHealthRoutes(deps: HealthDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const [dbOk, storageRes] = await Promise.all([
      checkDb(deps.prisma),
      deps.storage.health(),
    ]);
    const storageOk = storageRes.ok;
    const status: HealthResponse["status"] =
      dbOk && storageOk ? "ok" : "degraded";
    const body: HealthResponse = {
      status,
      version: deps.version,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      checks: {
        db: dbOk ? "ok" : "fail",
        storage: storageOk ? "ok" : "fail",
      },
    };
    return c.json(body, status === "ok" ? 200 : 503);
  });

  return app;
}

async function checkDb(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return true;
  } catch (err) {
    console.warn("[health] db check failed", err);
    return false;
  }
}
