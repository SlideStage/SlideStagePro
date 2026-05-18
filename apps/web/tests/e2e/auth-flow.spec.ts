import { test, expect } from '@playwright/test';

test('registers, persists session across reload, updates profile, and logs out', async ({
  page,
}) => {
  const stamp = Date.now();
  const email = `auth-${stamp}@example.com`;
  const password = 'correct horse';

  await page.goto('/register');
  await page.getByTestId('register-name').fill('Auth User');
  await page.getByTestId('register-email').fill(email);
  await page.getByTestId('register-password').fill(password);
  await page.getByTestId('register-submit').click();
  await expect(page).toHaveURL(/\/decks$/);
  await expect(page.getByText('Auth User')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Auth User')).toBeVisible();

  await page.goto('/profile');
  await page.getByTestId('profile-name').fill('Renamed Auth User');
  await page.getByTestId('profile-save').click();
  await expect(page.getByText('Profile updated')).toBeVisible();
  await expect(page.getByText('Renamed Auth User')).toBeVisible();

  await page.getByTestId('logout-button').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/decks');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/decks$/);
  await expect(page.getByText('Renamed Auth User')).toBeVisible();
});
