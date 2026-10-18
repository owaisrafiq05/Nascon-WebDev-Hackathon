import { expect, test } from '@playwright/test';

import { createLead, signUp } from './helpers.js';

/**
 * P5 smoke flow: a figure counts what happened, its drill-down opens the same
 * records (F5.2, F5.3), and a hidden tile stays hidden after a reload because
 * the preference is stored on the server (F5.5).
 */
test('a tile counts new leads and drills into them (F5.1, F5.3)', async ({ page }) => {
  await signUp(page, 'Dashboard Co');

  await page.goto('/leads');
  await createLead(page, 'Counted');

  await page.goto('/');
  await expect(page.getByText('Whole company')).toBeVisible();

  const tile = page
    .getByRole('article')
    .filter({ has: page.getByRole('link', { name: 'New leads today' }) });
  await expect(tile.getByText('1', { exact: true })).toBeVisible();

  await tile.getByRole('link', { name: 'New leads today' }).click();
  await expect(page).toHaveURL(/\/leads\?.*createdFrom=/);
  await expect(page.getByText('Status: Waiting for acknowledgement')).toBeVisible();
});

test('a hidden tile stays hidden after a reload (F5.5)', async ({ page }) => {
  await signUp(page, 'Prefs Co');

  await expect(page.getByRole('link', { name: 'Recovery queue' })).toBeVisible();

  await page.getByRole('button', { name: 'Customize' }).click();
  // Not `uncheck()`: the box follows the server's answer, which lands a moment
  // after the click, so wait for the settled state instead.
  const box = page.getByRole('checkbox', { name: 'Recovery queue' });
  await box.click();
  await expect(box).not.toBeChecked();
  await expect(page.getByText('Dashboard saved.')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Whole company')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Recovery queue' })).toHaveCount(0);
});
