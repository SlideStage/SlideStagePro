/**
 * Landing page — public-facing entry at `/`.
 *
 * Covers the ui-ux-pro-max "Minimal Single Column" pattern shipped in
 * `apps/web/src/pages/LandingPage.tsx`:
 *
 *   1. Unauthenticated visitor sees the hero, the product preview, all three
 *      benefit cards and both CTA surfaces.
 *   2. Top-bar "Sign up" + hero "Get started" both deep-link into `/register`
 *      (when the registration switch is on).
 *   3. Top-bar "Log in" deep-links into `/login`.
 *   4. Under registration lockdown (`allowRegistration: false`), the hint
 *      copy swaps to "Sign-ups are closed on this instance." and the primary
 *      CTA bounces to `/login` instead of `/register`.
 *   5. An authenticated visitor at `/` is bounced to `/decks` (the previous
 *      index redirect contract is preserved end-to-end).
 *
 * (5) reuses the existing `loginE2EUser` helper so it shares the e2e backend
 * with the rest of the suite. (1)-(4) use `page.route` to stub
 * `/api/auth/providers` + `/api/auth/me`, exactly like
 * `registration-lockdown.spec.ts`, so the spec doesn't depend on the
 * backend's `AUTH_ALLOW_REGISTRATION` value.
 */

import { test, expect, type Page } from '@playwright/test';
import { loginE2EUser } from './auth-helper.js';

async function stubAuth(
  page: Page,
  opts: { allowRegistration: boolean },
): Promise<void> {
  await page.route('**/api/auth/providers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [],
        allowRegistration: opts.allowRegistration,
      }),
    }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ user: null }),
    }),
  );
}

test('shows hero, benefits, preview and a working register CTA when sign-ups are open', async ({
  page,
}) => {
  await stubAuth(page, { allowRegistration: true });
  await page.goto('/');

  await expect(page.getByTestId('landing-page')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /Host, present, and annotate/i }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', {
      name: /slidestage presenter interface preview/i,
    }),
  ).toBeVisible();

  // Three benefit cards (titles are h2s inside the .landing-benefits grid).
  await expect(
    page.getByRole('heading', { name: 'Presenter tools, not slideware' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Edit notes, export the deck' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Self-hosted by design' }),
  ).toBeVisible();

  // Top-bar "Sign up" deep-links to /register.
  await page.getByTestId('landing-register').click();
  await expect(page).toHaveURL(/\/register$/);

  await page.goto('/');
  await page.getByTestId('landing-cta-primary').click();
  await expect(page).toHaveURL(/\/register$/);

  await page.goto('/');
  await page.getByTestId('landing-login').click();
  await expect(page).toHaveURL(/\/login$/);
});

test('swaps copy and CTA under registration lockdown', async ({ page }) => {
  await stubAuth(page, { allowRegistration: false });
  await page.goto('/');

  await expect(page.getByTestId('landing-page')).toBeVisible();
  // Top-bar "Sign up" disappears entirely.
  await expect(page.getByTestId('landing-register')).toHaveCount(0);
  // The hint paragraph swaps to the lockdown copy.
  await expect(
    page.getByTestId('landing-registration-disabled'),
  ).toContainText(/sign-ups are closed/i);
  // Primary CTA reads "Sign in" and bounces to /login.
  await page.getByTestId('landing-cta-primary').click();
  await expect(page).toHaveURL(/\/login$/);
});

test('redirects authenticated visitors at `/` to the deck library', async ({
  page,
  request,
}) => {
  await loginE2EUser(page.context(), request, 'landing-tester');
  await page.goto('/');
  await expect(page).toHaveURL(/\/decks$/);
});
