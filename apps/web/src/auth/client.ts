import { createAuthClient } from "better-auth/react";

// The Vite dev server proxies `/api` to the Hono server on :3000, and in
// production nginx proxies the same prefix. So one base URL handles both.
//
// IMPORTANT: Better Auth's React client requires an ABSOLUTE base URL
// (it validates with `new URL(...)`), even when it points at the same
// origin. We anchor it to `window.location.origin` so the same code works
// in dev (`http://localhost:5173/api/auth` → Vite proxy → :3000) and prod
// (`https://<host>/api/auth` → nginx → api:3000).
//
// The server mounts the handler at `/api/auth/*` and Better Auth's client
// appends `/sign-in/email` etc. on top of `baseURL`.
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
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
