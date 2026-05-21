#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const apiDir = resolve(here, "..");
const repoRoot = resolve(apiDir, "..", "..");
const rootEnv = join(repoRoot, ".env");

if (existsSync(rootEnv)) {
  loadEnvFile(rootEnv);
}

if (!process.env.DATABASE_URL) {
  const databasePath = join(repoRoot, "data", "slidestage-pro.sqlite");
  process.env.DATABASE_URL = `file:${databasePath}`;
  console.warn(
    `[prisma-env] DATABASE_URL not set; using local dev SQLite at ${databasePath}`,
  );
}

const prismaCli = join(apiDir, "node_modules", "prisma", "build", "index.js");
const child = spawn(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  cwd: apiDir,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
