import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  setupTestEnv,
  teardownTestEnv,
  type TestEnv,
} from './helpers.js';
import { AUTH_LOGIN_EMAIL_MAX } from '../src/routes/auth.js';

let env: TestEnv;

beforeAll(async () => {
  env = await setupTestEnv();
}, 60_000);

afterAll(async () => {
  if (env) await teardownTestEnv(env);
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('missing set-cookie');
  return value.split(';')[0]!;
}

describe('auth routes', () => {
  it('registers a user, returns /me, and logs out', async () => {
    const register = await env.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse',
        name: 'Owner',
      }),
    });
    expect(register.statusCode).toBe(200);
    expect(register.json().user.email).toBe('owner@example.com');
    const cookie = cookieFrom(register);

    const me = await env.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.name).toBe('Owner');

    const logout = await env.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await env.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('rejects duplicate email and bad passwords', async () => {
    const duplicate = await env.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse',
        name: 'Owner Again',
      }),
    });
    expect(duplicate.statusCode).toBe(409);

    const badLogin = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        password: 'wrong password',
      }),
    });
    expect(badLogin.statusCode).toBe(401);
  });

  it('logs in with a password and can update the profile', async () => {
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse',
      }),
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);

    const update = await env.app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Renamed Owner' }),
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().user.name).toBe('Renamed Owner');
  });

  it('reports configured OAuth providers', async () => {
    const providers = await env.app.inject({
      method: 'GET',
      url: '/api/auth/providers',
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json().providers).toEqual([]);
    // When the lockdown switch is on (default), the response should advertise
    // `allowRegistration: true`. The lockdown-specific assertions live in
    // `registration-lockdown.test.ts`.
    expect(providers.json().allowRegistration).toBe(true);
  });

  it('lets admins create, disable, and re-enable users', async () => {
    const adminLogin = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse',
      }),
    });
    const adminCookie = cookieFrom(adminLogin);

    const created = await env.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'managed@example.com',
        password: 'correct horse',
        name: 'Managed User',
        role: 'user',
      }),
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id;

    const list = await env.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().users.some((u: { email: string }) => u.email === 'managed@example.com')).toBe(true);

    const disabled = await env.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${userId}`,
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ disabled: true }),
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().user.disabledAt).toBeTruthy();

    const enabled = await env.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${userId}`,
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ disabled: false, role: 'admin' }),
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().user.role).toBe('admin');
    expect(enabled.json().user.disabledAt).toBeNull();
  });

  it('rate limits repeated failed login attempts by email', async () => {
    for (let i = 0; i < AUTH_LOGIN_EMAIL_MAX; i++) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'rate-limit@example.com',
          password: 'wrong password',
        }),
      });
      expect(res.statusCode).toBe(401);
    }

    const limited = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'rate-limit@example.com',
        password: 'wrong password',
      }),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('ERATELIMIT');
  });
});
