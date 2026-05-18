import type { APIRequestContext, BrowserContext } from '@playwright/test';
import { API_BASE } from './test-env.js';

export interface E2EAuth {
  user: { id: string; email: string; name: string };
  cookie: string;
}

export async function loginE2EUser(
  context: BrowserContext,
  request: APIRequestContext,
  key: string,
): Promise<E2EAuth> {
  const email = `${key}@e2e.local`;
  const password = 'correct horse';
  const name = key;
  let res = await request.post(`${API_BASE}/api/auth/login`, {
    headers: { 'content-type': 'application/json' },
    data: { email, password },
  });
  if (res.status() === 401) {
    res = await request.post(`${API_BASE}/api/auth/register`, {
      headers: { 'content-type': 'application/json' },
      data: { email, password, name },
    });
  }
  if (res.status() === 409) {
    res = await request.post(`${API_BASE}/api/auth/login`, {
      headers: { 'content-type': 'application/json' },
      data: { email, password },
    });
  }
  if (!res.ok()) {
    throw new Error(`auth setup failed: ${res.status()} ${await res.text()}`);
  }
  const setCookie = res.headers()['set-cookie'];
  if (!setCookie) throw new Error('auth setup missing set-cookie');
  const cookie = setCookie.split(';')[0]!;
  const [namePart, valuePart] = cookie.split('=');
  if (!namePart || !valuePart) throw new Error('malformed auth cookie');
  await context.addCookies([
    {
      name: namePart,
      value: valuePart,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const body = (await res.json()) as { user: E2EAuth['user'] };
  return { user: body.user, cookie };
}
