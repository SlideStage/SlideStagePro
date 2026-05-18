/**
 * Registration lockdown — vitest coverage.
 *
 * Covers the behavior added by `AUTH_ALLOW_REGISTRATION=false`:
 *
 *   1. With the switch off and an empty `User` table, the very first
 *      registration is still allowed (bootstrap admin path).
 *   2. The bootstrap account is automatically promoted to `admin`.
 *   3. Once a user exists, `POST /api/auth/register` returns 403 / EREGCLOSED.
 *   4. The OAuth helper `findOrCreateOAuthUser({ allowAutoCreate: false })`
 *      refuses to mint a new user but still logs an existing account in.
 *   5. Concurrent bootstrap registrations only promote one user to `admin`.
 *   6. OAuth auto-create promotes the first user to `admin`.
 *   7. `GET /api/auth/providers` advertises `allowRegistration: false` only
 *      when the switch is off **and** the table already has at least one user.
 *   8. With the switch on (default), nothing changes — sanity check that the
 *      backwards-compatible path still works.
 *
 * Each scenario gets its own `setupTestEnv` so we never pollute the DB across
 * cases (lockdown depends on `User.count() === 0`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  setupTestEnv,
  teardownTestEnv,
  type TestEnv,
} from './helpers.js';
import { findOrCreateOAuthUser } from '../src/routes/auth.js';
import { getPrisma } from '../src/db.js';

let active: TestEnv | null = null;

async function fresh(allowRegistration: boolean): Promise<TestEnv> {
  if (active) await teardownTestEnv(active);
  active = await setupTestEnv({ allowRegistration });
  return active;
}

afterEach(async () => {
  if (active) {
    await teardownTestEnv(active);
    active = null;
  }
});

async function register(
  env: TestEnv,
  email: string,
  name: string,
  password = 'correct horse',
): Promise<{ status: number; body: any; setCookie: string | string[] | undefined }> {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password, name }),
  });
  return {
    status: res.statusCode,
    body: res.statusCode === 204 ? null : res.json(),
    setCookie: res.headers['set-cookie'],
  };
}

describe('registration lockdown', () => {
  it('allows the bootstrap admin even when the switch is off', async () => {
    const env = await fresh(false);
    const out = await register(env, 'bootstrap@example.com', 'Bootstrap');
    expect(out.status).toBe(200);
    expect(out.body.user.email).toBe('bootstrap@example.com');
    // First account is auto-promoted to admin (pre-existing behaviour we
    // deliberately preserve under lockdown so a fresh deploy can sign in).
    expect(out.body.user.role).toBe('admin');
    expect(out.setCookie).toBeTruthy();
  });

  it('promotes only one admin across concurrent bootstrap registrations', async () => {
    const env = await fresh(true);
    const [first, second] = await Promise.all([
      register(env, 'first@example.com', 'First'),
      register(env, 'second@example.com', 'Second'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const users = await getPrisma().user.findMany({
      select: { email: true, role: true },
      orderBy: { email: 'asc' },
    });
    expect(users).toHaveLength(2);
    expect(users.filter((u) => u.role === 'admin')).toHaveLength(1);
    expect(users.filter((u) => u.role === 'user')).toHaveLength(1);
  });

  it('rejects subsequent registrations with 403 / EREGCLOSED', async () => {
    const env = await fresh(false);
    const first = await register(env, 'bootstrap@example.com', 'Bootstrap');
    expect(first.status).toBe(200);

    const second = await register(env, 'eve@example.com', 'Eve');
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('EREGCLOSED');
    expect(second.body.message).toMatch(/registration is disabled/i);

    // The blocked attempt must not have created the user.
    const count = await getPrisma().user.count();
    expect(count).toBe(1);
  });

  it('keeps `/api/auth/providers` honest about the dynamic allow flag', async () => {
    const env = await fresh(false);

    const beforeBootstrap = await env.app.inject({
      method: 'GET',
      url: '/api/auth/providers',
    });
    expect(beforeBootstrap.statusCode).toBe(200);
    // No users yet → bootstrap exception kicks in → allowRegistration: true.
    expect(beforeBootstrap.json().allowRegistration).toBe(true);

    await register(env, 'bootstrap@example.com', 'Bootstrap');

    const afterBootstrap = await env.app.inject({
      method: 'GET',
      url: '/api/auth/providers',
    });
    expect(afterBootstrap.json().allowRegistration).toBe(false);
  });

  it('reports `allowRegistration: true` when the switch is on (default)', async () => {
    const env = await fresh(true);
    await register(env, 'someone@example.com', 'Someone');
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/auth/providers',
    });
    expect(res.json().allowRegistration).toBe(true);
  });

  it('OAuth helper refuses to mint a fresh user when auto-create is off', async () => {
    const env = await fresh(false);
    // Bootstrap so the table is no longer empty.
    await register(env, 'bootstrap@example.com', 'Bootstrap');

    await expect(
      findOrCreateOAuthUser(
        {
          provider: 'github',
          providerAccountId: '999001',
          email: 'newcomer@example.com',
          name: 'Newcomer',
          avatarUrl: null,
        },
        { allowAutoCreate: false },
      ),
    ).rejects.toMatchObject({
      code: 'EREGCLOSED',
      statusCode: 403,
    });

    const userCount = await getPrisma().user.count();
    expect(userCount).toBe(1);
    const accountCount = await getPrisma().account.count({
      where: { provider: 'github' },
    });
    expect(accountCount).toBe(0);
  });

  it('OAuth helper promotes an auto-created first user to admin', async () => {
    await fresh(false);

    const user = await findOrCreateOAuthUser(
      {
        provider: 'github',
        providerAccountId: 'bootstrap-gh',
        email: 'oauth-bootstrap@example.com',
        name: 'OAuth Bootstrap',
        avatarUrl: null,
      },
      { allowAutoCreate: true },
    );

    expect(user.email).toBe('oauth-bootstrap@example.com');
    expect(user.role).toBe('admin');

    const stored = await getPrisma().user.findUniqueOrThrow({
      where: { id: user.id },
      include: { accounts: true },
    });
    expect(stored.role).toBe('admin');
    expect(stored.accounts.map((a) => a.provider)).toEqual(['github']);
  });

  it('OAuth helper still links a known email even when auto-create is off', async () => {
    const env = await fresh(false);
    const bootstrap = await register(env, 'bootstrap@example.com', 'Bootstrap');
    expect(bootstrap.status).toBe(200);

    const linked = await findOrCreateOAuthUser(
      {
        provider: 'github',
        providerAccountId: '42',
        email: 'bootstrap@example.com',
        name: 'Bootstrap GH',
        avatarUrl: 'https://example.invalid/avatar.png',
      },
      { allowAutoCreate: false },
    );
    expect(linked.email).toBe('bootstrap@example.com');
    // Same underlying user — the OAuth identity has just been linked.
    expect(linked.id).toBe(bootstrap.body.user.id);

    const accounts = await getPrisma().account.findMany({
      where: { userId: linked.id },
      orderBy: { provider: 'asc' },
    });
    expect(accounts.map((a) => a.provider)).toEqual(['github', 'local']);
  });

  it('OIDC helper links a known email only when provider marks it verified', async () => {
    const env = await fresh(true);
    const local = await register(env, 'owner@example.com', 'Owner');
    expect(local.status).toBe(200);

    const unverified = await findOrCreateOAuthUser(
      {
        provider: 'oidc:google',
        providerAccountId: 'unverified-sub',
        email: 'owner@example.com',
        emailVerified: false,
        name: 'Unverified OIDC',
        avatarUrl: null,
      },
      { allowAutoCreate: true },
    );
    expect(unverified.id).not.toBe(local.body.user.id);
    expect(unverified.email).toBe('unverified-sub@oidc-google.oauth.local');

    const ownerAccountsBeforeVerifiedLink = await getPrisma().account.findMany({
      where: { userId: local.body.user.id },
      orderBy: { provider: 'asc' },
    });
    expect(ownerAccountsBeforeVerifiedLink.map((a) => a.provider)).toEqual([
      'local',
    ]);

    const verified = await findOrCreateOAuthUser(
      {
        provider: 'oidc:google',
        providerAccountId: 'verified-sub',
        email: 'owner@example.com',
        emailVerified: true,
        name: 'Verified OIDC',
        avatarUrl: null,
      },
      { allowAutoCreate: false },
    );
    expect(verified.id).toBe(local.body.user.id);

    const ownerAccountsAfterVerifiedLink = await getPrisma().account.findMany({
      where: { userId: local.body.user.id },
      orderBy: { provider: 'asc' },
    });
    expect(ownerAccountsAfterVerifiedLink.map((a) => a.provider)).toEqual([
      'local',
      'oidc:google',
    ]);
  });
});
