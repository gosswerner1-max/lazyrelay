import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This package is "type": "module", so no CommonJS __dirname global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// On-demand only (Werner's call, 2026-09-14) -- deliberately NOT wired into
// ci.yml. These tests log a real browser into a real, disposable account
// against the real production Supabase project (there's no separate
// staging environment for either app), so an unattended job creating and
// deleting production rows on every push isn't something to default into.
// Run with `npm run test:e2e` when you actually want to check these flows.
//
// Known real constraint, found by running this suite repeatedly rather
// than assumed: all specs share ONE disposable account (global-setup),
// and the backend's tieredRateLimit gives the free tier 60 requests/minute
// PER ACCOUNT (backend/src/http/rateLimit.ts). A full Dashboard page load
// fires well over a dozen API calls on its own, so two spec files' worth
// of page loads plus their interactions can land right at that ceiling
// within the same 60s window -- confirmed live: both specs pass every
// time run individually, but running the full suite back-to-back
// sometimes hits "Too many requests" on the second file. If more specs
// get added here, the real fix is giving each spec file its own
// disposable account (and its own login) instead of sharing one -- not
// done now, since a 2-spec suite doesn't yet justify that duplication.
// Separately worth flagging to Werner sometime: if two sequential
// automated page loads can approach this ceiling, a real free-tier
// customer clicking briskly through tabs might plausibly hit it too --
// that's a product question, not something to fix from here.
export default defineConfig({
  testDir: "./e2e",
  // One shared disposable account for the whole run (see global-setup) --
  // parallel workers would race on the same account's rows, so this stays
  // single-worker/sequential rather than Playwright's usual default.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",

  use: {
    baseURL: "http://localhost:5173",
    storageState: path.join(__dirname, "e2e/.auth/user.json"),
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
