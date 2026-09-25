import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { syncSubscriptionFromWebhook, cancelSubscription } from "../src/billing/sync.js";
import { StubMorAdapter } from "../src/billing/stub.js";
import type { StorageAddonEvent } from "../src/billing/types.js";

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
    occurredAt: new Date().toISOString(),
    cancelAtPeriodEnd: false,
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

  // acknowledgedDataDeletion=true (2026-08-15 fix — cancelSubscription now
  // requires this as a real server-side precondition, see billing/sync.ts).
  const result = await cancelSubscription(accountId, morAdapter, undefined, true);
  if (!result.success) {
    console.error("FAIL: cancelSubscription should succeed against the stub MoR adapter.");
    pass = false;
  }

  // Cancellation is deferred to the end of the paid period (2026-08-11 fix,
  // see billing/sync.ts around line 520+): status stays "active" right after
  // cancelling — only cancel_at_period_end flips true immediately. The real
  // status: "cancelled" flip happens later, driven by the genuine
  // subscription.canceled webhook when Paddle's deferred cancellation
  // actually takes effect.
  const { data: tierRow } = await supabase
    .from("subscriptions")
    .select("status, cancel_at_period_end")
    .eq("account_id", accountId)
    .single();
  if (tierRow?.status !== "active" || tierRow?.cancel_at_period_end !== true) {
    console.error(
      `FAIL: main tier subscription should stay active with cancel_at_period_end=true, got status=${tierRow?.status} cancel_at_period_end=${tierRow?.cancel_at_period_end}`,
    );
    pass = false;
  } else {
    console.log("PASS: main tier subscription deferred-cancelled (still active, cancel_at_period_end=true).");
  }

  const { data: addonRow } = await supabase
    .from("storage_addons")
    .select("status, cancel_at_period_end")
    .eq("account_id", accountId)
    .single();
  if (addonRow?.status !== "active" || addonRow?.cancel_at_period_end !== true) {
    console.error(
      `FAIL: storage add-on should also be deferred-cancelled (still active, cancel_at_period_end=true), got status=${addonRow?.status} cancel_at_period_end=${addonRow?.cancel_at_period_end}`,
    );
    pass = false;
  } else {
    console.log("PASS: cancelling the main plan cascaded to deferred-cancel the active storage add-on too.");
  }

  await supabase.auth.admin.deleteUser(accountId);
  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
