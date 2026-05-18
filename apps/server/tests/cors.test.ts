import { afterEach, describe, expect, it } from 'vitest';
import { setupTestEnv, teardownTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv | null = null;

afterEach(async () => {
  if (env) {
    await teardownTestEnv(env);
    env = null;
  }
});

describe('credentialed CORS', () => {
  it('allows only the configured web origin when dev origins are disabled', async () => {
    env = await setupTestEnv({
      webOrigin: 'https://slides.example.test',
      corsAllowDevOrigins: false,
    });

    const allowed = await env.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://slides.example.test' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://slides.example.test',
    );

    const rejected = await env.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:9999' },
    });
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows alternate localhost ports only when dev origins are enabled', async () => {
    env = await setupTestEnv({
      webOrigin: 'https://slides.example.test',
      corsAllowDevOrigins: true,
    });

    const res = await env.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://127.0.0.1:5174' },
    });
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:5174',
    );
  });
});
