import { test, expect } from "@playwright/test";
import { seedSocialAccount, deleteDisposableAccount, type DisposableAccount } from "./fixtures/backendAdmin";
import { loginAsDisposableAccount } from "./fixtures/auth";

// Real OAuth (Meta, TikTok, etc.) can't be driven from a browser test --
// it goes through the actual platform's own login screens. So the
// realistic scope here is: seed a connected account directly (bypassing
// OAuth, same technique backend/src/test-account-limits.ts already uses),
// then drive the real compose-and-schedule UI end to end. Mastodon is the
// platform (not TikTok -- that's tiktok-disclosure.spec.ts, which needs
// its own extra fields). "Schedule" is used deliberately, never "Post
// Now" -- scheduling only writes a pending row; Post Now would actually
// attempt to publish to the real Mastodon API with a fake token.
test.describe("Compose and schedule a post", () => {
  const displayName = `E2E Mastodon ${Date.now()}`;
  let account: DisposableAccount;

  // One disposable account per spec FILE, not shared across the suite --
  // see fixtures/auth.ts's own doc comment for why this changed.
  test.beforeEach(async ({ page }) => {
    account = await loginAsDisposableAccount(page);
    await seedSocialAccount(account.accountId, "mastodon", displayName);
    await page.reload();
  });

  test.afterEach(async () => {
    await deleteDisposableAccount(account.accountId);
  });

  test("schedules a post to a connected account and it appears under Upcoming", async ({ page }) => {
    await page.getByRole("button", { name: "Posts", exact: true }).click();

    // Two other forms on this tab share the same .schedule-form class (the
    // Bio Page form and the recurring-schedule form both reuse it, found by
    // running this test and hitting a strict-mode violation) -- the CSS
    // adjacent-sibling selector is what's actually unique: the one-time
    // form is the element immediately after this specific heading.
    const form = page.locator('h2:text-is("Schedule a one-time post") + form');

    // AccountPicker's platform groups start closed; searching force-opens
    // whichever group matches, so this is more robust than clicking the
    // Mastodon group header directly.
    await form.getByPlaceholder("Search connected accounts...").fill(displayName);
    // Not getByLabel(displayName): the outer "Post to" label wraps both the
    // search box and every checkbox, so its computed accessible name picks
    // up the rendered search results too and matches more than one element.
    await form.getByRole("checkbox", { name: displayName }).check();

    const postContent = `E2E scheduled post ${Date.now()}`;
    await form.getByLabel("Content", { exact: true }).fill(postContent);

    // DateTimePicker's trigger/day/chip/Apply buttons are all wrapped by
    // the outer "When to post" <label> -- <button> is a labelable element,
    // so the browser replaces each one's accessible name with the label's
    // text instead of its own ("Pick a date and time" -> just "When to
    // post"), found by running this and getting a role/name timeout. CSS
    // classes from DateTimePicker.tsx's own source sidestep that entirely.
    await form.locator(".datetime-picker-trigger").click();
    await pickTomorrow(form);
    await form.locator(".datetime-picker-suggested-chip", { hasText: "Evening" }).click();
    await form.locator(".datetime-picker-actions").getByText("Apply", { exact: true }).click();

    await form.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(page.getByText(postContent)).toBeVisible({ timeout: 15000 });
  });
});

/** Clicks tomorrow's day cell in the DateTimePicker's calendar grid,
 *  navigating to next month first if today is the last day of the month. */
async function pickTomorrow(form: import("@playwright/test").Locator) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getMonth() !== now.getMonth()) {
    await form.locator(".datetime-picker-month-nav").getByText("→", { exact: true }).click();
  }
  await form.locator(".datetime-picker-grid").getByText(String(tomorrow.getDate()), { exact: true }).click();
}
