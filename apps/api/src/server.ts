import { Hono } from "hono";
import { cors } from "hono/cors";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import type { Repositories } from "./db/repositories/index.js";
import { createRepositories } from "./db/repositories/index.js";
import type { StorageDriver } from "./storage/types.js";
import { createStorage } from "./storage/index.js";
import { buildAuth, type Auth } from "./auth/index.js";
import { createAuthMiddlewares, type AuthVars } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { createHealthRoutes } from "./routes/health.js";
import { createDeckRoutes } from "./routes/decks.js";
import { createNoteRoutes } from "./routes/notes.js";
import { createAnnotationRoutes } from "./routes/annotations.js";
import { createInviteRoutes } from "./routes/invites.js";
import { createUserRoutes } from "./routes/users.js";

export const PRO_API_VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  /** Optional override for testing — defaults to `createStorage(config)`. */
  storage?: StorageDriver;
  /** Optional override — defaults to `buildAuth({ prisma, config })`. */
  auth?: Auth;
  /** Optional override — defaults to `createRepositories(prisma)`. */
  repos?: Repositories;
  /** Epoch-ms when the process started (for uptime); defaults to now. */
  startedAt?: number;
}

export interface BuiltApp {
  app: Hono<{ Variables: AuthVars }>;
  auth: Auth;
  storage: StorageDriver;
  repos: Repositories;
}

export function createApp(deps: AppDeps): BuiltApp {
  const repos = deps.repos ?? createRepositories(deps.prisma);
  const storage = deps.storage ?? createStorage(deps.config);
  const auth = deps.auth ?? buildAuth({ prisma: deps.prisma, config: deps.config });
  const startedAt = deps.startedAt ?? Date.now();

  const app = new Hono<{ Variables: AuthVars }>();

  // CORS (must come before auth handler so preflights work)
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return undefined;
        if (deps.config.corsOrigins.length === 0) return origin;
        return deps.config.corsOrigins.includes(origin) ? origin : null;
      },
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "If-None-Match"],
      exposeHeaders: ["ETag", "Content-Length", "Content-Disposition"],
      maxAge: 600,
    }),
  );

  // ---- Public ----
  app.route("/api/health", createHealthRoutes({
    prisma: deps.prisma,
    storage,
    version: PRO_API_VERSION,
    startedAt,
  }));

  // ---- Better Auth catch-all (mounted under /api/auth/*) ----
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // ---- Auth middleware ----
  const { attachSession, requireAuth, requireAdmin } = createAuthMiddlewares(auth);

  // Decks (authenticated)
  app.use("/api/decks", attachSession);
  app.use("/api/decks", requireAuth);
  app.use("/api/decks/*", attachSession);
  app.use("/api/decks/*", requireAuth);
  app.route(
    "/api/decks",
    createDeckRoutes({
      repos,
      storage,
      uploadMaxBytes: deps.config.uploadMaxBytes,
    }),
  );

  // Notes (authenticated; routes are mounted at /api so they can self-namespace)
  const notesApp = createNoteRoutes({ repos });
  app.use("/api/decks/*/notes", attachSession);
  app.use("/api/decks/*/notes/*", attachSession);
  app.use("/api/decks/*/notes", requireAuth);
  app.use("/api/decks/*/notes/*", requireAuth);
  app.route("/api", notesApp);

  // Annotations (authenticated)
  const annotationsApp = createAnnotationRoutes({
    repos,
    annotationMaxBytes: deps.config.annotationMaxBytes,
  });
  app.use("/api/decks/*/annotations", attachSession);
  app.use("/api/decks/*/annotations/*", attachSession);
  app.use("/api/decks/*/annotations", requireAuth);
  app.use("/api/decks/*/annotations/*", requireAuth);
  app.route("/api", annotationsApp);

  // Invites (admin only)
  app.use("/api/invites", attachSession);
  app.use("/api/invites/*", attachSession);
  app.use("/api/invites", requireAdmin);
  app.use("/api/invites/*", requireAdmin);
  app.route("/api/invites", createInviteRoutes({ repos }));

  // Users (admin only)
  app.use("/api/users", attachSession);
  app.use("/api/users/*", attachSession);
  app.use("/api/users", requireAdmin);
  app.use("/api/users/*", requireAdmin);
  app.route("/api/users", createUserRoutes({ repos }));

  app.notFound(notFoundHandler);
  app.onError(errorHandler);

  return { app, auth, storage, repos };
}
