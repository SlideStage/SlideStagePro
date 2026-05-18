# User Management

This project now uses real users and HttpOnly session cookies. The old
`x-user-id` fake login path has been removed from app and test code.

## Accounts

Users are stored in Prisma:

- `User`: email, display name, avatar URL, password hash, role, disabled state.
- `Account`: linked login identities (`local`, `github`, `oidc:<key>`).
- `Session`: HttpOnly cookie sessions. The browser receives a random token;
  the database stores only the SHA-256 hash.

Roles:

- `user`: can manage their own decks, notes, annotations, presenter windows.
- `admin`: can use `/admin/users` and `/api/admin/users`.

Disabled users cannot use their sessions. Disabling a user deletes their active
sessions.

## First Admin

The first registered account becomes `admin` automatically. For a fresh local
database:

1. Run the app.
2. Open `/register`.
3. Create the first account.
4. The header will show a `Users` navigation item.

If you already had a local database before this feature, sync the schema first:

```bash
pnpm --filter @slidestage/server exec prisma db push --skip-generate
pnpm --filter @slidestage/server exec prisma generate
```

Then create or promote an admin with Prisma Studio:

```bash
pnpm --filter @slidestage/server exec prisma studio
```

Open the `users` table and set `role` to `admin` for the desired account.

## Registration Lockdown

Most production deployments don't want strangers self-signing up on the public
URL. Set:

```bash
AUTH_ALLOW_REGISTRATION=false
```

(`true` by default, so existing deployments keep working without a flag flip.)

When this switch is off, the following changes happen, atomically:

| Path                                | Behaviour                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `POST /api/auth/register`           | `403 EREGCLOSED` instead of creating a new user.                            |
| OAuth / OIDC callback (new account) | Redirects to `/login?error=registration-disabled`; no user / account row is created. |
| OAuth / OIDC callback (existing)    | Unchanged — users with a pre-existing local or linked account still log in. |
| `GET /api/auth/providers`           | Adds `allowRegistration: false` so the SPA can hide affordances.            |
| `GET /register` (web)               | Redirects to `/login?error=registration-disabled` with a notice.            |
| Login page (web)                    | Replaces "No account? Create one" with "New accounts are managed by an administrator." |
| Header (web)                        | Hides the `Register` nav link.                                              |

### Bootstrap exception

To keep first-time deploys simple, the lockdown is **automatically bypassed
while the `User` table is empty**. That single first registration is allowed
and is promoted to `admin`, regardless of the flag. After that account exists,
the lockdown becomes effective until the table is empty again.

This means you can safely ship `AUTH_ALLOW_REGISTRATION=false` from day one in
your `.env` and still bring the deployment up with a normal `/register` flow.

### Adding more users under lockdown

Admins use `/admin/users` (or `POST /api/admin/users`) to create new local
users. OAuth users can still link to an existing account — if the email
returned by GitHub or your OIDC provider already belongs to a user, the
callback links the OAuth identity to that user instead of refusing it.

### Error code

`EREGCLOSED` (HTTP 403, exported from `@slidestage/shared`) is the canonical
machine-readable signal for "registration is disabled". Surface the
`message` field verbatim to the user; it already explains the path forward.

## Admin UI

Admins can open `/admin/users`.

Current capabilities:

- List users.
- See role, active sessions, deck count, linked auth providers.
- Create local users.
- Create local admins.
- Change a user's role.
- Disable or re-enable a user.

Safety checks:

- Admins cannot disable themselves.
- Admins cannot demote themselves from `admin` to `user`.

## Local Password Login

Routes:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PATCH /api/auth/me`
- `POST /api/auth/change-password`

Passwords are hashed with Argon2id. Passwords are never returned to the client.

Session cookie defaults:

- Cookie name: `slidestage_session`
- Lifetime: 30 days
- `HttpOnly`
- `SameSite=Lax`
- `Secure=false` by default for local development

Production should set:

```bash
AUTH_COOKIE_SECURE=true
AUTH_SESSION_DAYS=30
AUTH_SESSION_COOKIE=slidestage_session
```

## GitHub OAuth

Create a GitHub OAuth App and set callback URL to:

```text
http://localhost:4000/api/auth/oauth/github/callback
```

For production, replace host and scheme with the public server URL.

Set:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=http://localhost:4000/api/auth/oauth/github/callback
```

When configured, the login page shows `Continue with GitHub`.

## Generic OIDC

Generic OIDC supports providers such as Google, Auth0, Keycloak, Azure AD, and
other OpenID Connect issuers.

Example for Google:

```bash
OIDC_PROVIDERS=google
OIDC_GOOGLE_ISSUER=https://accounts.google.com
OIDC_GOOGLE_CLIENT_ID=...
OIDC_GOOGLE_CLIENT_SECRET=...
OIDC_GOOGLE_REDIRECT_URI=http://localhost:4000/api/auth/oauth/google/callback
```

Multiple providers are comma-separated:

```bash
OIDC_PROVIDERS=google,keycloak
OIDC_GOOGLE_ISSUER=https://accounts.google.com
OIDC_GOOGLE_CLIENT_ID=...
OIDC_GOOGLE_CLIENT_SECRET=...
OIDC_GOOGLE_REDIRECT_URI=...
OIDC_KEYCLOAK_ISSUER=https://keycloak.example.com/realms/slidestage
OIDC_KEYCLOAK_CLIENT_ID=...
OIDC_KEYCLOAK_CLIENT_SECRET=...
OIDC_KEYCLOAK_REDIRECT_URI=...
```

The frontend calls `/api/auth/providers`; unconfigured providers are hidden.

## OAuth Account Linking

OAuth callback behavior:

1. If `(provider, providerAccountId)` already exists, log in that user.
2. Else if the provider returns an email already owned by a user, link the
   OAuth account to that user.
3. Else create a new user and linked account.

This lets a user have a local password and third-party login on the same email.

## API Authorization

Decks, annotations, notes, exports, presenter view data, and audience view data
now resolve the owner from the session cookie.

There is no trusted `x-user-id` fallback.

## Tests

Run:

```bash
pnpm build
pnpm test:server
CI=1 pnpm test:e2e
```

Coverage includes:

- Register/login/logout/me/profile.
- Admin create/disable/enable/role changes.
- Deck isolation under real sessions.
- Browser session persistence.
- Existing presenter, notes, icon, and deck flows under real cookies.

