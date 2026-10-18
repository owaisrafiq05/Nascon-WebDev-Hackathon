import { expect, type Page } from '@playwright/test';

/** Shared steps for the smoke flows. Each flow signs up its own workspace. */
export const PASSWORD = 'correct-horse-battery-staple';

/** A fresh address per run, because sign-up refuses a duplicate. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/** Signs up a new workspace through the interface and waits for the shell. */
export async function signUp(page: Page, company: string): Promise<string> {
  const email = uniqueEmail('owner');
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Smoke Owner');
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  // The layout may show the workspace name more than once (sidebar and header).
  await expect(page).not.toHaveURL(/sign-up/);
  await expect(page.getByText(company).filter({ visible: true }).first()).toBeVisible();
  return email;
}

/**
 * Creates a lead from the Leads page's manual entry form (F3.1) and returns
 * the confirmation, which names the reason when nobody could take it (F3.7).
 */
export async function createLead(page: Page, firstName: string): Promise<string> {
  const form = page.getByRole('region', { name: 'New lead' });
  await form.getByLabel('First name').fill(firstName);
  await form.getByRole('button', { name: 'Create lead' }).click();
  const status = form.getByRole('status');
  await expect(status).toBeVisible();
  return (await status.textContent()) ?? '';
}
