import { test, expect } from "@playwright/test";
import { seedSocialAccount, deleteDisposableAccount, type DisposableAccount } from "./fixtures/backendAdmin";
import { loginAsDisposableAccount } from "./fixtures/auth";

// Real end-to-end proof of the rule tiktokDisclosure.test.ts already covers
// in isolation (unit-tested against isTiktokDisclosureIncomplete() directly)
// -- this drives the actual rendered UI, seeding a fake TikTok connection
// the same way compose-and-schedule.spec.ts seeds Mastodon, since real
// TikTok OAuth can't be automated here.
const HOVER_TEXT = "You need to indicate if your content promotes yourself, a third party, or both.";

test.describe("TikTok commercial-disclosure gate", () => {
  const displayName = `E2E TikTok ${Date.now()}`;
  let account: DisposableAccount;

  // One disposable account per spec FILE -- see fixtures/auth.ts.
  test.beforeEach(async ({ page }) => {
    account = await loginAsDisposableAccount(page);
    await seedSocialAccount(account.accountId, "tiktok", displayName);
    await page.reload();
  });

  test.afterEach(async () => {
    await deleteDisposableAccount(account.accountId);
  });

  test("locks Schedule/Post Now until a disclosure option is picked, unlocks once one is", async ({ page }) => {
    await page.getByRole("button", { name: "Posts", exact: true }).click();

    // Same scoping as compose-and-schedule.spec.ts: .schedule-form is
    // shared by three forms on this tab, and the outer "Post to" label
    // wraps both the search box and every checkbox (its computed
    // accessible name matches more than just the checkbox), so this uses
    // an unambiguous heading-based form scope and role-based checkbox
    // lookups throughout.
    const form = page.locator('h2:text-is("Schedule a one-time post") + form');

    await form.getByPlaceholder("Search connected accounts...").fill(displayName);
    await form.getByRole("checkbox", { name: displayName }).check();

    await form.getByLabel("Content", { exact: true }).fill(`E2E TikTok disclosure test ${Date.now()}`);
    await form.getByLabel(/Who can view this on TikTok/).selectOption("PUBLIC_TO_EVERYONE");

    // Toggle on, neither option ticked -- the real bug the whole feature exists to prevent.
    await form.getByRole("checkbox", { name: "Disclose commercial content" }).check();
    await expect(form.getByText(HOVER_TEXT)).toBeVisible();
    await expect(form.getByRole("button", { name: "Schedule", exact: true })).toBeDisabled();
    await expect(form.getByRole("button", { name: "Post Now", exact: true })).toBeDisabled();

    // Tick "Your Brand" -- disclosure is now complete, both buttons unlock.
    await form.getByRole("checkbox", { name: "Your Brand — promoting yourself or your own business" }).check();
    await expect(form.getByText(HOVER_TEXT)).not.toBeVisible();
    await expect(form.getByRole("button", { name: "Schedule", exact: true })).toBeEnabled();
    await expect(form.getByRole("button", { name: "Post Now", exact: true })).toBeEnabled();
  });
});
