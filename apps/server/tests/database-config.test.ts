import { afterEach, describe, expect, it } from 'vitest';
import {
  setupTestEnv,
  teardownTestEnv,
  type TestEnv,
} from './helpers.js';

let env: TestEnv | null = null;

afterEach(async () => {
  if (env) {
    await teardownTestEnv(env);
    env = null;
  }
});

describe('database configuration', () => {
  it('uses injected config.databaseUrl instead of ambient DATABASE_URL', async () => {
    env = await setupTestEnv({ mismatchAmbientDatabaseUrl: true });

    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'config-db@example.com',
        password: 'correct horse',
        name: 'Config DB',
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('config-db@example.com');
  });
});
