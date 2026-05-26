# SlideStage Pro — Deployment

> Target: any Linux VPS with Docker + Docker Compose. No Kubernetes, no
> Cloudflare Workers, no managed Postgres.

## 1. Minimum requirements

| Resource | Recommended |
|---|---|
| CPU | 1 vCPU (2 if you expect concurrent uploads) |
| RAM | 1 GB (2 GB if many large decks open at once) |
| Disk | depends on deck size — start with 20 GB |
| OS | any Linux that runs Docker Engine 24+ |
| Docker | Engine 24.x, Compose v2 |
| Ports | 80 (HTTP). 443 if you terminate TLS in front. |

## 2. One-time setup

### 2.1 Clone & configure

```bash
git clone <your-fork-url> slidestage-pro
cd slidestage-pro
cp .env.example .env
```

Then edit `.env`:

| Variable | What to set |
|---|---|
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Public URL of your install (e.g. `https://decks.example.com`). Must match what users browse to or login cookies break. |
| `BOOTSTRAP_ADMIN_EMAIL` | First admin account email |
| `BOOTSTRAP_ADMIN_PASSWORD` | Strong password — change it after first login |
| `BOOTSTRAP_ADMIN_NAME` | Display name |
| `UPLOAD_MAX_BYTES` | Default 100 MiB. Adjust if your decks are larger. |
| `CORS_ORIGINS` | Comma-separated. Usually empty for same-origin deploys; only needed if the SPA lives on a different domain. |
| `HTTP_PORT` | Default `80`. Override to e.g. `8080` if you front it with another proxy. |

Do **not** commit `.env`. The compose file uses `${VAR:?...}` syntax so
missing required vars fail fast with a clear error.

> **Note**: as of Phase A.A4 (2026-05-26), the previous `vendor/*.tgz`
> bridge has been removed. The Docker build fetches `@slidestage/core`,
> `@slidestage/ui`, and `@slidestage/lite-preset` from the public npm
> registry during `pnpm install`. Build hosts therefore need outbound
> network access to `registry.npmjs.org` at build time.

## 3. Build & launch

```bash
docker compose build
docker compose up -d
docker compose logs -f api | head -40
```

You should see:

```
[bootstrap] no users found; creating admin <email>
[api] listening on http://0.0.0.0:3000 (env=production)
```

Then verify:

```bash
curl http://localhost/api/health
# {"status":"ok","version":"0.1.0","uptimeSeconds":X,"checks":{"db":"ok","storage":"ok"}}
```

Open `http://<host>/login`, sign in as the bootstrap admin, then visit
`/settings` to mint your first invite.

## 4. TLS

The included `nginx` service speaks HTTP on port 80. For production HTTPS
use either of these patterns:

### 4.1 External terminator (recommended)

Put Caddy / Traefik / Cloudflare Tunnel in front and forward HTTP to the
compose stack. Example Caddyfile:

```
decks.example.com {
  reverse_proxy localhost:80
}
```

Caddy handles certificate issuance automatically.

### 4.2 In-compose terminator

Replace the `nginx` service with one of the certbot-aware nginx images and
mount `/etc/letsencrypt`. Out of scope for v0; the `infra/nginx/nginx.conf`
file uses standard directives so it's a small edit.

## 5. Backups

### What lives where

- **Metadata (notes, deck rows, users, invites)** — `slidestage-data` volume
  → `/data/slidestage-pro.sqlite` (+ `-wal`/`-shm` companions).
- **`.stage` blobs** — same volume, `/data/decks/<deckId>/<versionId>.stage`.

### Recommended backup procedure

```bash
# 1) checkpoint WAL so the .sqlite file is self-contained
docker compose exec api sh -c 'cd /data && sqlite3 slidestage-pro.sqlite "PRAGMA wal_checkpoint(FULL);"' || true

# 2) snapshot the entire volume
docker run --rm \
  -v slidestage-pro_slidestage-data:/data:ro \
  -v "$(pwd)":/backup \
  alpine tar czf /backup/slidestage-backup-$(date +%F).tar.gz -C / data
```

Restore by stopping the stack, replacing the volume contents from the
tarball, and starting again.

## 6. Migrations

Each container start runs `prisma migrate deploy` automatically. Migrations
are committed to `prisma/migrations/` and applied in order, so deploying a
newer image is a `git pull && docker compose build api && docker compose up -d api`.

Manual migration command (if you need to run it without restarting):

```bash
docker compose exec api node node_modules/prisma/build/index.js \
  migrate deploy --schema=./prisma/schema.prisma
```

## 7. Upgrades

```bash
git pull
pnpm sync:vendor          # only if you updated Lite tarballs
docker compose build
docker compose up -d
docker compose logs -f api
```

Compose's image cache means most rebuilds reuse the deps layer. A typical
incremental build is < 30 s.

## 8. Operational checklist

| Check | Command | Expected |
|---|---|---|
| API liveness | `curl http://localhost/api/health` | 200 + `status: "ok"` |
| DB writable | `docker compose exec api sh -c 'sqlite3 /data/slidestage-pro.sqlite "INSERT INTO _smoke (k) VALUES ('"'"'x'"'"'); DELETE FROM _smoke WHERE k='"'"'x'"'"';"'` | exit 0 (create table once if you want this probe) |
| Volume size | `docker system df -v` | confirm `slidestage-data` growth is expected |
| Container health | `docker compose ps` | all `healthy` |
| Logs | `docker compose logs -f --since=1h` | no repeated errors |

## 9. Scaling notes

v0 deliberately ships SQLite + local storage. When you outgrow either:

- **DB**: switch `datasource db { provider = "postgresql" }` in
  `prisma/schema.prisma`, write a Prisma migration, and update
  `DATABASE_URL`. The repository layer in `apps/api/src/db/repositories/`
  isolates queries from Prisma specifics so the routes don't need to
  change.
- **Storage**: implement `apps/api/src/storage/s3.ts` against the
  `StorageDriver` interface (see [`ARCHITECTURE.md`](ARCHITECTURE.md#7-storage-driver)),
  add `STORAGE_DRIVER=s3` plus the S3 env vars, and `createStorage()` picks
  it up.

Both swaps are isolated; no business code changes.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Compose `up` exits with `BETTER_AUTH_SECRET is required` | `.env` missing or var unset | populate `.env` from `.env.example` |
| `/api/health` returns 503 with `checks.storage: "fail"` | `/data` not writable (host permissions) | `chown 1000:1000 ./data` or remove and let Docker re-create the volume |
| `INVITE_REQUIRED` on every signup attempt | working as designed — closed registration | admin creates an invite at `/settings` and shares `/sign-up?invite=<token>` |
| Bundled web shows blank page | nginx serves SPA but `BETTER_AUTH_URL` doesn't match host | edit `.env`, `docker compose up -d --force-recreate api` |
| Upload fails with `UPLOAD_TOO_LARGE` despite small file | nginx `client_max_body_size` cap < `UPLOAD_MAX_BYTES` | edit `infra/nginx/nginx.conf`, reload via `docker compose restart nginx` |
| Migrations fail with `P3018` | conflicting manual edits in DB | restore from backup; never edit Prisma-managed tables by hand |
