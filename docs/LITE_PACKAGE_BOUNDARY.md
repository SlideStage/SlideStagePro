# Lite ↔ Pro Package Boundary

> Companion: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`README.md`](../README.md),
> `.cursor/rules/lite-package-boundary.mdc`.

This document is the **rules of engagement** between SlideStage Pro (this
repo) and the upstream SlideStage Lite open-source runtime. The boundary is
enforced mechanically by `scripts/check-boundaries.mjs`, but the reasoning
below is what makes the rule list defensible when the rule list itself is
debated.

## 1. Why a boundary at all

SlideStage Lite is the canonical, open-source `.stage` runtime. It must be
runnable as a pure-frontend bundle (no server), publishable to npm, and
welcoming to outside contributors. SlideStage Pro is the multi-user host:
it stores `.stage` blobs, brokers identity, exposes a Hono API, runs
Prisma+SQLite on a VPS.

If Pro freely forked, patched, or `file:`-imported Lite source, three bad
things happen:

1. **Compatibility drift** — Pro's "improved" `manifestSchema` diverges from
   Lite's, every `.stage` file produced by Pro fails Lite validation, the
   community ecosystem fragments.
2. **Diverging patches** — Pro-side changes to Lite source can never
   round-trip back to Lite without major surgery, and the longer they sit
   downstream the wider the gap grows.
3. **Edition cancer** — `isPro` / `VITE_APP_EDITION` checkpoints sprinkle
   across the codebase, every refactor needs to ask "but does Pro do
   this?", and Lite contributors learn to fear the diff.

The boundary makes the rule explicit: **Pro consumes Lite as a published
package; Lite never knows Pro exists.**

## 2. The rules (mechanically enforced)

Run `node scripts/check-boundaries.mjs`; it must exit 0 on every commit.

| # | Rule | What it catches |
|---|---|---|
| 1 | No `file:../SlideStageLite` / `link:../SlideStageLite` in any `package.json` dependency field | Direct source-tree dependency |
| 2 | No `import` / `require` of `"../SlideStageLite/..."` in any code file | Direct source-tree import |
| 3 | No `VITE_APP_EDITION` env var anywhere | Edition branching |
| 4 | No bare identifier `isPro` anywhere | Edition branching by identifier |
| 5 | `apps/api/**` may not `import` `react` / `react-dom` / `react/*` / `react-dom/*` | Server importing a UI lib |
| 6 | `apps/web/**` may not `import` `@prisma/client`, `prisma`, `fastify`, `hono`, `hono/*`, `node:fs`, `node:fs/promises`, `node:net`, `better-sqlite3`, or relative paths into `apps/api/` | Browser importing server modules |
| 7 | No re-declaration of `manifestSchema` / `SlideStageManifestSchema` / `assertSafePath` / `assertSafeRelPath` / `isSafePath` (the symbols owned by `@slidestage/core`) | Re-implementing Lite primitives |
| 8 | No `file:` dependency permitted in any `package.json` (`workspace:*` is fine for first-party Pro packages) | Local-path / vendored / patched-fork references |

Forbidden literals only fire inside code, manifests, and CI scripts —
docs are exempt so this very document is allowed to spell out the words.

## 3. What Pro is allowed to do

- `import` anything from `@slidestage/core`, `@slidestage/ui`,
  `@slidestage/lite-preset`, `@slidestage/brand`, and (where Pro needs the
  `.stage` format types) `@slidestage/spec` (declared as semver dependencies
  — see §4).
- Read the **published API** (the `exports` map in each Lite package).
- Read Lite source files **on disk** for understanding (`Read` /
  `Glob` / Grep tools), as long as no `import` ever crosses the boundary.
- Reuse Lite's runtime helpers (`loadDeck`, `manifestSchema`, `pathSafety`,
  `trustCapabilities`, the entire `converter/`) through these imports.
- Write **Pro-only** capabilities under `packages/pro-preset/`, install them
  via the `proPreset()` plugin contract that `@slidestage/core` defines.
- Mirror `@slidestage/brand`'s SVG / PNG `assets/` tree into a `.gitignore`'d
  location (e.g. `apps/web/public/brand/`) via a `sync:brand` prebuild step.
  Do **not** commit duplicates of those bytes — the npm package is the
  source of truth.

## 4. Dependency mode: npm semver only (current)

As of Phase A.A4 (2026-05-26), Pro consumes Lite **strictly by semver from
the public npm registry**. The previous `vendor/*.tgz` v0 bridge has been
removed entirely:

```jsonc
// every Pro package.json that needs a Lite package
"dependencies": {
  "@slidestage/core":        "^0.1.1",
  "@slidestage/ui":          "^0.1.1",
  "@slidestage/lite-preset": "^0.1.1",
  // Optional, by surface area:
  "@slidestage/brand":       "^0.1.0",   // marks/wordmarks/favicons/tokens
  "@slidestage/spec":        "^0.1.0"    // .stage format types (when needed)
}
```

The boundary checker now rejects **every** `file:` reference in **any**
`package.json` dependency field. `pnpm-workspace.yaml` carries no overrides
mapping Lite names to local files. `vendor/`, `scripts/sync-vendor.mjs`,
and `vendor/README.md` were deleted in the same change.

If a Lite bug blocks Pro mid-release, see §6 FAQ "What if I find a bug in
`@slidestage/core` that's blocking Pro?" for the pnpm overrides escape
hatch — but the override **must** point at a re-packed upstream tarball
located outside this repo, and must be removed when the upstream patch
ships.

### Historical context (kept for reference)

Between v0 boot (commit `5418004`, Lite `0.1.0`) and Phase A.A4
(2026-05-26), Pro depended on Lite via committed `vendor/*.tgz` files:
`pnpm pack`'d from a sibling SlideStageLite checkout, listed in each
`package.json` as `file:../../vendor/slidestage-<name>-0.1.0.tgz`,
synced by `pnpm sync:vendor` → `scripts/sync-vendor.mjs`, and pinned via
a `pnpm-workspace.yaml > overrides:` block. The boundary checker
whitelisted `file:./vendor/*.tgz` and rejected every other `file:` ref.
That whole bridge is gone now; the npm pull replaces it 1:1.

## 5. Exit criteria — completed

| # | Step | Status |
|---|---|---|
| 1 | Lite packages published to npm registry | ✅ done (`0.1.1`) |
| 2 | Pro `package.json` switched to `^0.1.1` semver | ✅ done (Phase A.A3) |
| 3 | `pnpm-workspace.yaml > overrides:` block removed | ✅ done (Phase A.A3) |
| 4 | `pnpm install` regenerates lockfile against npm | ✅ done (Phase A.A3) |
| 5 | `vendor/` + `scripts/sync-vendor.mjs` + `vendor/README.md` deleted | ✅ done (Phase A.A4) |
| 6 | `check-boundaries.mjs` tightened to reject all `file:` refs | ✅ done (Phase A.A4) |
| 7 | CI passes with tightened checker | 🟡 next: Phase A.A5 + Phase A.A6 |
| 8 | This document's §4 reflects npm-only state | ✅ done (this commit) |

## 6. FAQ

**Q. Can I just symlink `../SlideStageLite/packages/core` into
`node_modules/@slidestage/core` for local development?**

No. `pnpm link` / `yalc` / symlink-by-hand are allowed as *developer setup
that never lands in git*: don't commit symlinks, don't commit a
`package.json` that points at the symlink, don't write any `import`
that resolves through such a link. The committed state must always pass
`check:boundaries`.

**Q. I need a tiny Pro-only tweak to `loadDeck`. Can I copy the function and
modify it?**

No. Either:
- Open a PR upstream that adds the hook you need (preferred), or
- Subscribe to a hook Lite already exposes (capabilities, trust prompt,
  manifest extension), or
- If you really need post-processing, do it *after* `loadDeck` returns —
  don't re-implement what the function already does.

**Q. What if I find a bug in `@slidestage/core` that's blocking Pro?**

File the bug upstream. While waiting for the next npm release, you can
substitute a patched build via `pnpm.overrides` in `package.json`:

```jsonc
"pnpm": {
  "overrides": {
    "@slidestage/core": "file:/abs/path/to/slidestage-core-patched.tgz"
  }
}
```

The patched tarball must be re-packed from a fork of SlideStageLite that
sits **outside this repo** (the boundary checker rejects every `file:`
reference inside Pro's own `package.json` files, and CI will catch a
checked-in override). Remove the override when the upstream patch ships
to npm. Never patch the dependency in `node_modules`.

**Q. Does the boundary apply to test fixtures and docs?**

Tests: yes. A test file importing from `"../SlideStageLite/..."` is just as
forbidden as production code.

Docs: no. This document and `ARCHITECTURE.md` must be able to quote the
forbidden patterns to teach the rule. `scripts/check-boundaries.mjs` skips
the `docs/` prefix for that reason.
