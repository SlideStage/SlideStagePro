import { PrismaClient, type Prisma } from '@prisma/client';

let _prisma: PrismaClient | null = null;
let _databaseUrl: string | null = null;

export function getPrisma(databaseUrl?: string): PrismaClient {
  if (!_prisma) {
    const options: Prisma.PrismaClientOptions = {
      log:
        process.env.NODE_ENV === 'development'
          ? ['warn', 'error']
          : ['error'],
      ...(databaseUrl
        ? {
            datasources: {
              db: { url: databaseUrl },
            },
          }
        : {}),
    };
    _databaseUrl = databaseUrl ?? process.env.DATABASE_URL ?? null;
    _prisma = new PrismaClient(options);
  } else if (databaseUrl && _databaseUrl && databaseUrl !== _databaseUrl) {
    throw new Error(
      `Prisma client already initialized for ${_databaseUrl}; cannot reuse it for ${databaseUrl}`,
    );
  }
  return _prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
    _databaseUrl = null;
  }
}
