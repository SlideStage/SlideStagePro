#!/usr/bin/env node
// Sync vendored Lite tarballs into vendor/ for v0 dependency bridging.
//
// Workflow:
//   1. Reads --lite-path (default ../SlideStageLite) — the local Lite checkout.
//   2. For each @slidestage/{core,ui,lite-preset}, runs `pnpm pack` inside the
//      package directory to produce a `.tgz`.
//   3. Renames each tarball to a stable filename `slidestage-<name>-<version>.tgz`
//      and copies into vendor/.
//   4. Writes a manifest at vendor/MANIFEST.json with sha256 + source commit.
//
// IMPORTANT:
//   - This script lives in scripts/ and is invoked manually (or via CI step).
//   - The Pro runtime/package.json never references the Lite checkout directly.
//     Instead, package.json points at `file:./vendor/slidestage-core-*.tgz` etc.
//   - check-boundaries.mjs treats this file as a special case (it intentionally
//     references "../SlideStageLite/" by string).
//
// Usage:
//   node scripts/sync-vendor.mjs
//   node scripts/sync-vendor.mjs --lite-path ../SlideStageLite
//   node scripts/sync-vendor.mjs --dry-run

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile, copyFile, rename, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_DIR = join(REPO_ROOT, "vendor");

const args = process.argv.slice(2);
function argValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const LITE_PATH = resolve(argValue("--lite-path") ?? join(REPO_ROOT, "..", "SlideStageLite"));
const DRY_RUN = args.includes("--dry-run");

const PACKAGES = [
  { name: "@slidestage/core", dir: "packages/core", base: "slidestage-core" },
  { name: "@slidestage/ui", dir: "packages/ui", base: "slidestage-ui" },
  { name: "@slidestage/lite-preset", dir: "packages/lite-preset", base: "slidestage-lite-preset" },
];

async function sha256(file) {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function readPkgVersion(absDir) {
  const pkgJson = JSON.parse(await readFile(join(absDir, "package.json"), "utf8"));
  if (!pkgJson.version) throw new Error(`No version in ${absDir}/package.json`);
  return pkgJson.version;
}

async function getLiteHeadCommit() {
  try {
    const { stdout } = await exec("git", ["-C", LITE_PATH, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function packOne({ name, dir, base }) {
  const absPkgDir = join(LITE_PATH, dir);
  if (!existsSync(absPkgDir)) {
    throw new Error(`Lite package not found: ${absPkgDir}`);
  }
  // Lite packages declare `files: ["dist"]` and `publishConfig` pointing at dist.
  // pnpm pack will therefore include nothing of substance unless dist is built.
  if (!existsSync(join(absPkgDir, "dist"))) {
    throw new Error(
      `Lite package ${name} has no dist/ — run \`pnpm -r --filter "./packages/*" build\` inside ${LITE_PATH} first.`
    );
  }
  const version = await readPkgVersion(absPkgDir);
  const targetName = `${base}-${version}.tgz`;
  const targetPath = join(VENDOR_DIR, targetName);

  if (DRY_RUN) {
    console.log(`  [dry-run] would pack ${name} @ ${version} → vendor/${targetName}`);
    return { name, version, file: targetName, sha256: null };
  }

  // `pnpm pack` writes a tgz into the package dir and prints the path.
  const { stdout } = await exec("pnpm", ["pack", "--pack-destination", VENDOR_DIR], {
    cwd: absPkgDir,
  });
  // pnpm prints the tarball path on the last line, but the file name follows
  // npm convention: <name-without-scope>-<version>.tgz. We'll find by reading the dir.
  const dirEntries = await readdir(VENDOR_DIR);
  const candidates = dirEntries.filter(
    (f) => f.endsWith(".tgz") && f.startsWith(base + "-")
  );
  if (candidates.length === 0) {
    throw new Error(`pnpm pack did not produce a tarball for ${name}`);
  }
  // Pick the latest by mtime so we re-use the one we just produced.
  const withMtime = await Promise.all(
    candidates.map(async (f) => {
      const s = await stat(join(VENDOR_DIR, f));
      return { f, mtimeMs: s.mtimeMs };
    })
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const produced = withMtime[0].f;
  if (produced !== targetName) {
    await rename(join(VENDOR_DIR, produced), targetPath);
  }
  const hash = await sha256(targetPath);
  console.log(`  packed ${name} @ ${version} → vendor/${targetName} (sha256: ${hash.slice(0, 12)}…)`);
  return { name, version, file: targetName, sha256: hash };
}

async function main() {
  if (!existsSync(LITE_PATH)) {
    console.error(`✗ Lite checkout not found at ${LITE_PATH}`);
    console.error(`  Hint: clone SlideStageLite next to SlideStagePro, or pass --lite-path.`);
    process.exit(1);
  }

  console.log(`sync-vendor: Lite = ${LITE_PATH}`);
  await ensureDir(VENDOR_DIR);

  // Make sure Lite dependencies are resolved so `pnpm pack` can read its workspace deps.
  if (!DRY_RUN) {
    if (!existsSync(join(LITE_PATH, "node_modules"))) {
      console.log("  (Lite node_modules missing — running `pnpm install` in Lite)");
      await exec("pnpm", ["install", "--frozen-lockfile"], { cwd: LITE_PATH });
    }
  }

  const liteCommit = await getLiteHeadCommit();
  console.log(`  Lite HEAD: ${liteCommit}`);

  const entries = [];
  for (const pkg of PACKAGES) {
    entries.push(await packOne(pkg));
  }

  if (!DRY_RUN) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      liteCommit,
      litePath: LITE_PATH,
      packages: entries,
    };
    await writeFile(join(VENDOR_DIR, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`  wrote vendor/MANIFEST.json`);
  }

  console.log("✓ sync-vendor done");
}

main().catch((err) => {
  console.error("✗ sync-vendor failed:", err.message ?? err);
  if (err.stderr) console.error(err.stderr);
  if (err.stdout) console.error(err.stdout);
  process.exit(1);
});
