/**
 * Fastify app factory. Kept separate from main.ts so tests can spin up the
 * server with an injected config / DB without binding a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ZodError } from 'zod';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import type { AppConfig } from './config.js';
import { registerDeckRoutes } from './routes/decks.js';
import { registerDeckInfoRoute } from './routes/deck-info.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import { registerNotesRoute } from './routes/notes.js';
import { registerExportRoute } from './routes/export.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerStorageRoute } from './routes/storage.js';
import { getPrisma } from './db.js';

function isLocalhostDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  await fs.mkdir(config.storageRoot, { recursive: true });

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 10 * 1024 * 1024,
  });
  getPrisma(config.databaseUrl);

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin === config.webOrigin) return cb(null, true);
      if (config.corsAllowDevOrigins && isLocalhostDevOrigin(origin)) {
        return cb(null, true);
      }
      cb(null, false);
    },
    credentials: true,
    exposedHeaders: ['x-deck-id'],
  });

  await app.register(cookie);

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
    },
    attachFieldsToBody: false,
  });

  // Health probe — used by E2E and uptime checks.
  app.get('/api/health', async () => ({
    status: 'ok',
    schema: 'slidestage@1.0',
    storageRoot: path.relative(process.cwd(), config.storageRoot) || '.',
  }));

  await registerAuthRoutes(app, { config });
  await registerAdminRoutes(app, { config });
  await registerStorageRoute(app, { config });
  await registerDeckRoutes(app, { config });
  await registerDeckInfoRoute(app, { config });
  await registerAnnotationRoutes(app, { config });
  await registerNotesRoute(app, { config });
  await registerExportRoute(app, { config });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SlideStageError) {
      reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
      });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send({
        error: ERROR_CODES.EBADMANIFEST,
        message: err.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; '),
      });
      return;
    }
    if ((err as { statusCode?: number }).statusCode) {
      reply.code((err as { statusCode: number }).statusCode).send({
        error: err.name || 'Error',
        message: err.message,
      });
      return;
    }
    app.log.error(err);
    reply.code(500).send({
      error: 'EINTERNAL',
      message: err.message ?? 'unknown server error',
    });
  });

  return app;
}
