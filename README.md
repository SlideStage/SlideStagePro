<p align="center">
  <a href="https://github.com/SlideStage/SlideStagePro">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="brand/png/slidestage-pro-logo-horizontal-on-dark@2x.png">
      <img src="brand/png/slidestage-pro-logo-horizontal@2x.png" alt="SlideStage Pro" width="520">
    </picture>
  </a>
</p>

<p align="center">
  <strong>Self-hosted <code>.stage</code> deck platform for teams.</strong><br/>
  Shared library · notes &amp; annotations · admin invites · Docker-deployable.
</p>

<p align="center">
  <a href="https://slidestage.dev"><img alt="Website" src="https://img.shields.io/badge/website-slidestage.dev-4F46E5?style=flat-square"></a>
  <a href="https://github.com/SlideStage/SlideStageLite"><img alt="Lite" src="https://img.shields.io/badge/sibling-SlideStageLite-06B6D4?style=flat-square"></a>
</p>

---

# SlideStage Pro

Self-hosted `.stage` presentation platform built on **Prisma + SQLite + Hono +
React 19**, deployable to any VPS via Docker Compose. Pro is a thin shell around
the Lite open-source packages (`@slidestage/core`, `@slidestage/ui`,
`@slidestage/lite-preset`) — it adds multi-user storage, notes/annotations
persistence, admin invites, and Docker-based deployment.

### SlideStage ecosystem

<table>
  <tr>
    <td align="center" width="33%">
      <a href="https://github.com/SlideStage/SlideStageLite"><img src="brand/png/slidestage-mark.png" width="84" alt="SlideStageLite"></a><br/>
      <strong>SlideStageLite</strong><br/>
      <sub>Local-first runtime</sub><br/>
      <sub>Open, present, convert <code>.stage</code> in any browser.</sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/SlideStage/SlideStagePro"><img src="brand/png/slidestage-pro-mark.png" width="84" alt="SlideStagePro"></a><br/>
      <strong>SlideStagePro</strong><br/>
      <sub>Self-hosted platform</sub><br/>
      <sub>Multi-user library, notes &amp; annotations, Docker-deployable.</sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/SlideStage/slidestage-pack"><img src="brand/png/slidestage-pack-mark.png" width="84" alt="slidestage-pack"></a><br/>
      <strong>slidestage-pack</strong><br/>
      <sub>Agent skill packer</sub><br/>
      <sub>Turn any HTML deck into a <code>.stage</code> file.</sub>
    </td>
  </tr>
</table>

---

> **Status — v0 feature-complete (on branch `rebuild-pro-from-zero`).**
> The full stack — API, web, packages, schema, vendor tarballs, Docker
> compose, nginx reverse-proxy, boundary checker (+ its own self-test),
> fixture generator — is implemented and passes `check:boundaries` /
> `typecheck` / 18 tests / `build`. The `docker compose build && up`
> path is wired and statically validated; running it requires a Docker
> daemon (Docker Desktop / OrbStack / Colima).
>
> Documentation:
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
> [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) ·
> [`docs/AUTH_FLOW.md`](docs/AUTH_FLOW.md) ·
> [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) ·
> [`docs/LITE_PACKAGE_BOUNDARY.md`](docs/LITE_PACKAGE_BOUNDARY.md)

## Repository layout

```
SlideStagePro/
├── apps/
│   ├── api/                Hono server, Prisma client, Better Auth, storage
│   └── web/                Vite + React 19 + react-router v7 client
├── packages/
│   ├── pro-preset/         Pro-only SlideStage plugin (proPreset factory)
│   └── pro-shared/         Pro-internal shared types/constants
├── prisma/
│   ├── schema.prisma       Single SQLite schema (Better Auth + business + invites)
│   └── migrations/         Versioned SQL migrations (auto-applied on boot)
├── vendor/                 Vendored Lite tarballs (v0 only — removed once Lite ships to npm)
├── infra/
│   ├── docker/             Dockerfile.api, Dockerfile.web, api-entrypoint.sh
│   └── nginx/              edge nginx.conf + in-web-image web.conf
├── scripts/
│   ├── check-boundaries.mjs       CI gate: enforce Lite ↔ Pro boundary
│   ├── check-boundaries.test.mjs  Self-test: forge violations, assert checker fails
│   ├── sync-vendor.mjs            Re-pack Lite tarballs into vendor/
│   └── build-fixtures.mjs         Emit canonical .stage fixtures for manual QA
├── fixtures/               Smoke-test .stage files (valid + 3 invalid)
├── docs/                   Architecture · API · Auth · Deployment · Boundary
└── docker-compose.yml      api + web + nginx stack with persistent volume
```

## Quick start (development)

```bash
# 1) one-time setup
cp .env.example .env
# Edit .env: set BETTER_AUTH_SECRET (openssl rand -base64 32) and BOOTSTRAP_ADMIN_*

# 2) regenerate vendor tarballs from your local Lite checkout
#    (skip if you already have ../SlideStageLite at the right commit + vendor/*.tgz is fresh)
cd ../SlideStageLite && pnpm -r --filter "./packages/*" build
cd ../SlideStagePro && pnpm sync:vendor

# 3) install + migrate + run
pnpm install
pnpm db:migrate:dev
pnpm dev                # runs apps/api + apps/web in parallel
```

The API listens on `:3000`, the web dev server on `:5173`. Vite proxies
`/api` to the API (see `apps/web/vite.config.ts`).

## Quick start (production via Docker Compose)

```bash
cp .env.example .env
# set BETTER_AUTH_SECRET, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD

docker compose build
docker compose up -d
curl http://localhost/api/health
```

The compose stack runs three services:
- `api` — Node 22 + Hono + Prisma, mounts `slidestage-data` volume at `/data`.
- `web` — Nginx serving the Vite-built bundle.
- `nginx` — Edge reverse proxy on port 80, routes `/api/*` → api, `/` → web.

## CI checks (run before committing)

```bash
pnpm check:boundaries              # 0 violations on prose-free files
pnpm check:boundaries:self-test    # forge a violation per rule, verify checker fails
pnpm typecheck                     # tsc across all 4 workspace packages
pnpm test                          # 18 vitest cases across api + web
pnpm build                         # api dist + packages dist + vite SPA bundle
pnpm fixtures:check                # verify fixture .stage files exist + match
```

All six green = the diff is safe to merge.

## Lite ↔ Pro boundary

Pro **never** copies Lite source code. It consumes Lite packages by semver:

```json
"@slidestage/core": "^0.1.0",
"@slidestage/ui":   "^0.1.0",
"@slidestage/lite-preset": "^0.1.0"
```

In v0, while the Lite packages have not yet been published to a registry, those
specifiers are temporarily pinned to `file:./vendor/slidestage-*-<version>.tgz`.
See [`vendor/README.md`](vendor/README.md) for the upgrade path.

Forbidden patterns (enforced by `scripts/check-boundaries.mjs`):

- `file:../SlideStageLite` or `link:../SlideStageLite` in any dependency
- `import` from `"../SlideStageLite/..."`
- Re-declaring `manifestSchema` / `assertSafePath` / `loadDeck` (must come from `@slidestage/core`)
- `VITE_APP_EDITION` or `isPro` edition branching
- `apps/api` importing `react` / `react-dom`
- `apps/web` importing `@prisma/client` / `better-sqlite3` / `hono`
