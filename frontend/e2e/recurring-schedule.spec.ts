import { test, expect } from "@playwright/test";
import { seedSocialAccount, deleteDisposableAccount, type DisposableAccount } from "./fixtures/backendAdmin";
import { loginAsDisposableAccount } from "./fixtures/auth";

// A distinct form/code path from the one-time compose flow
// (compose-and-schedule.spec.ts): recurring schedules are gated by plan
// tier (free: 0 slots, "pro"/Starter: 3 -- backend/src/tier.ts). Every E2E
// account already gets a "pro" subscription seeded by loginAsDisposableAccount
// (fixtures/auth.ts) -- originally added just for the rate-limit ceiling,
// it also happens to be exactly the tier this spec needs, so nothing
// extra to seed here.
test.describe("Recurring schedule", () => {
  const displayName = `E2E Mastodon RS ${Date.now()}`;
  let account: DisposableAccount;

  test.beforeEach(async ({ page }) => {
    account = await loginAsDisposableAccount(page);
    await seedSocialAccount(account.accountId, "mastodon", displayName);
    await page.reload();
  });

  test.afterEach(async () => {
    await deleteDisposableAccount(account.accountId);
  });

  test("creates a weekly recurring schedule and it shows as Active", async ({ page }) => {
    await page.getByRole("button", { name: "Posts", exact: true }).click();

    // The form isn't h2's immediate sibling -- a <p className="muted">
    // description sits between the heading and the form -- so this walks
    // to the first following <form>, not just the next element.
    const form = page.locator('h2:text-is("Recurring schedules")').locator("xpath=following-sibling::form[1]");

    await form.getByPlaceholder("Search connected accounts...").fill(displayName);
    await form.getByRole("checkbox", { name: displayName }).check();

    const content = `E2E recurring content ${Date.now()}`;
    await form.getByLabel("Content", { exact: true }).fill(content);

    // DayOfWeekPicker's chips are wrapped by the outer "Days of the week"
    // <label> -- same accessible-name-override issue DateTimePicker's
    // buttons had (button is a labelable element), so this uses the
    // component's own CSS class instead of role+name.
    await form.locator(".day-of-week-chip", { hasText: "Mon" }).click();

    // TimeOfDayPicker isn't wrapped in an outer label here, but using its
    // own class keeps this consistent with the rest of the suite rather
    // than relying on accessible-name computation working out.
    await form.locator(".datetime-picker-suggested-chip", { hasText: "Evening" }).click();

    await form.getByRole("button", { name: "Create recurring schedule", exact: true }).click();

    // submitRecurringSchedule awaits a full refresh() (~15 parallel API
    // calls against real production Supabase) BEFORE clearing rsSubmitting
    // -- found by hitting a real, reproducible flake on the very next
    // assertion, which used Playwright's default 5s timeout while this one
    // already had 15s. Not a logic bug, just an inconsistent timeout for
    // how long a real refresh can take; every assertion here gets the same
    // generous window now. resetRsForm() clears the content field on
    // success, so once this resolves, the only place this text can render
    // is the new list item.
    await expect(page.getByText(content)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Active", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Mon at 18:00", { exact: false })).toBeVisible({ timeout: 15000 });
  });
});
