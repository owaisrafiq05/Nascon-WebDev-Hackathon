import { expect, test } from '@playwright/test';

/**
 * P2's smoke flow: sign up, invite a colleague, read the audit log (F1.1, F1.2,
 * F4.2).
 *
 * Driven entirely through the interface, with no direct database access, so it
 * exercises what a person actually does.
 */
const PASSWORD = 'correct-horse-battery-staple';

/** A fresh address per run, because sign-up refuses a duplicate. */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

test('an owner can sign up, invite a colleague and read the audit log', async ({ page }) => {
  const ownerEmail = uniqueEmail('owner');
  const inviteeEmail = uniqueEmail('invitee');

  // --- Sign up creates the workspace and makes this person its Owner (F1.1)
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();

  await page.getByLabel('Your name').fill('Smoke Owner');
  await page.getByLabel('Company name').fill('Smoke Test Co');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create workspace' }).click();

  // Landed signed in, with the workspace shown in the header.
  await expect(page.getByText('Smoke Test Co')).toBeVisible();
  await expect(page.getByText(ownerEmail)).toBeVisible();

  // --- A refresh keeps the session (F1.1)
  await page.reload();
  await expect(page.getByText('Smoke Test Co')).toBeVisible();

  // --- Invite a colleague (F1.2)
  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();

  // Scoped to the invite form: the members list has a Level control per row.
  const inviteForm = page.getByRole('region', { name: 'Invite someone' });
  await inviteForm.getByLabel('Email').fill(inviteeEmail);
  await inviteForm.getByLabel('Level').selectOption('user');
  await inviteForm.getByRole('button', { name: 'Send invitation' }).click();

  await expect(page.getByRole('status')).toContainText(`Invitation created for ${inviteeEmail}`);
  await expect(page.getByRole('heading', { name: 'Pending invitations' })).toBeVisible();
  await expect(page.getByText(inviteeEmail).first()).toBeVisible();

  // --- The audit log records it and the Owner can read it (F4.1, F4.2)
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table).toContainText('user.invited');
  await expect(table).toContainText(inviteeEmail);
  await expect(table).toContainText(ownerEmail);

  // Filtering by type narrows it down (F4.2).
  await page.getByLabel('Event type').selectOption('user.invited');
  await expect(table).toContainText('user.invited');
  await expect(table).not.toContainText('user.role_changed');

  // --- Signing out ends the session (Q1)
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The protected page is no longer reachable.
  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('the audit log is hidden from a member without the permission (F4.2)', async ({ page }) => {
  const ownerEmail = uniqueEmail('owner2');
  const memberEmail = uniqueEmail('member');

  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Smoke Owner');
  await page.getByLabel('Company name').fill('Hidden Audit Co');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('Hidden Audit Co')).toBeVisible();

  // Invite a plain User, who gets the seeded Member set without audit access.
  await page.getByRole('link', { name: 'Team' }).click();
  const inviteForm = page.getByRole('region', { name: 'Invite someone' });
  await inviteForm.getByLabel('Email').fill(memberEmail);
  await inviteForm.getByLabel('Level').selectOption('user');
  await inviteForm.getByRole('button', { name: 'Send invitation' }).click();

  const notice = page.getByRole('status');
  await expect(notice).toContainText(memberEmail);

  // Take the invitation link out of the notice and accept it.
  const link = await notice.getByRole('code').innerText();
  const token = new URL(link).searchParams.get('token');
  expect(token).toBeTruthy();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.goto(`/accept-invite?token=${String(token)}`);
  await page.getByLabel('Your name').fill('Smoke Member');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(memberEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Hidden Audit Co')).toBeVisible();

  // No navigation entry, and the route itself redirects away.
  await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toHaveCount(0);
});
