#!/usr/bin/env node
// Two-part install fixup that makes Prisma cooperate with pnpm workspaces:
//
//  1. Ensures `prisma` and `@prisma/client` are reachable from the repo root
//     node_modules/ so `prisma generate --schema=../../prisma/schema.prisma`
//     can resolve them (Prisma walks up from the schema dir, never sees the
//     `apps/api/node_modules/` copy).
//
//  2. After `prisma generate` writes the generated client to
//     `<repo>/node_modules/.prisma/client` (per the schema's `output`),
//     pnpm's @prisma/client package keeps re-exporting from a stale stub at
//     `node_modules/.pnpm/@prisma+client@.../node_modules/.prisma/client`.
//     We replace that stub with a symlink to the freshly-generated client so
//     TypeScript & runtime resolution both find the real models.
//
// Idempotent.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "..");
const repoRoot = resolve(apiDir, "..", "..");
const rootNm = join(repoRoot, "node_modules");
const apiNm = join(apiDir, "node_modules");

function link(name) {
  const target = join(apiNm, name);
  const linkPath = join(rootNm, name);
  if (!existsSync(target)) {
    console.warn(`[ensure-root-symlinks] target missing: ${target}`);
    return;
  }
  try {
    if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink()) return;
      return; // don't overwrite real dirs (e.g. when run outside isolated mode)
    }
  } catch {
    // ENOENT — proceed to create
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, "dir");
  console.log(`[ensure-root-symlinks] linked ${name} -> ${target}`);
}

if (!existsSync(rootNm)) {
  mkdirSync(rootNm, { recursive: true });
}
if (!existsSync(join(rootNm, "@prisma"))) {
  mkdirSync(join(rootNm, "@prisma"), { recursive: true });
}

link("prisma");
// @prisma is a scope dir; link individual packages instead of the whole scope
// to avoid clashing with other hoisted @prisma/* packages.
for (const pkg of ["client", "engines"]) {
  const target = join(apiNm, "@prisma", pkg);
  const linkPath = join(rootNm, "@prisma", pkg);
  if (!existsSync(target)) continue;
  try {
    if (lstatSync(linkPath, { throwIfNoEntry: false })) {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink()) continue;
      continue;
    }
  } catch {
    /* missing */
  }
  symlinkSync(target, linkPath, "dir");
  console.log(`[ensure-root-symlinks] linked @prisma/${pkg} -> ${target}`);
}

// Step 2: redirect every .pnpm copy of `.prisma/client` to the real generated
// client at <repo>/node_modules/.prisma/client (if it exists yet). The Prisma
// CLI writes there on generate; without this redirect the @prisma/client
// package re-exports from an empty stub and `import { Deck } from
// "@prisma/client"` resolves to a type-free namespace.
const realPrismaClient = join(rootNm, ".prisma", "client");
if (existsSync(realPrismaClient)) {
  const pnpmDir = join(rootNm, ".pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith("@prisma+client@")) continue;
      const stubDir = join(pnpmDir, entry, "node_modules", ".prisma", "client");
      const stubParent = dirname(stubDir);
      if (!existsSync(stubParent)) continue;
      let stat;
      try {
        stat = lstatSync(stubDir);
      } catch {
        stat = null;
      }
      // If already correctly symlinked, skip.
      if (stat?.isSymbolicLink()) continue;
      // Replace the stub directory with a symlink.
      if (stat) {
        rmSync(stubDir, { recursive: true, force: true });
      }
      symlinkSync(realPrismaClient, stubDir, "dir");
      console.log(
        `[ensure-root-symlinks] redirected ${stubDir} -> ${realPrismaClient}`,
      );
    }
  }
}
