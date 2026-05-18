/**
 * Frontend-side behaviour of the registration lockdown.
 *
 * The shared e2e backend runs with `AUTH_ALLOW_REGISTRATION=true` so the
 * other specs keep working. To exercise the UI under lockdown we don't need
 * to bounce the server — every UI gate reads `auth.allowRegistration` from
 * `GET /api/auth/providers`. We stub that endpoint with `page.route` to make
 * the SPA believe the server is in lockdown mode, then assert:
 *
 *   1. `/register` redirects to `/login?error=registration-disabled` and the
 *      notice is rendered.
 *   2. The login page hides the "Create one" link in favor of the
 *      "managed by an administrator" copy.
 *   3. The shell header doesn't show the Register nav link.
 *
 * We never call `POST /api/auth/register` in this spec — that path is covered
 * by the vitest suite.
 */

import { test, expect, type Page } from '@playwright/test';

async function stubLockdown(page: Page): Promise<void> {
  await page.route('**/api/auth/providers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [], allowRegistration: false }),
    }),
  );
  await page.route('**/api/auth/me', (route) =>
    // No session in this spec — return 401 with `{ user: null }` shape.
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ user: null }),
    }),
  );
}

test('hides the register entry points and bounces /register to /login', async ({ page }) => {
  await stubLockdown(page);

  await page.goto('/login');
  await expect(
    page.getByTestId('login-registration-disabled'),
  ).toBeVisible();
  await expect(page.getByTestId('login-register-link')).toHaveCount(0);
  await expect(page.getByTestId('header-register-link')).toHaveCount(0);

  await page.goto('/register');
  await expect(page).toHaveURL(/\/login\?error=registration-disabled$/);
  await expect(page.getByTestId('login-notice')).toContainText(
    /registration is disabled/i,
  );
  await expect(
    page.getByTestId('login-registration-disabled'),
  ).toBeVisible();
});

test('reveals the register entry points when the switch is on', async ({ page }) => {
  // Stub the same endpoints but flip the flag — gives us a regression test for
  // the default ("open") UI without depending on backend ordering.
  await page.route('**/api/auth/providers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [], allowRegistration: true }),
    }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ user: null }),
    }),
  );

  await page.goto('/login');
  await expect(page.getByTestId('login-register-link')).toBeVisible();
  await expect(
    page.getByTestId('login-registration-disabled'),
  ).toHaveCount(0);
  await expect(page.getByTestId('header-register-link')).toBeVisible();
});
