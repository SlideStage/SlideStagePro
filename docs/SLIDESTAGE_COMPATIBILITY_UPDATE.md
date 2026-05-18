# slidestage Compatibility Update (Pro)

## Goal

Keep `.stage` packages compatible across **Lite, Pro, and future players** by
preserving the standard `slidestage@1.0` manifest contract while still letting
producers / converters record where a deck came from and what runtime
capabilities its slides expect.

This Pro change set mirrors the equivalent Lite update
(`SlideStageLite/docs/SLIDESTAGE_COMPATIBILITY_UPDATE.md`) so the two players
converge on a single contract.

## What changed in Pro

- **`provenance` is now part of the manifest schema** (optional, validated).
  `packages/shared/src/manifest.ts → provenanceSchema` captures
  `sourceKind` / `conversionMode` / `sourceEntry` / `converter`. The server
  persists it verbatim and exposes it on `/api/decks/:id`.
- **`compat` is now part of the manifest schema** (optional, validated +
  normalized).
  - `compat.requires` accepts `string[]`. The shared
    `normalizeTrustCapabilities` helper filters to the known
    `TrustCapability` enum (`same-origin-storage`, `broadcast-channel`,
    `window-open`), de-duplicates, and sorts.
  - Unknown capabilities are dropped at parse time — packages aren't rejected
    for forward-compat reasons.
- **iframe sandbox is now per-deck** (`apps/web/src/utils/iframeSandbox.ts`).
  Live slides start from the historic `allow-scripts` baseline and add tokens
  based on the normalized `compat.requires`:

  | `compat.requires` item | Added sandbox token(s) |
  |---|---|
  | `same-origin-storage` | `allow-same-origin` |
  | `broadcast-channel`   | `allow-same-origin` |
  | `window-open`         | `allow-popups allow-popups-to-escape-sandbox` |

  `DeckStage` consumes a new optional `sandbox` prop. `DeckViewerPage`,
  `PresenterViewPage`, and `AudienceViewPage` all pass the manifest-derived
  value. The `noScripts` mini previews used inside `Overview` and the
  presenter "up next" thumbnail keep their fully-empty sandbox.
- **Docs aligned with the spec.** `docs/slidestage-platform-spec.md` gained
  §3.8 (optional extension contract), §3.9 (`provenance`), §3.10 (`compat`),
  and an updated §6.3 sandbox table. `docs/ARCHITECTURE.md` references the
  new helper and the manifest-driven sandbox elevation.
- **Server tests** in `apps/server/tests/upload.test.ts` now lock in
  end-to-end behavior: upload → list → detail preserves `provenance` and
  normalizes `compat.requires`.
- **Web e2e** at `apps/web/tests/e2e/compat-sandbox.spec.ts` builds a deck
  with `compat.requires` containing duplicates + an unknown capability,
  uploads it, opens the viewer, and asserts the live iframe carries the
  elevated sandbox token set.

## Migration notes

- Existing `.stage` packages keep working unchanged — both new fields are
  optional, both default to "no extra capability requested".
- Decks coming from the Lite converter (Lite wrap mode now emits
  `provenance.sourceKind = "webcomponent-deck"` etc.) are surfaced 1:1 in
  Pro's API responses; clients can lean on `provenance.sourceKind` for
  diagnostics but should never make rendering decisions from it.
- `architecture` is unchanged: still strictly one of the four
  `slidestage@1.0` enum values — Lite-specific source kinds live exclusively
  in `provenance`.

## Verification

Recommended verification after touching this area:

```bash
# from SlideStagePro
pnpm --filter @slidestage/shared build
pnpm --filter @slidestage/server test
pnpm --filter @slidestage/server build
pnpm --filter @slidestage/web build

# e2e (requires fixtures; see apps/web/README.md):
pnpm --filter @slidestage/web exec playwright test compat-sandbox
```

Inspecting a converted package after upload, expect:

- `manifest.architecture` ∈ `{multi-file, multi-file-flat,
  single-file-deckstage, single-file-html}`.
- `manifest.provenance.sourceKind` carries the original detected shape
  (only present when the converter set it).
- `manifest.compat.requires` is sorted and contains only known
  `TrustCapability` values.
- The live `<iframe sandbox>` attribute reflects the manifest:
  - default → `allow-scripts`
  - `same-origin-storage` → adds `allow-same-origin`
  - `window-open` → adds `allow-popups allow-popups-to-escape-sandbox`
