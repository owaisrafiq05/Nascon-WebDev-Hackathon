import { expect, test } from '@playwright/test';

import { createLead, signUp } from './helpers.js';

/**
 * P4 and P5 smoke flow: a lead is created, assigned, shown with its
 * acknowledgement countdown, and acknowledged (F3.1, F3.3, F3.4). A second tab
 * receives the new lead live, without a reload (Q11).
 */
test('a lead is assigned, counts down and can be acknowledged (F3.3, F3.4)', async ({ page }) => {
  await signUp(page, 'Lead Flow Co');

  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();

  expect(await createLead(page, 'Ada')).toBe('Lead created and assigned.');

  // The owner is the only available member, so the lead is theirs, with a
  // countdown shown in words rather than colour alone.
  const inbox = page.getByRole('region', { name: 'My leads' });
  await expect(inbox.getByText('Status: Waiting for acknowledgement')).toBeVisible();
  await expect(inbox.getByText(/left|Overdue/)).toBeVisible();

  await inbox.getByRole('button', { name: /^Acknowledge lead from/ }).click();
  await expect(inbox.getByText('Lead acknowledged.')).toBeVisible();
  await expect(inbox.getByText('Status: Acknowledged')).toBeVisible();
  await expect(inbox.getByRole('button', { name: /^Acknowledge lead from/ })).toHaveCount(0);
});

test('a lead created in one tab appears in another without a reload (Q11)', async ({
  page,
  context,
}) => {
  await signUp(page, 'Realtime Co');
  await page.goto('/leads');

  // A second tab in the same session, watching the inbox.
  const watcher = await context.newPage();
  await watcher.goto('/leads');
  const watched = watcher.getByRole('region', { name: 'My leads' });
  await expect(watched.getByText('No leads match.')).toBeVisible();

  await createLead(page, 'Grace');

  // Arrives over the socket; the watcher never reloads.
  await expect(watched.getByText('Status: Waiting for acknowledgement')).toBeVisible();
});

test('changing availability is confirmed with what happened to open leads (F3.6)', async ({
  page,
}) => {
  await signUp(page, 'Availability Co');
  await page.goto('/leads');

  const card = page.getByRole('region', { name: 'My availability' });
  await card.getByLabel('My availability').selectOption('busy');
  await card.getByRole('button', { name: 'Update availability' }).click();
  await expect(card.getByRole('status')).toContainText('Availability updated.');

  // While busy, a new lead is not assigned to this member, and the reason is
  // shown in words a manager can act on (F3.7).
  expect(await createLead(page, 'Unassigned')).toBe('Nobody is Available right now.');
});
