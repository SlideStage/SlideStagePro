import { PrismaClient } from "@prisma/client";

/**
 * Returns a singleton Prisma client. We deliberately don't put this in a
 * module-level `const` so tests can call `createPrismaClient(testUrl)` with a
 * different DATABASE_URL per test (Prisma reads from env on construct).
 */
let globalClient: PrismaClient | null = null;

export interface PrismaSetupOptions {
  /**
   * Override DATABASE_URL for this client (useful for tests). Prisma reads
   * `env("DATABASE_URL")` at construct time, so we set it via the
   * `datasourceUrl` option here.
   */
  databaseUrl?: string;
}

export function createPrismaClient(options: PrismaSetupOptions = {}): PrismaClient {
  const client = options.databaseUrl
    ? new PrismaClient({ datasourceUrl: options.databaseUrl })
    : new PrismaClient();
  return client;
}

/**
 * Apply SQLite pragmas required by the contract:
 *   - journal_mode = WAL  → concurrent reads while one writer holds the lock
 *   - busy_timeout = 5000 → wait 5s before SQLITE_BUSY
 *   - foreign_keys = ON   → enforce cascades declared by Prisma
 *
 * These pragmas are SESSION-scoped (better-sqlite3 / libsql honour them per
 * connection). With Prisma's single underlying connection pool this is fine.
 */
export async function applySqlitePragmas(prisma: PrismaClient): Promise<void> {
  // SQLite PRAGMA statements return rows when assigning, so we must use
  // `$queryRawUnsafe` (not `$executeRawUnsafe`). All argument strings are
  // hardcoded constants.
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys = ON");
}

/** Lazily produce the global client used by routes (production code path). */
export function getPrisma(): PrismaClient {
  if (!globalClient) {
    globalClient = createPrismaClient();
  }
  return globalClient;
}

/** Replace the singleton (test bootstrap). */
export function setPrisma(client: PrismaClient): void {
  globalClient = client;
}

export async function disconnectPrisma(): Promise<void> {
  if (globalClient) {
    await globalClient.$disconnect();
    globalClient = null;
  }
}
