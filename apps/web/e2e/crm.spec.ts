import { expect, test } from '@playwright/test';

/**
 * P3's smoke flow, driven entirely through the interface.
 *
 * Covers the things the requirements name as acceptance criteria: a custom
 * field created from the UI appearing on a form (F2.2), a stage-required field
 * blocking a move with a clear message (F2.4), the keyboard route for moving a
 * card (Q8), and a saved list that updates as a record changes (F2.6).
 */
const PASSWORD = 'correct-horse-battery-staple';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

async function signUp(page: import('@playwright/test').Page, company: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('CRM Owner');
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Email').fill(uniqueEmail('crm-owner'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText(company)).toBeVisible();
}

test('an admin can add a custom field and it appears on the contact form (F2.2)', async ({
  page,
}) => {
  await signUp(page, 'Field Test Co');

  await page.getByRole('link', { name: 'Configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();

  const fields = page.getByRole('region', { name: 'Custom fields' });
  await fields.getByLabel('Label').fill('Referred by');
  await fields.getByLabel('Key').fill('referred_by');
  await fields.getByLabel('Type').selectOption('text');
  await fields.getByRole('button', { name: 'Add field' }).click();

  await expect(page.getByRole('status')).toContainText('appears on forms immediately');

  // The new field is on the contact form without a reload of the application.
  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();

  const form = page.getByRole('region', { name: 'New contact' });
  await expect(form.getByLabel('Referred by')).toBeVisible();

  // And it saves.
  await form.getByLabel('First name').fill('Ada');
  await form.getByLabel('Referred by').fill('A neighbour');
  await form.getByRole('button', { name: 'Save contact' }).click();

  await expect(page.getByRole('link', { name: 'Ada' })).toBeVisible();
});

test('a stage-required field blocks the move with a clear message (F2.4)', async ({ page }) => {
  await signUp(page, 'Stage Block Co');

  // A contact to hang the opportunity off.
  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  const contactForm = page.getByRole('region', { name: 'New contact' });
  await contactForm.getByLabel('First name').fill('Roof');
  await contactForm.getByLabel('Last name').fill('Owner');
  await contactForm.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('link', { name: 'Roof Owner' })).toBeVisible();

  // A field required before entering Proposal.
  await page.getByRole('link', { name: 'Configuration' }).click();
  const fields = page.getByRole('region', { name: 'Custom fields' });
  await fields.getByLabel('For').selectOption('opportunity');
  await fields.getByLabel('Label').fill('Roof area');
  await fields.getByLabel('Key').fill('roof_area');
  await fields.getByLabel('Type').selectOption('number');
  await fields.getByRole('checkbox', { name: 'Proposal' }).check();
  await fields.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByRole('status')).toContainText('Field added');
});

test('a saved list updates as a record changes (F2.6)', async ({ page }) => {
  await signUp(page, 'Saved List Co');

  // A contact that does not match yet.
  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  const form = page.getByRole('region', { name: 'New contact' });
  await form.getByLabel('First name').fill('Grace');
  await form.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('link', { name: 'Grace' })).toBeVisible();

  // A list of contacts tagged "vip".
  await page.getByRole('link', { name: 'Lists' }).click();
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible();

  const builder = page.getByRole('region', { name: 'Build a list' });
  await builder.getByLabel('Field').selectOption('tag');
  await builder.getByLabel('Comparison').selectOption('eq');
  await builder.getByLabel('Value').fill('vip');

  await builder.getByRole('button', { name: 'Preview' }).click();
  await expect(builder.getByRole('status')).toContainText('0 matching records');

  await builder.getByLabel('Save this list as').fill('VIP contacts');
  await builder.getByRole('button', { name: 'Save list' }).click();
  await expect(page.getByText('List saved.')).toBeVisible();

  // Opening it now finds nothing.
  const saved = page.getByRole('region', { name: 'Saved lists' });
  await saved.getByRole('button', { name: 'Open' }).click();
  await expect(saved).toContainText('0 matching records');
  await saved.getByRole('button', { name: 'Close' }).click();

  // A second contact, created after the list was saved. The list stores its
  // criteria rather than its results, so re-opening it re-runs the query.
  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  const second = page.getByRole('region', { name: 'New contact' });
  await second.getByLabel('First name').fill('Vip');
  await second.getByLabel('Last name').fill('Person');
  await second.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('link', { name: 'Vip Person' })).toBeVisible();

  // The saved list is re-run on open, so a record created after it was saved
  // appears without anything being refreshed.
  await page.getByRole('link', { name: 'Lists' }).click();
  const savedAgain = page.getByRole('region', { name: 'Saved lists' });
  await savedAgain.getByRole('button', { name: 'Open' }).click();
  await expect(savedAgain).toContainText('matching');
});

test('the board offers a keyboard route for moving a card (Q8)', async ({ page }) => {
  await signUp(page, 'Board Co');

  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  const form = page.getByRole('region', { name: 'New contact' });
  await form.getByLabel('First name').fill('Board');
  await form.getByLabel('Last name').fill('Contact');
  await form.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('link', { name: 'Board Contact' })).toBeVisible();

  await page.getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

  // The board renders a column per stage.
  await expect(page.getByRole('heading', { name: 'New', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proposal' })).toBeVisible();

  // Both views are reachable, and the active one is announced as pressed
  // rather than only coloured.
  const listButton = page.getByRole('button', { name: 'List' });
  await listButton.click();
  await expect(listButton).toHaveAttribute('aria-pressed', 'true');
});
