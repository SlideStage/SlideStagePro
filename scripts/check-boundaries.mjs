#!/usr/bin/env node
// SlideStage Pro — Lite package boundary checker.
//
// Enforces the rules in .cursor/rules/lite-package-boundary.mdc:
//   1. Pro must NOT depend on the SlideStageLite checkout via file:/link:/path imports.
//   2. Pro must NOT import Lite source from "../SlideStageLite/...".
//   3. Pro must NOT copy manifest schema / pathSafety / loadDeck logic — always use
//      @slidestage/core.
//   4. Pro must NOT branch on edition ("isPro" / "VITE_APP_EDITION").
//   5. apps/api MUST NOT import "react" / "react-dom".
//   6. apps/web MUST NOT import server-only modules ("prisma", local db/storage).
//
// As of Phase A.A4 (2026-05-26) the vendor/ bridge is removed: Lite packages
// come from npm by semver only. Any `file:` reference in any package.json
// dependency field is now an outright violation. See docs/LITE_PACKAGE_BOUNDARY.md.
//
// Exit codes:
//   0 — all checks passed
//   1 — at least one violation
//
// Usage:
//   node scripts/check-boundaries.mjs
//   node scripts/check-boundaries.mjs --json   (machine-readable output)

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");

/** @typedef {{ file: string, line: number, col: number, rule: string, snippet: string }} Violation */

const SCAN_DIRS = ["apps", "packages", "scripts", "infra", "prisma", "docs"];
const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".prisma",
  ".sh",
]);

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".pnpm-store",
  "coverage",
  "test-results",
  "playwright-report",
  "e2e-storage",
  ".git",
]);

const IGNORE_PATH_SUBSTRINGS = [
  // The boundary checker itself contains literal violating strings as data.
  "scripts/check-boundaries.mjs",
  // The boundary checker's own test fixture file literally writes invalid
  // imports as test inputs to prove the checker catches them.
  "scripts/check-boundaries.test.mjs",
  // Docs are reference material that must be able to QUOTE forbidden strings
  // as bad-examples ("don't do this") without tripping the checker. The
  // boundary rules apply to *code*, not to prose explaining the rules.
  "docs/",
  ".cursor/rules/",
];

/**
 * Forbidden literal substrings that must NEVER appear in any scanned file.
 * Each rule lists the offending pattern and a human-readable reason.
 */
const FORBIDDEN_LITERALS = [
  {
    rule: "lite-source-path",
    pattern: /file:\.\.\/SlideStageLite/g,
    reason: "Must not depend on Lite via file:../SlideStageLite (use vendored tarball or npm semver).",
  },
  {
    rule: "lite-link-path",
    pattern: /link:\.\.\/SlideStageLite/g,
    reason: "Must not link the Lite checkout (use vendored tarball or npm semver).",
  },
  {
    rule: "lite-relative-import",
    pattern: /from\s+["'](?:\.\.\/)+SlideStageLite\//g,
    reason: "Must not import Lite source via relative path (use @slidestage/* package).",
  },
  {
    rule: "lite-require-path",
    pattern: /require\(\s*["'](?:\.\.\/)+SlideStageLite\//g,
    reason: "Must not require Lite source via relative path.",
  },
  {
    rule: "edition-flag-env",
    pattern: /VITE_APP_EDITION/g,
    reason: "Edition branching is forbidden (one product, one runtime).",
  },
  {
    rule: "edition-flag-identifier",
    pattern: /\bisPro\b/g,
    reason: "Edition branching is forbidden; gate features via plugin presence instead.",
  },
];

/**
 * Per-package directory bans: imports that must NOT appear inside the given prefix.
 */
const DIR_IMPORT_BANS = [
  {
    rule: "api-must-not-import-react",
    dir: "apps/api/",
    patterns: [
      /from\s+["']react["']/g,
      /from\s+["']react-dom["']/g,
      /from\s+["']react\//g,
      /from\s+["']react-dom\//g,
    ],
    reason: "apps/api is a Node server and must not import react / react-dom.",
  },
  {
    rule: "web-must-not-import-server-only",
    dir: "apps/web/",
    patterns: [
      /from\s+["']@prisma\/client["']/g,
      /from\s+["']prisma["']/g,
      /from\s+["']fastify["']/g,
      /from\s+["']hono["']/g,
      /from\s+["']hono\/.*?["']/g,
      /from\s+["']node:fs["']/g,
      /from\s+["']node:fs\/promises["']/g,
      /from\s+["']node:net["']/g,
      /from\s+["']better-sqlite3["']/g,
      /from\s+["']\.\.\/\.\.\/api\//g,
    ],
    reason: "apps/web is browser-only and must not import server modules.",
  },
];

/**
 * Manifest schema reimplementation watch — Pro must always import these
 * from @slidestage/core, never reimplement.
 */
const CORE_REIMPL_PATTERNS = [
  {
    rule: "reimpl-manifest-schema",
    // matches things like `const manifestSchema = z.object(` or `export const SlideStageManifestSchema = ...`
    pattern: /\b(?:export\s+)?const\s+(?:manifest(?:Schema)?|slideStageManifest(?:Schema)?|SlideStageManifestSchema)\s*=\s*z\./gi,
    reason: "Manifest schema must come from @slidestage/core/deck/manifestSchema, do not re-declare.",
  },
  {
    rule: "reimpl-path-safety",
    pattern: /\b(?:export\s+)?function\s+(?:assertSafe(?:Path|RelPath)|isSafePath)\s*\(/g,
    reason: "Path-safety helpers must come from @slidestage/core/deck/pathSafety, do not re-implement.",
  },
];

/**
 * Vendor allow-list is empty after Phase A.A4 (2026-05-26).
 * Any `file:` reference in any package.json dependency field is now a
 * violation. Lite packages must come from npm by semver (`^0.1.1` etc).
 * The regex below never matches any input.
 */
const ALLOW_VENDORED_TARBALL = /^$/;

async function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function shouldScan(filePath) {
  const rel = relative(REPO_ROOT, filePath);
  if (IGNORE_PATH_SUBSTRINGS.some((s) => rel.includes(s))) return false;
  const ext = "." + (rel.split(".").pop() ?? "");
  return SCAN_EXTENSIONS.has(ext);
}

function findOccurrences(content, regex) {
  const out = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(content)) !== null) {
    out.push({ index: m.index, match: m[0] });
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return out;
}

function lineColAt(content, index) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

async function checkPackageJsonLiteRefs(filePath, content) {
  /** @type {Violation[]} */
  const violations = [];
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return violations;
  }
  const depFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const field of depFields) {
    const deps = parsed[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string") continue;
      // Bare path references to Lite checkout
      if (/^(file|link):\.\.\/SlideStageLite/.test(version)) {
        violations.push({
          file: relative(REPO_ROOT, filePath),
          line: 1,
          col: 1,
          rule: "lite-source-pkg-ref",
          snippet: `"${name}": "${version}"`,
        });
      }
      // file:* references must be inside vendor/
      if (/^file:/.test(version) && !ALLOW_VENDORED_TARBALL.test(version)) {
        violations.push({
          file: relative(REPO_ROOT, filePath),
          line: 1,
          col: 1,
          rule: "non-vendor-file-ref",
          snippet: `"${name}": "${version}" — only file:./vendor/*.tgz is allowed`,
        });
      }
    }
  }
  return violations;
}

async function scanFile(filePath) {
  const rel = relative(REPO_ROOT, filePath);
  /** @type {Violation[]} */
  const violations = [];
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return violations;
  }

  // 1. Forbidden literals (file:../SlideStageLite, isPro, VITE_APP_EDITION, ...)
  for (const rule of FORBIDDEN_LITERALS) {
    for (const occ of findOccurrences(content, rule.pattern)) {
      const { line, col } = lineColAt(content, occ.index);
      violations.push({
        file: rel,
        line,
        col,
        rule: rule.rule,
        snippet: `${occ.match} — ${rule.reason}`,
      });
    }
  }

  // 2. Directory-scoped import bans
  for (const ban of DIR_IMPORT_BANS) {
    if (!rel.startsWith(ban.dir)) continue;
    for (const p of ban.patterns) {
      for (const occ of findOccurrences(content, p)) {
        const { line, col } = lineColAt(content, occ.index);
        violations.push({
          file: rel,
          line,
          col,
          rule: ban.rule,
          snippet: `${occ.match.trim()} — ${ban.reason}`,
        });
      }
    }
  }

  // 3. Re-implementation of core
  for (const r of CORE_REIMPL_PATTERNS) {
    // Allow re-impl only inside Lite vendor source, which doesn't live in Pro.
    for (const occ of findOccurrences(content, r.pattern)) {
      const { line, col } = lineColAt(content, occ.index);
      violations.push({
        file: rel,
        line,
        col,
        rule: r.rule,
        snippet: `${occ.match.trim()} — ${r.reason}`,
      });
    }
  }

  // 4. package.json dependency rules
  if (rel.endsWith("package.json")) {
    violations.push(...(await checkPackageJsonLiteRefs(filePath, content)));
  }

  return violations;
}

async function main() {
  /** @type {Violation[]} */
  const all = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    const files = await walk(abs);
    for (const file of files) {
      if (!shouldScan(file)) continue;
      const v = await scanFile(file);
      if (v.length) all.push(...v);
    }
  }

  // Also scan the root package.json for the same dependency rules.
  const rootPkg = join(REPO_ROOT, "package.json");
  if (existsSync(rootPkg)) {
    const content = await readFile(rootPkg, "utf8");
    all.push(...(await checkPackageJsonLiteRefs(rootPkg, content)));
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify({ ok: all.length === 0, violations: all }, null, 2) + "\n");
  } else if (all.length === 0) {
    console.log("✓ check-boundaries: 0 violations");
  } else {
    console.error(`✗ check-boundaries: ${all.length} violation(s)`);
    for (const v of all) {
      console.error(`  ${v.file}:${v.line}:${v.col}  [${v.rule}]  ${v.snippet}`);
    }
  }

  process.exit(all.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("check-boundaries crashed:", err);
  process.exit(2);
});
