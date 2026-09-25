import "dotenv/config";
import { supabase } from "./supabase.js";
import { getStorageUsage, STORAGE_QUOTA_BYTES } from "./storageQuota.js";
import { syncSubscriptionFromWebhook, cancelStorageAddon } from "./billing/sync.js";
import { StubMorAdapter } from "./billing/stub.js";
import type { StorageAddonEvent } from "./billing/types.js";

// One-off smoke test — proves the storage add-on feature (2026-07-23) works
// end to end against the real Supabase project: a fresh Starter-tier account
// starts at the Starter quota, a simulated storage_addon webhook event grows
// the quota by the add-on's GB amount (not the tier's own quota), a second
// add-on stacks on top, and cancelling one add-on marks it cancel_at_period_end
// (2026-08-11 deferred-cancellation fix — the quota only drops later, when the
// real period-end webhook lands) without touching the other add-on or the
// account's main tier subscription.

const GB = 1024 * 1024 * 1024;
const morAdapter = new StubMorAdapter();

function fakeAddonEvent(overrides: Partial<StorageAddonEvent> = {}): StorageAddonEvent {
  return {
    kind: "storage_addon",
    morSubscriptionId: `sub_addon_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    accountEmail: "unset@lazyrelay.invalid",
    gbAmount: 5,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    occurredAt: new Date().toISOString(),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

async function main() {
  const email = `storage-addon-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  // Put the account on Starter ("pro") so add-on checkout would be allowed
  // (Free tier is blocked in routes.ts) and so the base quota is Starter's.
  await supabase.from("subscriptions").upsert(
    {
      account_id: accountId,
      mor_subscription_id: `sub_tier_test_${Date.now()}`,
      tier: "pro",
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );

  let pass = true;

  const baseline = await getStorageUsage(accountId);
  console.log("Baseline usage (Starter tier, no add-ons):", baseline);
  if (baseline.quotaBytes !== STORAGE_QUOTA_BYTES.pro || baseline.addonBytes !== 0) {
    console.error("FAIL: expected the Starter base quota with 0 add-on bytes.");
    pass = false;
  } else {
    console.log("PASS: fresh Starter account has no add-on bytes yet.");
  }

  // Simulate the first add-on's webhook landing (+5GB).
  const addon1 = fakeAddonEvent({ accountEmail: email, gbAmount: 5 });
  await syncSubscriptionFromWebhook(addon1);
  const usageAfterAddon1 = await getStorageUsage(accountId);
  console.log("Usage after +5GB add-on webhook:", usageAfterAddon1);
  if (usageAfterAddon1.quotaBytes !== STORAGE_QUOTA_BYTES.pro + 5 * GB || usageAfterAddon1.addonBytes !== 5 * GB) {
    console.error("FAIL: quota should grow by exactly the 5GB add-on.");
    pass = false;
  } else {
    console.log("PASS: quota grew by the add-on's GB amount, on top of the tier's base quota.");
  }

  // A second, stacked add-on (+20GB) — proves multiple add-ons sum correctly
  // rather than the newer one replacing the older (this is why storage_addons
  // is upserted on mor_subscription_id, not account_id).
  const addon2 = fakeAddonEvent({ accountEmail: email, gbAmount: 20 });
  await syncSubscriptionFromWebhook(addon2);
  const usageAfterAddon2 = await getStorageUsage(accountId);
  console.log("Usage after stacking a +20GB add-on:", usageAfterAddon2);
  if (usageAfterAddon2.quotaBytes !== STORAGE_QUOTA_BYTES.pro + 25 * GB || usageAfterAddon2.addonBytes !== 25 * GB) {
    console.error("FAIL: two stacked add-ons should sum (5GB + 20GB = 25GB), not replace each other.");
    pass = false;
  } else {
    console.log("PASS: multiple active add-ons stack additively.");
  }

  // Cancel the first add-on via the real cancelStorageAddon() path (calls
  // the MoR adapter first, same discipline as cancelSubscription). Per the
  // 2026-08-11 deferred-cancellation fix (see billing/sync.ts around line
  // 510+), this only flips cancel_at_period_end=true — status stays
  // "active" and getActiveAddonBytes() (storageQuota.ts) counts by status
  // alone, so the quota does NOT drop yet. The real removal happens later,
  // driven by the genuine webhook at period end, same as the main-plan
  // cancellation flow.
  const { data: addonRow } = await supabase
    .from("storage_addons")
    .select("id")
    .eq("mor_subscription_id", addon1.morSubscriptionId)
    .single();
  if (!addonRow) throw new Error("expected the first add-on's row to exist before cancelling it");

  const cancelResult = await cancelStorageAddon(accountId, addonRow.id, morAdapter);
  if (!cancelResult.success) {
    console.error("FAIL: cancelStorageAddon should succeed against the stub MoR adapter.");
    pass = false;
  }

  const { data: cancelledAddonRow } = await supabase
    .from("storage_addons")
    .select("status, cancel_at_period_end")
    .eq("id", addonRow.id)
    .single();
  if (cancelledAddonRow?.status !== "active" || cancelledAddonRow?.cancel_at_period_end !== true) {
    console.error(
      `FAIL: cancelled add-on should stay active with cancel_at_period_end=true (deferred to period end), got status=${cancelledAddonRow?.status} cancel_at_period_end=${cancelledAddonRow?.cancel_at_period_end}`,
    );
    pass = false;
  } else {
    console.log("PASS: cancelled add-on marked cancel_at_period_end=true without flipping status yet.");
  }

  const usageAfterCancel = await getStorageUsage(accountId);
  console.log("Usage right after cancelling the +5GB add-on (should be unchanged until period end):", usageAfterCancel);
  if (usageAfterCancel.quotaBytes !== STORAGE_QUOTA_BYTES.pro + 25 * GB || usageAfterCancel.addonBytes !== 25 * GB) {
    console.error("FAIL: quota should stay unchanged immediately after cancelling — it only counts status, not cancel_at_period_end.");
    pass = false;
  } else {
    console.log("PASS: quota is untouched immediately after cancelling — deferred to the real period-end webhook, not dropped early.");
  }

  // Confirm the main tier subscription was untouched by the add-on cancel.
  const { data: tierRow } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("account_id", accountId)
    .single();
  if (tierRow?.status !== "active") {
    console.error("FAIL: cancelling a storage add-on must never touch the account's main tier subscription.");
    pass = false;
  } else {
    console.log("PASS: the account's main tier subscription is untouched by the add-on cancellation.");
  }

  await supabase.auth.admin.deleteUser(accountId);
  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
