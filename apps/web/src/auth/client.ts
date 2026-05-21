import { createAuthClient } from "better-auth/react";

// The Vite dev server proxies `/api` to the Hono server on :3000, and in
// production nginx proxies the same prefix. So one base URL handles both.
//
// IMPORTANT: per docs/AUTH_FLOW.md §5 the base URL is `/api/auth` — Better
// Auth's React client appends `/sign-in/email` etc. on top of `baseURL`, and
// the server mounts the handler at `/api/auth/*`.
export const authClient = createAuthClient({
  baseURL: "/api/auth",
});

export const { signIn, signUp, signOut, useSession } = authClient;

// Convenience type for the user inside our session. Better Auth's
// `additionalFields.role` is configured on the server, so the runtime payload
// carries `role` but the client typings don't expose it by default. We widen
// it here.
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  image?: string | null;
  role?: "user" | "admin" | string;
};

export function userIsAdmin(user: SessionUser | null | undefined): boolean {
  return Boolean(user && user.role === "admin");
}
