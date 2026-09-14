import type { Page } from "@playwright/test";
import { createDisposableAccount, generateMagicLink, seedProSubscription, type DisposableAccount } from "./backendAdmin";

const REDIRECT_URL = "http://localhost:5173/";

/** Creates a disposable account and logs the given page into it via a real
 *  admin-generated magic link -- same mechanism generate-test-login-link.ts
 *  already uses for manual UI checks. One account per spec FILE (not one
 *  shared across the whole suite): each spec's beforeEach/afterEach calls
 *  this and deleteDisposableAccount independently.
 *
 *  Moved off the earlier shared-global-account design (2026-09-14) now
 *  that the suite has grown past two specs -- a shared account was already
 *  flagged as risking the free-tier rate limit (60 req/min) as more specs
 *  landed, and one of the new specs needs its OWN paid-tier subscription
 *  row, which must not leak into the other specs' free-tier assumptions.
 *
 *  Every account gets a "pro" subscription seeded BEFORE first login, not
 *  just the specs that need a paid tier for their own feature (recurring
 *  schedules). Found by running draft-promote.spec.ts and reading the real
 *  network log: a single fresh account's first Dashboard page load alone
 *  fires 20-30+ authenticated API calls (React StrictMode double-invokes
 *  effects in dev), which got a real 429 on the free tier's 60 req/min
 *  ceiling -- on the very first page load, before the spec did anything.
 *  Seeding the subscription first means even that first load already
 *  resolves to "pro"'s 300 req/min via resolveTier() (backend/src/tier.ts).
 */
export async function loginAsDisposableAccount(page: Page): Promise<DisposableAccount> {
  const account = await createDisposableAccount();
  await seedProSubscription(account.accountId);

  // Set before any navigation, not after -- addInitScript runs on every
  // document load in this page, so both flags are already in localStorage
  // before Dashboard.tsx's own mount-time checks ever run, rather than
  // racing a post-hoc page.evaluate() against them. The Google Calendar
  // prompt was found the hard way: it popped up mid-interaction in
  // recurring-schedule.spec.ts and silently absorbed a later click meant
  // for the actual form, same class of issue as the product tour overlay.
  await page.addInitScript(() => {
    localStorage.setItem("lazyrelay_tour_seen", "1");
    localStorage.setItem("lazyrelay_gcal_prompt_seen", "1");
  });

  const link = await generateMagicLink(account.email, REDIRECT_URL);
  // Not logging `link` -- it's a real, single-use auth token URL, even
  // though it's local-only and consumed immediately below.
  await page.goto(link);
  // Confirm the session actually landed, not just that the redirect
  // happened -- the dashboard's tab bar only renders once AuthContext has
  // a session.
  await page.getByRole("button", { name: "Posts", exact: true }).waitFor({ state: "visible", timeout: 15000 });

  // A fresh browser context always shows the cookie-consent banner (found
  // running draft-promote.spec.ts -- it sat over part of the page and,
  // worse, its own presence was a symptom of not handling it at all).
  // "Reject Non-Essential" matches this project's own standing privacy
  // rule (decline non-essential by default) and gets it off screen before
  // any spec starts clicking things underneath where it sits.
  const rejectButton = page.getByRole("button", { name: "Reject Non-Essential", exact: true });
  if (await rejectButton.isVisible().catch(() => false)) {
    await rejectButton.click();
  }

  return account;
}
