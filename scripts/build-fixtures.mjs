#!/usr/bin/env node
// Generate canonical fixture .stage files for manual smoke-testing,
// end-to-end demos, and Docker compose verification. Tests inline their
// own fixtures via `fflate`; this script is for the dev/QA workflow:
//
//   pnpm fixtures
//   # then: drag fixtures/valid-deck.stage into the upload page
//
// Usage:
//   node scripts/build-fixtures.mjs            # write all fixtures
//   node scripts/build-fixtures.mjs --check    # exit non-zero if any fixture is missing
//   node scripts/build-fixtures.mjs --clean    # remove fixtures/ first

import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(REPO_ROOT, "fixtures");

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const CLEAN = args.includes("--clean");

const ISO = "2026-01-01T00:00:00.000Z";

/** Build a valid 2-slide deck conforming to slidestage@1.0 manifest. */
function buildValidDeck() {
  const manifest = {
    schema: "slidestage@1.0",
    id: "fixture-valid-001",
    version: "1.0.0",
    title: "Valid Fixture Deck",
    subtitle: "Two minimal slides for smoke testing",
    author: "SlideStage Pro tests",
    description: null,
    createdAt: ISO,
    updatedAt: ISO,
    architecture: "multi-file",
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 2,
    slides: [
      {
        index: 1,
        id: "s1",
        label: "Title",
        file: "slides/01-title.html",
        thumbnail: null,
        notes: "Welcome to the smoke test deck.",
      },
      {
        index: 2,
        id: "s2",
        label: "Outro",
        file: "slides/02-outro.html",
        thumbnail: null,
        notes: null,
      },
    ],
  };
  const slide = (title, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>html,body{height:100%;margin:0;font-family:system-ui;display:grid;` +
    `place-items:center;background:#0f172a;color:#fff;}h1{font-size:64px;}</style>` +
    `</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  const files = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "slides/01-title.html": strToU8(slide("Valid Fixture Deck", "Slide 1")),
    "slides/02-outro.html": strToU8(slide("Thanks!", "Slide 2")),
  };
  return zipSync(files, { mtime: new Date(ISO) });
}

/** Build a deck whose manifest fails zod validation (missing required field). */
function buildInvalidManifestDeck() {
  // Missing 'schema' and 'totalSlides' — manifest schema requires them.
  const broken = { title: "No schema field", id: "x", version: "1.0.0" };
  const files = {
    "manifest.json": strToU8(JSON.stringify(broken)),
    "slides/dummy.html": strToU8("<html></html>"),
  };
  return zipSync(files, { mtime: new Date(ISO) });
}

/** Build a deck containing a path-traversal entry that pathSafety must reject. */
function buildPathTraversalDeck() {
  const manifest = {
    schema: "slidestage@1.0",
    id: "fixture-traversal-001",
    version: "1.0.0",
    title: "Path Traversal Attempt",
    subtitle: null,
    author: null,
    description: null,
    createdAt: ISO,
    updatedAt: ISO,
    architecture: "multi-file",
    dimensions: { width: 1920, height: 1080 },
    totalSlides: 1,
    slides: [
      {
        index: 1,
        id: "s1",
        label: "Decoy",
        file: "../../../etc/passwd",
        thumbnail: null,
        notes: null,
      },
    ],
  };
  const files = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "../../../etc/evil.html": strToU8("malicious"),
  };
  return zipSync(files, { mtime: new Date(ISO) });
}

/** Build a non-zip payload (plain text). */
function buildNonZipPayload() {
  return Buffer.from("This is plainly not a zip archive.\n", "utf8");
}

const FIXTURES_TABLE = [
  { name: "valid-deck.stage", builder: buildValidDeck },
  { name: "invalid-manifest.stage", builder: buildInvalidManifestDeck },
  { name: "path-traversal.stage", builder: buildPathTraversalDeck },
  { name: "not-a-zip.bin", builder: buildNonZipPayload },
];

async function main() {
  if (CHECK_ONLY) {
    const missing = [];
    for (const f of FIXTURES_TABLE) {
      const p = join(FIXTURES, f.name);
      if (!existsSync(p)) missing.push(f.name);
    }
    if (missing.length) {
      console.error("✗ missing fixtures:");
      for (const m of missing) console.error(`  - fixtures/${m}`);
      console.error("  → run `pnpm fixtures` to regenerate");
      process.exit(1);
    }
    console.log(`✓ all ${FIXTURES_TABLE.length} fixtures present`);
    return;
  }

  if (CLEAN && existsSync(FIXTURES)) {
    await rm(FIXTURES, { recursive: true, force: true });
  }
  await mkdir(FIXTURES, { recursive: true });

  for (const { name, builder } of FIXTURES_TABLE) {
    const bytes = builder();
    const out = join(FIXTURES, name);
    await writeFile(out, bytes);
    const size = (await stat(out)).size;
    console.log(`  wrote ${name} (${size} bytes)`);
  }
  console.log(`✓ wrote ${FIXTURES_TABLE.length} fixtures to fixtures/`);
}

main().catch((err) => {
  console.error("✗ build-fixtures failed:", err);
  process.exit(1);
});
