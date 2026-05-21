import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import {
  applySqlitePragmas,
  createPrismaClient,
  setPrisma,
} from "./db/prisma.js";
import { createApp } from "./server.js";
import { ensureBootstrapAdmin } from "./auth/bootstrap.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const prisma = createPrismaClient({ databaseUrl: config.databaseUrl });
  setPrisma(prisma);
  await applySqlitePragmas(prisma);

  const built = createApp({ config, prisma });

  // Bootstrap admin BEFORE serving traffic (per AUTH_FLOW §3.1).
  await ensureBootstrapAdmin(config, prisma, built.auth);

  serve(
    {
      fetch: built.app.fetch,
      port: config.http.port,
      hostname: config.http.host,
    },
    (info) => {
      console.log(
        `[api] listening on http://${info.address}:${info.port} (env=${config.nodeEnv})`,
      );
    },
  );

  const shutdown = async (signal: string) => {
    console.log(`[api] received ${signal}, shutting down`);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[api] fatal startup error:", err);
  process.exit(1);
});
