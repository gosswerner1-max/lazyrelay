import "dotenv/config";
import { supabase } from "./supabase.js";
import { cancelSubscription } from "./billing/sync.js";
import type { MerchantOfRecordAdapter, SubscriptionEvent, CancelResult } from "./billing/types.js";

class MockAdapterSucceeds implements MerchantOfRecordAdapter {
  async parseWebhookEvent(): Promise<SubscriptionEvent> {
    throw new Error("not used in this test");
  }
  async cancelSubscription(): Promise<CancelResult> {
    return { success: true, errorMessage: null };
  }
}

class MockAdapterFails implements MerchantOfRecordAdapter {
  async parseWebhookEvent(): Promise<SubscriptionEvent> {
    throw new Error("not used in this test");
  }
  async cancelSubscription(): Promise<CancelResult> {
    return { success: false, errorMessage: "simulated MoR outage" };
  }
}

async function seedAccountWithSubscription(morSubId: string) {
  const email = `cancel-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;

  await supabase.from("accounts").insert({ id: accountId, email });
  await supabase.from("subscriptions").insert({
    account_id: accountId,
    tier: "free",
    status: "active",
    mor_subscription_id: morSubId,
    current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  return accountId;
}

async function cleanup(accountId: string) {
  await supabase.auth.admin.deleteUser(accountId);
}

async function testCancelSucceeds() {
  const accountId = await seedAccountWithSubscription(`mor_sub_ok_${Date.now()}`);
  const result = await cancelSubscription(accountId, new MockAdapterSucceeds());

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("account_id", accountId)
    .single();
  const { data: account } = await supabase
    .from("accounts")
    .select("cancelled_at")
    .eq("id", accountId)
    .single();

  const pass = result.success && sub?.status === "cancelled" && account?.cancelled_at !== null;
  console.log(`[succeeds case] status=${sub?.status} cancelled_at=${account?.cancelled_at} -> ${pass ? "PASS" : "FAIL"}`);
  await cleanup(accountId);
  return pass;
}

async function testCancelFailsAtMor() {
  const accountId = await seedAccountWithSubscription(`mor_sub_fail_${Date.now()}`);
  const result = await cancelSubscription(accountId, new MockAdapterFails());

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("account_id", accountId)
    .single();
  const { data: account } = await supabase
    .from("accounts")
    .select("cancelled_at")
    .eq("id", accountId)
    .single();

  // The real point of this test: when the MoR call fails, our local record
  // must NOT be marked cancelled — otherwise a customer could see "cancelled"
  // in the UI while still being billed, the exact silent-billing failure
  // mode this whole product exists to not repeat.
  const pass = !result.success && sub?.status === "active" && account?.cancelled_at === null;
  console.log(`[fails-at-mor case] status=${sub?.status} cancelled_at=${account?.cancelled_at} -> ${pass ? "PASS" : "FAIL"}`);
  await cleanup(accountId);
  return pass;
}

async function main() {
  const results = await Promise.all([testCancelSucceeds(), testCancelFailsAtMor()]);
  console.log(results.every(Boolean) ? "ALL PASS" : "SOME FAILED");
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
