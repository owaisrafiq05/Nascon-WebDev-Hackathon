import { defineConfig, devices } from '@playwright/test';

/**
 * One smoke flow per major module (CLAUDE.md). P2's flow is
 * sign up -> invite -> audit log.
 *
 * The web and API servers are **not** started here: they need a MongoDB replica
 * set, which belongs to the developer's environment rather than to a test
 * runner. Start them with `pnpm dev` (and `pnpm db:up`) and then run
 * `pnpm --filter @ubmp/web e2e`. The README says so, and the test fails with a
 * readable message if nothing is listening.
 */
export default defineConfig({
  testDir: './e2e',
  // A failing assertion is a real failure; retrying would hide a race.
  retries: 0,
  // Serial: the flows share one database.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    // 1280px. The 360px and 768px sweep belongs to P11's responsive pass.
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
});
