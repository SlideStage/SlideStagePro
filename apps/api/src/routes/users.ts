import { Hono } from "hono";
import { z } from "zod";
import type { Repositories } from "../db/repositories/index.js";
import { ApiError } from "../middleware/error.js";
import type { AuthVars } from "../middleware/auth.js";
import type { UserRecord, Role } from "../types/contract.js";

export interface UserRoutesDeps {
  repos: Repositories;
}

const patchSchema = z
  .object({
    role: z.enum(["user", "admin"]).optional(),
    name: z.string().min(1).max(120).optional(),
  })
  .refine((v) => v.role !== undefined || v.name !== undefined, {
    message: "At least one of `role` or `name` must be provided",
  });

function toRecord(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}): UserRecord {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: (u.role === "admin" ? "admin" : "user") as Role,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export function createUserRoutes(deps: UserRoutesDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  // GET /api/users
  app.get("/", async (c) => {
    const rows = await deps.repos.user.list();
    return c.json({ items: rows.map(toRecord) }, 200);
  });

  // PATCH /api/users/:id
  app.patch("/:id", async (c) => {
    const caller = c.get("user")!;
    const targetId = c.req.param("id");
    const target = await deps.repos.user.findById(targetId);
    if (!target) throw new ApiError(404, "NOT_FOUND", "User not found");

    const body = await c.req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_BODY", "Invalid update", parsed.error.flatten());
    }

    if (parsed.data.role === "user" && target.id === caller.id) {
      throw new ApiError(
        400,
        "CANNOT_DEMOTE_SELF",
        "Admins cannot demote themselves",
      );
    }

    const updated = await deps.repos.user.update(targetId, {
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
    });
    return c.json(toRecord(updated), 200);
  });

  // DELETE /api/users/:id
  app.delete("/:id", async (c) => {
    const caller = c.get("user")!;
    const targetId = c.req.param("id");
    if (targetId === caller.id) {
      throw new ApiError(400, "CANNOT_DELETE_SELF", "Admins cannot delete themselves");
    }
    const target = await deps.repos.user.findById(targetId);
    if (!target) throw new ApiError(404, "NOT_FOUND", "User not found");
    await deps.repos.user.deleteById(targetId);
    return c.body(null, 204);
  });

  return app;
}
