import "dotenv/config";
import { supabase } from "./supabase.js";
import { syncSubscriptionFromWebhook, cancelSubscription } from "./billing/sync.js";
import { StubMorAdapter } from "./billing/stub.js";
import type { StorageAddonEvent } from "./billing/types.js";

// One-off smoke test — proves that cancelling a customer's main plan also
// cancels their active storage add-ons (2026-07-23 policy decision: don't
// leave a Free-tier account silently still paying for extra storage after
// the main plan lapses).

const morAdapter = new StubMorAdapter();

async function main() {
  const email = `cancel-cascade-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  await supabase.from("subscriptions").upsert(
    {
      account_id: accountId,
      mor_subscription_id: `sub_tier_cascade_${Date.now()}`,
      tier: "pro",
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );

  const addonEvent: StorageAddonEvent = {
    kind: "storage_addon",
    morSubscriptionId: `sub_addon_cascade_${Date.now()}`,
    accountEmail: email,
    gbAmount: 5,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  };
  await syncSubscriptionFromWebhook(addonEvent);

  let pass = true;

  const { data: beforeCancel } = await supabase
    .from("storage_addons")
    .select("status")
    .eq("account_id", accountId)
    .single();
  if (beforeCancel?.status !== "active") {
    console.error("FAIL: setup — expected the add-on to be active before cancelling the main plan.");
    pass = false;
  }

  const result = await cancelSubscription(accountId, morAdapter);
  if (!result.success) {
    console.error("FAIL: cancelSubscription should succeed against the stub MoR adapter.");
    pass = false;
  }

  const { data: tierRow } = await supabase.from("subscriptions").select("status").eq("account_id", accountId).single();
  if (tierRow?.status !== "cancelled") {
    console.error("FAIL: main tier subscription should be cancelled.");
    pass = false;
  } else {
    console.log("PASS: main tier subscription cancelled.");
  }

  const { data: addonRow } = await supabase
    .from("storage_addons")
    .select("status")
    .eq("account_id", accountId)
    .single();
  if (addonRow?.status !== "cancelled") {
    console.error(`FAIL: storage add-on should also be cancelled, got status: ${addonRow?.status}`);
    pass = false;
  } else {
    console.log("PASS: cancelling the main plan cascaded to cancel the active storage add-on too.");
  }

  await supabase.auth.admin.deleteUser(accountId);
  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
