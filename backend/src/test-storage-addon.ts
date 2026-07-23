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
// add-on stacks on top, and cancelling one add-on shrinks the quota back down
// without touching the other add-on or the account's main tier subscription.

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
  // the MoR adapter first, same discipline as cancelSubscription) — quota
  // should drop back to just the 20GB add-on, not zero.
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
  const usageAfterCancel = await getStorageUsage(accountId);
  console.log("Usage after cancelling the +5GB add-on:", usageAfterCancel);
  if (usageAfterCancel.quotaBytes !== STORAGE_QUOTA_BYTES.pro + 20 * GB || usageAfterCancel.addonBytes !== 20 * GB) {
    console.error("FAIL: cancelling one add-on should only remove ITS bytes, leaving the other add-on active.");
    pass = false;
  } else {
    console.log("PASS: cancelling one add-on leaves the other add-on's bytes intact — not a blanket reset.");
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
