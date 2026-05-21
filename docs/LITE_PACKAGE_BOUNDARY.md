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
runnable as a pure-frontend bundle (no server), publishable to npm under MIT,
and welcoming to outside contributors. SlideStage Pro is the commercial
multi-user host: it stores `.stage` blobs, brokers identity, exposes a Hono
API, runs Prisma+SQLite on a VPS.

If Pro freely forked, patched, or `file:`-imported Lite source, three bad
things happen:

1. **Compatibility drift** — Pro's "improved" `manifestSchema` diverges from
   Lite's, every `.stage` file produced by Pro fails Lite validation, the
   community ecosystem fragments.
2. **License pollution** — Pro patches in this repo are not MIT and can never
   round-trip back to Lite without major surgery.
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
| 8 | Every `file:` dependency in `package.json` must resolve to `vendor/*.tgz` (white-listed) | Non-vendor file references |

Forbidden literals only fire inside code, manifests, and CI scripts —
docs are exempt so this very document is allowed to spell out the words.

## 3. What Pro is allowed to do

- `import` anything from `@slidestage/core`, `@slidestage/ui`,
  `@slidestage/lite-preset` (declared as semver dependencies — see §4).
- Read the **published API** (the `exports` map in each Lite package).
- Read Lite source files **on disk** for understanding (`Read` /
  `Glob` / Grep tools), as long as no `import` ever crosses the boundary.
- Reuse Lite's runtime helpers (`loadDeck`, `manifestSchema`, `pathSafety`,
  `trustCapabilities`, the entire `converter/`) through these imports.
- Write **Pro-only** capabilities under `packages/pro-preset/`, install them
  via the `proPreset()` plugin contract that `@slidestage/core` defines.

## 4. v0 dependency mode: vendored tarballs

The Lite packages are **not yet published** to npm. To unblock v0 deployment
without violating the boundary, Pro depends on Lite via *vendored tarballs*:

```text
SlideStagePro/
  vendor/
    MANIFEST.json                        ← Lite git SHA + per-tarball sha256
    slidestage-core-0.1.0.tgz            ← pnpm pack of …/Lite/packages/core
    slidestage-ui-0.1.0.tgz
    slidestage-lite-preset-0.1.0.tgz
```

In every Pro `package.json`:

```jsonc
"dependencies": {
  "@slidestage/core": "file:../../vendor/slidestage-core-0.1.0.tgz",
  "@slidestage/ui":   "file:../../vendor/slidestage-ui-0.1.0.tgz",
  "@slidestage/lite-preset": "file:../../vendor/slidestage-lite-preset-0.1.0.tgz"
}
```

The boundary checker whitelists `file:` references whose path component
contains `/vendor/` and ends in `.tgz`; anything else fails CI.

### Re-syncing the tarballs

```bash
cd ../SlideStageLite
pnpm -r --filter "./packages/*" build       # produce dist/

cd ../SlideStagePro
pnpm sync:vendor                            # runs scripts/sync-vendor.mjs
```

The sync script:

1. verifies `vendor/` exists, creates it if not;
2. for each of `@slidestage/core`, `@slidestage/ui`, `@slidestage/lite-preset`:
   - confirms `…/packages/<name>/dist` exists (else fails with a hint);
   - runs `pnpm pack --pack-destination vendor/`;
   - renames the output to `slidestage-<name>-<version>.tgz`;
3. writes `vendor/MANIFEST.json` with the Lite git SHA and per-file sha256.

`MANIFEST.json` is committed alongside the tarballs so reviewers can verify
*which* upstream commit was packaged without re-running the sync.

## 5. Exit criteria: switch to npm semver

When the Lite packages are published to a registry Pro can reach:

1. Pick a published Lite version, e.g. `@slidestage/core@0.2.0`.
2. In every Pro `package.json`, replace
   `"file:../../vendor/slidestage-core-0.1.0.tgz"` with `"^0.2.0"` (and same
   for `ui` / `lite-preset`).
3. Update `pnpm-workspace.yaml` to **remove** the `overrides:` block that
   pins these names to `file:./vendor/...`.
4. `pnpm install` to regenerate `pnpm-lock.yaml`.
5. Delete `vendor/`, `scripts/sync-vendor.mjs`, and `vendor/README.md`.
6. In `scripts/check-boundaries.mjs`, tighten the rule:
   ```js
   const ALLOW_VENDORED_TARBALL = /^$/; // reject every file: reference outright
   ```
7. CI must pass with the tightened checker before merging.
8. Update this document's §4 to say "v0 vendoring is removed; semver only".

After that, the boundary is purely an `npm` boundary: Lite is a third-party
dependency of Pro, full stop.

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

File the bug upstream. While waiting for a release, `pnpm overrides` in
`pnpm-workspace.yaml` (already used for the vendor pinning) can substitute a
patched tarball under the same name — but that tarball must come from the
Lite repo (re-pack with `sync-vendor.mjs`) and the override must be removed
when the upstream fix ships. Never patch the dependency in `node_modules`.

**Q. Does the boundary apply to test fixtures and docs?**

Tests: yes. A test file importing from `"../SlideStageLite/..."` is just as
forbidden as production code.

Docs: no. This document and `ARCHITECTURE.md` must be able to quote the
forbidden patterns to teach the rule. `scripts/check-boundaries.mjs` skips
the `docs/` prefix for that reason.
