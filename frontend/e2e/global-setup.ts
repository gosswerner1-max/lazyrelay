import { chromium, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupStaleFixtures, createDisposableAccount, generateMagicLink } from "./fixtures/backendAdmin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_DIR = path.resolve(__dirname, ".auth");
export const STORAGE_STATE_PATH = path.join(AUTH_DIR, "user.json");
export const ACCOUNT_INFO_PATH = path.join(AUTH_DIR, "account.json");

// Runs once before the whole E2E suite: creates one disposable account
// (real production Supabase, same as every manual QA session today — no
// separate staging project exists), logs a real browser into it via the
// same admin-generated magic-link mechanism generate-test-login-link.ts
// already uses for manual UI checks, and saves the resulting session so
// every spec file reuses it instead of each logging in separately.
export default async function globalSetup(_config: FullConfig) {
  await cleanupStaleFixtures();

  const { accountId, email } = await createDisposableAccount();

  // redirectTo needs a trailing slash to match the "http://localhost:5173/**"
  // allowlist entry added to Supabase Auth's redirect-URL config 2026-09-14
  // — a bare "http://localhost:5173" (no slash) doesn't match that pattern
  // and Supabase silently falls back to the production Site URL instead,
  // found by inspecting the actual generated action_link's redirect_to.
  const baseURL = "http://localhost:5173/";
  const link = await generateMagicLink(email, baseURL);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Not logging `link` -- it's a real, single-use auth token URL, even
  // though it's local-only and consumed immediately below.
  await page.goto(link);
  // Confirm the session actually landed, not just that the redirect happened
  // — the dashboard's tab bar only renders once AuthContext has a session.
  await page.getByRole("button", { name: "Posts", exact: true }).waitFor({ state: "visible", timeout: 15000 });

  // Every disposable account is brand new, so react-joyride's product tour
  // (Dashboard.tsx's runTour) would otherwise auto-start and its overlay
  // blocks every click underneath it -- found by running the suite for
  // real and hitting "subtree intercepts pointer events" on every click.
  // Setting the same localStorage key handleTourFinish sets is simpler and
  // more reliable than clicking through six tour steps in every spec.
  await page.evaluate(() => localStorage.setItem("lazyrelay_tour_seen", "1"));

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE_PATH });
  fs.writeFileSync(ACCOUNT_INFO_PATH, JSON.stringify({ accountId, email }, null, 2));

  await browser.close();
}
