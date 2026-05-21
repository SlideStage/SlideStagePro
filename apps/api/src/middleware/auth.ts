import type { Context, MiddlewareHandler } from "hono";
import type { Auth, AuthSession } from "../auth/index.js";

export type SessionUser = AuthSession["user"] & { role?: string };

export interface AuthVars {
  session: AuthSession["session"] | null;
  user: SessionUser | null;
}

type AppContext = Context<{ Variables: AuthVars }>;

export function createAuthMiddlewares(auth: Auth) {
  const attachSession: MiddlewareHandler<{ Variables: AuthVars }> = async (
    c,
    next,
  ) => {
    try {
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session?.user) {
        c.set("session", session.session);
        c.set("user", session.user as SessionUser);
      } else {
        c.set("session", null);
        c.set("user", null);
      }
    } catch {
      c.set("session", null);
      c.set("user", null);
    }
    await next();
  };

  const requireAuth: MiddlewareHandler<{ Variables: AuthVars }> = async (
    c,
    next,
  ) => {
    if (!c.get("user")) {
      return c.json(
        {
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        },
        401,
      );
    }
    await next();
  };

  const requireAdmin: MiddlewareHandler<{ Variables: AuthVars }> = async (
    c,
    next,
  ) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        {
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        },
        401,
      );
    }
    if ((user.role ?? "user") !== "admin") {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin role required" } },
        403,
      );
    }
    await next();
  };

  return { attachSession, requireAuth, requireAdmin };
}

export type AuthMiddlewares = ReturnType<typeof createAuthMiddlewares>;
export type { AppContext };
