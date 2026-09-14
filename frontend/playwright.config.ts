import { defineConfig, devices } from "@playwright/test";

// On-demand only (Werner's call, 2026-09-14) -- deliberately NOT wired into
// ci.yml. These tests log a real browser into a real, disposable account
// against the real production Supabase project (there's no separate
// staging environment for either app), so an unattended job creating and
// deleting production rows on every push isn't something to default into.
// Run with `npm run test:e2e` when you actually want to check these flows.
//
// Each spec file creates and logs into its OWN disposable account (see
// fixtures/auth.ts's loginAsDisposableAccount) -- changed 2026-09-14 from
// an earlier shared-account design once the suite grew past two specs.
// The shared account had a real, confirmed problem: the backend's
// tieredRateLimit gives the free tier 60 requests/minute PER ACCOUNT
// (backend/src/http/rateLimit.ts), and two spec files' worth of page
// loads could land right at that ceiling in the same window. Per-file
// accounts also matter for a second reason now: the recurring-schedule
// spec needs its own paid-tier subscription row, which must not leak into
// the other specs' free-tier assumptions. With no state shared between
// files, parallel workers are safe again -- Playwright's own default.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      command: "npm run dev",
      cwd: "../backend",
      url: "http://localhost:3000/health",
      reuseExistingServer: true,
      timeout: 60000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60000,
    },
  ],
});
