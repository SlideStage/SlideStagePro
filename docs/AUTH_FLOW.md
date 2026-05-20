# SlideStage Pro v0 — Auth & Invite Flow

> Status: **frozen contract for Phase 1 parallel agents**. Owner: Agent A.

## 1. Library & runtime

- **Library**: [Better Auth](https://www.better-auth.com/) with the official
  Prisma adapter, backed by SQLite (`better-sqlite3` driver).
- **HTTP host**: Hono (`apps/api`). Better Auth is mounted at `/api/auth/*`.
- **Browser client**: `better-auth/react` (`createAuthClient`) in `apps/web`.
- **Session storage**: SQLite `session` table (managed by Better Auth). Cookies
  are HttpOnly, SameSite=Lax, Secure in production, max-age = 7 days.

## 2. Schema ownership

Better Auth owns these tables (mapped via `@@map` to lowercased names):
- `user` (we extend with `role: String @default("user")`)
- `session`
- `account` (holds bcrypt-hashed passwords for credentials accounts)
- `verification`

Pro owns these tables:
- `deck`, `deck_version`, `slide_note`, `slide_annotation`
- `invite` (the lockdown system, NOT a Better Auth table)

If we ever want a Better Auth feature that needs a new column on `user`, we add
it to `prisma/schema.prisma` and run `pnpm db:migrate:dev`. Better Auth detects
extra columns via its `additionalFields` config option.

## 3. Registration lockdown

**The site is closed-registration**. The flow is:

```
┌────────────────┐   1) bootstrap on first boot     ┌───────────────┐
│ env BOOTSTRAP_ │ ───────────────────────────────▶ │  admin user   │
│ ADMIN_*        │                                  │ (role=admin)  │
└────────────────┘                                  └─────┬─────────┘
                                                          │ 2) admin creates an Invite
                                                          ▼
                                                  ┌───────────────┐
                                                  │ Invite row    │
                                                  │ (token, role) │
                                                  └─────┬─────────┘
                                                        │ 3) admin shares the URL:
                                                        │    /sign-up?invite=<token>
                                                        ▼
                                                  ┌───────────────┐
                                                  │ guest signs up│
                                                  │ with invite   │
                                                  └─────┬─────────┘
                                                        │ 4) server validates invite
                                                        ▼
                                                  ┌───────────────┐
                                                  │ new user      │
                                                  │ + invite.usedAt│
                                                  └───────────────┘
```

### 3.1 Bootstrap admin

On API startup, before serving traffic, `apps/api/src/auth/bootstrap.ts` does:

1. `SELECT COUNT(*) FROM user`.
2. If `0` and `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` are set in
   env, call Better Auth's internal sign-up to create the user, then `UPDATE
   user SET role='admin' WHERE email = ?`.
3. Log the email (never the password) and the user id.
4. If `0` and env is missing, exit with code 2 — refuse to serve traffic without
   an admin.

### 3.2 Invite creation (admin only)

`POST /api/invites` body:
```json
{ "email": "alice@example.com", "role": "user", "ttlHours": 72 }
```

Server:
1. Verify caller is admin.
2. Generate a 32-byte random token, hex-encoded.
3. Insert `Invite { id, token, email?, role, createdById, expiresAt, ... }`.
4. Return the token to the admin in the response **only once**; never again.

### 3.3 Sign-up with invite

`POST /api/auth/sign-up/email` body:
```json
{
  "email": "alice@example.com",
  "password": "...",
  "name": "Alice",
  "inviteToken": "..."
}
```

Server (Better Auth hook in `apps/api/src/auth/index.ts`):

1. Look up the invite by `token`. If missing → 403 `INVITE_REQUIRED`.
2. Reject if `expiresAt < now` → 403 `INVITE_EXPIRED`.
3. Reject if `usedAt != null` → 403 `INVITE_USED`.
4. If `invite.email != null`, require `body.email == invite.email` → otherwise 403 `INVITE_EMAIL_MISMATCH`.
5. Let Better Auth create the user normally (it will create the `user` and
   `account` rows and hash the password).
6. After successful sign-up, in the same transaction:
   - `UPDATE user SET role = invite.role WHERE id = newUserId`
   - `UPDATE invite SET usedAt = now(), usedByEmail = newUserEmail WHERE id = invite.id`
7. If invite role is admin, log it loudly (audit trail).

Better Auth allows hooking the sign-up via `databaseHooks.user.create.before`
and `databaseHooks.user.create.after`. Use both: `before` to validate the
invite, `after` to mark it used + set role. See Better Auth docs:
<https://www.better-auth.com/docs/concepts/database#database-hooks>

### 3.4 Anonymous sign-up rejection

Without `inviteToken` in the body, the `before` hook throws and Better Auth
returns 403. The web client UI **never shows** the standalone sign-up page;
the only way to reach it is via `/sign-up?invite=<token>` which prefills the
hidden field.

## 4. Session middleware

`apps/api/src/middleware/auth.ts` exports:

- `attachSession(c, next)` — extracts the Better Auth session if present,
  stores it on `c.get('session')` and `c.get('user')`. Always succeeds (no
  rejection).
- `requireAuth(c, next)` — calls `attachSession` then 401s if no user.
- `requireAdmin(c, next)` — calls `requireAuth` then 403s if `user.role !== 'admin'`.

Hono usage:
```ts
app.use('/api/decks/*', attachSession);
app.use('/api/decks/*', requireAuth);
app.use('/api/invites/*', requireAdmin);
```

## 5. Web client integration (for Agent B)

```ts
// apps/web/src/auth/client.ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? "/api",
});

export const { signIn, signUp, signOut, useSession } = authClient;
```

### Sign-in (login page)
```ts
await authClient.signIn.email({
  email,
  password,
  callbackURL: "/dashboard",
});
```

### Sign-up via invite (only reachable via /sign-up?invite=<token>)
```ts
await authClient.signUp.email({
  email,
  password,
  name,
  // custom field — passes through to server hook
  inviteToken: invite,
});
```

### Session in components
```tsx
function App() {
  const { data: session, isPending } = useSession();
  if (isPending) return <Spinner />;
  if (!session) return <Navigate to="/login" />;
  return <Outlet context={{ user: session.user }} />;
}
```

## 6. Configuration files

### `apps/api/src/auth/index.ts`

```ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "../db/prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: false, // v0: trust admin invites
  },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "user", input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          const inviteToken = ctx?.context?.body?.inviteToken;
          // ...validate as described in 3.3
          return user; // mutation handled in 'after'
        },
        after: async (user, ctx) => {
          // mark invite used + set role
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
```

## 7. Test matrix (Agent E owns these)

| Case | Expected |
|---|---|
| sign-up without inviteToken | 403 INVITE_REQUIRED |
| sign-up with expired invite | 403 INVITE_EXPIRED |
| sign-up with used invite | 403 INVITE_USED |
| sign-up with email-bound invite + wrong email | 403 INVITE_EMAIL_MISMATCH |
| sign-up with valid invite | 200, user role = invite.role, invite.usedAt set |
| sign-in with correct credentials | 200, session cookie set |
| sign-in with wrong password | 401 |
| protected endpoint without session | 401 |
| admin-only endpoint with role=user | 403 |
| bootstrap when DB empty + env present | admin created on first boot |
| bootstrap when DB empty + env missing | API exits with code 2 |

## 8. v0 explicitly-deferred features

- OAuth providers (GitHub / Google) — Better Auth supports them via
  `socialProviders` config; we just don't enable any in v0.
- Passkey / WebAuthn — Better Auth plugin, off in v0.
- 2FA / TOTP — off in v0 (the `twoFactor` table is also not in schema).
- Password reset via email — off in v0 (no SMTP). Admin can issue a new invite.
- Session revocation UI — out of v0 scope.
