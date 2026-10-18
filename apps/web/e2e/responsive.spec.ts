import { expect, test, type Page } from '@playwright/test';

import { createLead, signUp } from './helpers.js';

/**
 * Q7 and Q8 sweep: every signed-in screen at 360px, 768px and 1280px, checking
 * that the page itself never scrolls sideways (tables may scroll inside their
 * own container) and that every form control and button has an accessible
 * name. A screen that fails names itself in the assertion message.
 */
const WIDTHS = [360, 768, 1280] as const;

const ROUTES = [
  '/',
  '/leads',
  '/leads/manage',
  '/recovery',
  '/contacts',
  '/pipeline',
  '/lists',
  '/conversations',
  '/payments',
  '/appointments',
  '/integrations',
  '/configuration',
  '/team',
  '/audit',
  '/settings',
];

/** Waits for the page's own loading states to finish. */
async function settle(page: Page): Promise<void> {
  // Not `networkidle`: the realtime socket keeps the network busy.
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Controls a screen reader would announce without a name. */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const visible = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const named = (el: Element): boolean => {
      if ((el.getAttribute('aria-label') ?? '').trim() !== '') return true;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy !== null && labelledBy.trim() !== '') return true;
      if ('labels' in el) {
        const labels = (el as HTMLInputElement).labels;
        if (labels !== null && labels.length > 0) return true;
      }
      return (el.getAttribute('title') ?? '').trim() !== '';
    };
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (el.getAttribute('type') === 'hidden' || !visible(el)) continue;
      if (!named(el)) problems.push(el.outerHTML.slice(0, 120));
    }
    for (const el of document.querySelectorAll('button, a[href]')) {
      if (!visible(el)) continue;
      if ((el.textContent ?? '').trim() === '' && !named(el)) {
        problems.push(el.outerHTML.slice(0, 120));
      }
    }
    return problems;
  });
}

for (const width of WIDTHS) {
  test(`every screen fits ${String(width)}px and names its controls (Q7, Q8)`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signUp(page, `Sweep ${String(width)} Co`);

    // Something on the lists, so rows are measured as well as empty states.
    await page.goto('/leads');
    await createLead(page, 'Sweep');

    await page.goto('/contacts');
    await page.getByRole('button', { name: 'New contact' }).click();
    const form = page.getByRole('region', { name: 'New contact' });
    await form.getByLabel('First name').fill('Wide');
    await form.getByLabel('Last name').fill('Contact');
    await form.getByRole('button', { name: 'Save contact' }).click();
    await page.getByRole('link', { name: 'Wide Contact' }).click();
    await expect(page).toHaveURL(/\/contacts\/[a-f0-9]+/);
    const contactPath = new URL(page.url()).pathname;

    for (const route of [...ROUTES, contactPath]) {
      await page.goto(route);
      await settle(page);
      expect(
        await horizontalOverflow(page),
        `${route} scrolls sideways at ${String(width)}px`,
      ).toBeLessThanOrEqual(0);
      expect(await unnamedControls(page), `${route} has unnamed controls`).toEqual([]);
    }
  });
}
