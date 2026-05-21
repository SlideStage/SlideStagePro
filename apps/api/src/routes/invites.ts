import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Repositories } from "../db/repositories/index.js";
import { ApiError } from "../middleware/error.js";
import type { AuthVars } from "../middleware/auth.js";
import type { InviteRecord, Role } from "../types/contract.js";

export interface InviteRoutesDeps {
  repos: Repositories;
}

const createSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(["user", "admin"]).default("user"),
  ttlHours: z.number().int().min(1).max(24 * 30).default(72),
});

function toRecord(invite: {
  id: string;
  token: string;
  email: string | null;
  role: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedByEmail: string | null;
  createdById: string;
}): InviteRecord {
  return {
    id: invite.id,
    token: invite.token,
    email: invite.email,
    role: (invite.role === "admin" ? "admin" : "user") as Role,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    usedAt: invite.usedAt ? invite.usedAt.toISOString() : null,
    usedByEmail: invite.usedByEmail,
    createdById: invite.createdById,
  };
}

export function createInviteRoutes(
  deps: InviteRoutesDeps,
): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  // GET /api/invites
  app.get("/", async (c) => {
    const rows = await deps.repos.invite.list();
    return c.json({ items: rows.map(toRecord) }, 200);
  });

  // POST /api/invites
  app.post("/", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_BODY", "Invalid invite body", parsed.error.flatten());
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + parsed.data.ttlHours * 3600 * 1000);
    const invite = await deps.repos.invite.create({
      token,
      email: parsed.data.email ?? null,
      role: parsed.data.role,
      createdById: user.id,
      expiresAt,
    });
    return c.json(toRecord(invite), 201);
  });

  // DELETE /api/invites/:id
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const result = await deps.repos.invite.deleteById(id);
    if (!result) throw new ApiError(404, "NOT_FOUND", "Invite not found");
    return c.body(null, 204);
  });

  return app;
}
