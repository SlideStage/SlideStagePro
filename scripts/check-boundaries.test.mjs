#!/usr/bin/env node
// Self-test for scripts/check-boundaries.mjs.
//
// The boundary checker is the single most important CI gate in this repo
// (it prevents Pro from quietly absorbing Lite source). If the checker
// regresses to "passes everything", every other test goes silent. This
// script proves the checker *fails* on every violating pattern we care
// about, by writing tiny synthetic violators into a throwaway directory,
// pointing the checker at it via a small wrapper, and asserting non-zero
// exit + the expected `[rule]` token in stderr.
//
// Strategy: rather than spawning the real `check-boundaries.mjs` against the
// repo root (which would pass), we import its module-level building blocks
// to re-scan a temporary fixtures directory. The checker itself doesn't
// export those internals today, so we use a different reliable approach:
// run the checker as a subprocess with a wrapper file that sets process.cwd
// or, more simply, write violator files into a path-ignored area and verify
// the checker reports them.
//
// Implementation:
//   1. Create tmp dir `scripts/.boundaries-fixtures/` with violator files.
//   2. Patch a copy of the boundary script to scan that dir instead.
//   3. Run the patched script; assert exit 1 + every expected rule in output.
//   4. Always clean up tmp dir.

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = join(REPO_ROOT, "scripts");
const TMP_ROOT = join(SCRIPTS, ".boundaries-fixtures");
const TMP_SCAN_DIRS = ["apps/api", "apps/web", "packages/pro-preset", "package.json"];

const CASES = [
  {
    name: "lite-source-path-in-package-json",
    file: "apps/api/package.json",
    content: JSON.stringify({
      name: "violator-api",
      dependencies: {
        "@slidestage/core": "file:../SlideStageLite/packages/core",
      },
    }, null, 2),
    expectRule: "lite-source-pkg-ref",
  },
  {
    name: "non-vendor-file-ref",
    file: "packages/pro-preset/package.json",
    content: JSON.stringify({
      name: "violator-preset",
      dependencies: {
        "@slidestage/core": "file:./local/core",
      },
    }, null, 2),
    expectRule: "non-vendor-file-ref",
  },
  {
    // Phase A.A4: vendor/ tarballs are no longer allowed either. ANY file:
    // reference fails. Without this case the regression would be silent.
    name: "vendor-tarball-now-banned",
    file: "apps/web/package.json",
    content: JSON.stringify({
      name: "violator-web",
      dependencies: {
        "@slidestage/core": "file:../../vendor/slidestage-core-0.1.0.tgz",
      },
    }, null, 2),
    expectRule: "non-vendor-file-ref",
  },
  {
    name: "lite-relative-import",
    file: "apps/api/src/forbidden.ts",
    content: `import { foo } from "../../../SlideStageLite/packages/core/src/index.js";\nexport {};\n`,
    expectRule: "lite-relative-import",
  },
  {
    name: "edition-flag-env",
    file: "apps/web/src/edition.ts",
    content: `const ed = import.meta.env.VITE_APP_EDITION;\nexport { ed };\n`,
    expectRule: "edition-flag-env",
  },
  {
    name: "edition-flag-identifier",
    file: "apps/web/src/proGate.ts",
    content: `export const isPro = true;\nif (isPro) {}\n`,
    expectRule: "edition-flag-identifier",
  },
  {
    name: "api-must-not-import-react",
    file: "apps/api/src/badUi.ts",
    content: `import { useState } from "react";\nexport {};\n`,
    expectRule: "api-must-not-import-react",
  },
  {
    name: "web-must-not-import-server-only",
    file: "apps/web/src/badServer.ts",
    content: `import { PrismaClient } from "@prisma/client";\nexport {};\n`,
    expectRule: "web-must-not-import-server-only",
  },
  {
    name: "reimpl-manifest-schema",
    file: "apps/api/src/badSchema.ts",
    content: `import { z } from "zod";\nexport const manifestSchema = z.object({ title: z.string() });\n`,
    expectRule: "reimpl-manifest-schema",
  },
  {
    name: "reimpl-path-safety",
    file: "apps/api/src/badPath.ts",
    content: `export function assertSafePath(p: string) { return p; }\n`,
    expectRule: "reimpl-path-safety",
  },
];

async function setupTmpRoot() {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  for (const c of CASES) {
    const dest = join(TMP_ROOT, c.file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, c.content);
  }
}

async function buildTestRunner() {
  // Read the real checker source and patch two constants so it scans TMP_ROOT.
  const real = await readFile(join(SCRIPTS, "check-boundaries.mjs"), "utf8");
  const patched = real
    .replace(
      'const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));',
      `const REPO_ROOT = ${JSON.stringify(TMP_ROOT)};`,
    )
    .replace(
      'const SCAN_DIRS = ["apps", "packages", "scripts", "infra", "prisma", "docs"];',
      `const SCAN_DIRS = ${JSON.stringify(["apps", "packages"])};`,
    );
  const runner = join(TMP_ROOT, "_runner.mjs");
  await writeFile(runner, patched);
  return runner;
}

function runRunner(runner) {
  const result = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    env: process.env,
  });
  return result;
}

async function main() {
  await setupTmpRoot();
  const runner = await buildTestRunner();

  const res = runRunner(runner);
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const output = stdout + "\n" + stderr;

  let failed = false;
  const report = [];

  if (res.status === 0) {
    failed = true;
    report.push("✗ checker exited 0 on violating fixtures — expected non-zero");
  } else {
    report.push(`✓ checker exited with status ${res.status} (non-zero, as expected)`);
  }

  for (const c of CASES) {
    if (output.includes(`[${c.expectRule}]`)) {
      report.push(`✓ rule fired:   [${c.expectRule}]   (case: ${c.name})`);
    } else {
      failed = true;
      report.push(`✗ rule MISSING: [${c.expectRule}]   (case: ${c.name})`);
    }
  }

  for (const line of report) console.log(line);

  if (failed) {
    console.error("\n--- checker output for debugging ---");
    console.error(output);
    await rm(TMP_ROOT, { recursive: true, force: true });
    process.exit(1);
  }
  await rm(TMP_ROOT, { recursive: true, force: true });
  console.log("\n✓ check-boundaries self-test passed");
}

main().catch(async (err) => {
  console.error("✗ self-test crashed:", err);
  await rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(2);
});
