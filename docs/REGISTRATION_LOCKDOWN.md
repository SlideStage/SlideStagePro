# Registration Lockdown — Change Summary

> Owner-side toggle to disable self-service registration without losing the
> "first run creates the admin" UX. Operational notes live in
> [`USER_MANAGEMENT.md`](./USER_MANAGEMENT.md#registration-lockdown);
> this doc is the implementation map for the next agent.

## TL;DR

```bash
AUTH_ALLOW_REGISTRATION=false   # production lockdown
```

| Sink                    | Before                                       | After                                                                              |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Local register          | `POST /api/auth/register` → 200, user minted | `403 EREGCLOSED` (except for the very first user, where bootstrap exception kicks in) |
| GitHub / OIDC callback  | New users silently created on first login    | `redirect /login?error=registration-disabled`, no rows written (linked accounts unaffected) |
| `/api/auth/providers`   | `{ providers }`                              | `{ providers, allowRegistration }`                                                 |
| `/register` page        | Renders the form                             | `Navigate replace` to `/login?error=registration-disabled`                         |
| Login page              | "No account? Create one"                     | "New accounts are managed by an administrator."                                    |
| Header (logged-out)     | Shows `Register` nav link                    | Hides `Register` nav link                                                          |

`AUTH_ALLOW_REGISTRATION` defaults to `true`, so existing deployments keep
working without a flag flip.

## Files Touched

| File                                                    | What changed                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/errors.ts`                         | Added `EREGCLOSED` error code (HTTP 403).                                                                 |
| `apps/server/src/config.ts`                             | Added `auth.allowRegistration` (`AUTH_ALLOW_REGISTRATION`, defaults to `true`).                            |
| `apps/server/.env.example`                              | Documented the new switch + session cookie envs.                                                          |
| `apps/server/src/routes/auth.ts`                        | `isRegistrationAllowed()` helper, `findOrCreateOAuthUser(profile, { allowAutoCreate })`, register-route guard, OAuth callback redirect, `/providers` payload extension. |
| `apps/server/tests/helpers.ts`                          | `setupTestEnv({ allowRegistration })` overload (lets the new vitest suite spin up a locked-down server).   |
| `apps/server/tests/auth.test.ts`                        | Asserts the default `allowRegistration: true` in the `/providers` response.                                |
| `apps/server/tests/registration-lockdown.test.ts`       | New suite — bootstrap exception, second-user 403, providers payload, OAuth helper auto-create=off, OAuth link-existing. |
| `apps/web/src/hooks/useAuth.ts`                         | Exposes `allowRegistration` from the auth context.                                                         |
| `apps/web/src/App.tsx`                                  | Header hides `Register` nav link under lockdown.                                                          |
| `apps/web/src/pages/LoginPage.tsx`                      | Surfaces `?error=registration-disabled` notice, swaps the "Create one" link for "managed by an administrator." copy. |
| `apps/web/src/pages/RegisterPage.tsx`                   | Renders a loading shim during the first refresh, then `<Navigate replace>` to `/login` under lockdown.    |
| `apps/web/src/styles/globals.css`                       | Added `.alert.info` style for the login notice.                                                            |
| `apps/web/tests/e2e/registration-lockdown.spec.ts`      | New spec — stubs `/api/auth/providers` to fake the lockdown and asserts the UI gates.                       |
| `docs/USER_MANAGEMENT.md`                               | New "Registration Lockdown" section (single source of truth for operators).                                |

## Decision Log

- **Why an env var instead of a DB setting?** Followed the existing config
  surface (`AUTH_COOKIE_SECURE`, `AUTH_SESSION_DAYS`, …) and avoided a new
  table just to hold one boolean. Easy to mix with secret managers / Helm
  values. Admins who want a live toggle can layer their own override on top.
- **Why preserve the bootstrap exception?** Otherwise a clean `docker compose
  up` with `AUTH_ALLOW_REGISTRATION=false` cannot create its first admin
  without dropping into `prisma studio` / a seed script. The exception is
  conservative — it only fires when `User.count() === 0` and **promotes the
  first account to admin**, which is the same behaviour that existed before
  the lockdown.
- **Why 404-style redirect instead of a JSON 403 on OAuth callbacks?** The
  callback is a top-level navigation. Dumping `{error: 'EREGCLOSED'}` in the
  user's browser tab is hostile; landing them back on `/login` with an
  inline notice is the equivalent of "thank you, your sign-in attempt was
  refused, here is what to do next."
- **Why a stubbed e2e instead of a second backend process?** The shared
  Playwright webServer is shared by every spec, and adding a second backend
  doubles boot time + breaks the single-deck-id workers=1 assumption. The
  UI-only gates read everything off `/api/auth/providers`, so faking that
  endpoint at the network layer is honest and isolates the spec.

## Test Plan

```bash
# Build the shared schema package
pnpm build:shared

# Unit / integration (vitest)
pnpm test:server

# End-to-end (Playwright). Builds the server, runs prisma db push, then both
# the dev backend on :4001 and the SPA on :5173.
CI=1 pnpm test:e2e
```

The two relevant suites:

- `apps/server/tests/registration-lockdown.test.ts`
- `apps/web/tests/e2e/registration-lockdown.spec.ts`

Both are wired into the existing scripts (`pnpm test:server`, `pnpm test:e2e`)
without any extra runner configuration.

## Rollout Checklist

1. Deploy the new server build to staging with the default
   `AUTH_ALLOW_REGISTRATION=true`. Smoke-test login / register / OAuth.
2. Create the bootstrap admin in production (`/register` once).
3. Set `AUTH_ALLOW_REGISTRATION=false` in production, restart the server.
4. Confirm `/register` redirects to `/login` and the header hides `Register`.
5. Onboard new users via `/admin/users` going forward.

## Reverting

Drop `AUTH_ALLOW_REGISTRATION=false` (or set it back to `true`) and restart
the server. No DB migration is involved; no rows have to be touched. The
SPA picks up the new state on its next `/api/auth/providers` request.
