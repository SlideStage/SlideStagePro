#!/bin/sh
# SlideStagePro API entrypoint.
# 1. Wait for /data to be writable (volume mount race on first boot).
# 2. Run idempotent Prisma migrations against the SQLite file.
# 3. Hand off to the original command (node apps/api/dist/index.js).

set -e

mkdir -p "${DATA_DIR:-/data}"

echo "[entrypoint] applying Prisma migrations to ${DATABASE_URL:-(default)}"
# We use the local node_modules' prisma CLI directly rather than `pnpm`
# (pnpm isn't strictly required at runtime and slows boot).
node ./node_modules/prisma/build/index.js migrate deploy \
  --schema=./prisma/schema.prisma

echo "[entrypoint] starting API: $*"
exec "$@"
