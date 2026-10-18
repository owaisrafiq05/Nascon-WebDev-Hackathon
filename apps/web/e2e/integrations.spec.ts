import { expect, test } from '@playwright/test';

import { signUp } from './helpers.js';

/**
 * P6 to P10 smoke flow without provider credentials: every integration says
 * what it can and cannot do and that it is not connected (I5.1), and the
 * screens that depend on a provider stay usable and explain why an action
 * cannot happen instead of failing silently (I5.8, Q10).
 *
 * The provider paths themselves (signatures, idempotency, retries) are covered
 * by the server API tests against fakes; a live run needs sandbox credentials.
 */
test('the integrations page shows each provider, its limits and its status (I5.1)', async ({
  page,
}) => {
  await signUp(page, 'Integrations Co');

  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();

  for (const name of [
    'Messaging (Twilio WhatsApp sandbox or SMS)',
    'Payments (Stripe test mode)',
    'Calendar (Google Calendar, per employee)',
    'Notifications (Telegram bot)',
  ]) {
    const card = page.getByRole('region', { name });
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'What it can do' })).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Limits' })).toBeVisible();
  }

  const twilio = page.getByRole('region', { name: 'Messaging (Twilio WhatsApp sandbox or SMS)' });
  await expect(twilio.getByText('Not connected')).toBeVisible();

  await expect(page.getByRole('region', { name: 'Sync history' })).toBeVisible();
});

test('provider-backed screens stay usable without credentials (I5.8, Q10)', async ({ page }) => {
  await signUp(page, 'No Creds Co');

  await page.goto('/payments');
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  // Collected and projected are separate figures (I2.6).
  await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible();

  await page.goto('/conversations');
  await expect(page.getByRole('heading', { name: 'Conversations', level: 1 })).toBeVisible();

  await page.goto('/appointments');
  await expect(page.getByRole('heading', { name: 'Appointments', level: 1 })).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('region', { name: 'My calendar' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'My notifications' })).toBeVisible();

  // Messaging a contact without Twilio connected explains why it cannot send.
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'New contact' }).click();
  const form = page.getByRole('region', { name: 'New contact' });
  await form.getByLabel('First name').fill('Text');
  await form.getByLabel('Last name').fill('Me');
  await form.getByLabel('Phone').fill('+15555550123');
  await form.getByRole('button', { name: 'Save contact' }).click();
  await page.getByRole('link', { name: 'Text Me' }).click();

  await page.getByLabel('Send message').fill('Hello from the smoke test');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert').first()).toContainText(/not connected|Twilio/i);
});
