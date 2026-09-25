// SECURITY FIX (2026-09-25) verification: sync.ts used to hardcode
// cancel_at_period_end: false on every subscription/add-on webhook upsert,
// reasoning that "a real webhook is authoritative." True for status, wrong
// for cancel_at_period_end specifically: PaddleMorAdapter.cancelSubscription
// cancels with effectiveFrom "next_billing_period", which makes Paddle fire
// a subscription.updated for the act of SCHEDULING that cancellation --
// status still "active", Paddle's own scheduledChange.action === "cancel"
// -- before the eventual terminal subscription.canceled at period end. If
// that "scheduling" webhook landed while the flag was hardcoded false, it
// would silently un-cancel the subscription in our DB while the customer
// stayed billed. billing/paddle.ts's deriveCancelAtPeriodEnd (and
// event.cancelAtPeriodEnd flowing through to every sync.ts upsert) is the
// fix -- this proves it end to end against a real (throwaway) Supabase
// account, bypassing the real Paddle SDK entirely (no live Paddle call
// anywhere in this script; the "webhook" is a constructed BillingEvent of
// exactly the shape PaddleMorAdapter.parseWebhookEvent would have produced
// from that real race payload).
//
// Also re-confirms the 2026-08-11 fix isn't regressed: status must stay
// "active" (not flipped to "cancelled") the moment cancellation is merely
// SCHEDULED, so resolveTier()-style access checks elsewhere never see a
// customer lose paid access before the period actually ends.
//
// Run: npx tsx scripts/test-cancel-race-scheduled-change.ts
import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { syncSubscriptionFromWebhook } from "../src/billing/sync.js";
import { deriveCancelAtPeriodEnd } from "../src/billing/paddle.js";
import type { SubscriptionEvent } from "../src/billing/types.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  }
}

async function main() {
  const email = `cancel-race-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  const morSubscriptionId = `sub_cancel_race_${Date.now()}`;
  const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  try {
    // 0) Sanity: deriveCancelAtPeriodEnd against Paddle's documented
    // scheduledChange shapes -- the same unit the vitest suite covers in
    // billing/paddle.test.ts, re-checked here inline against the exact
    // payload shapes this script constructs below.
    check(
      "deriveCancelAtPeriodEnd: scheduledChange.action 'cancel' -> true",
      deriveCancelAtPeriodEnd({ scheduledChange: { action: "cancel" } }) === true,
    );
    check("deriveCancelAtPeriodEnd: scheduledChange null -> false", deriveCancelAtPeriodEnd({ scheduledChange: null }) === false);
    check(
      "deriveCancelAtPeriodEnd: scheduledChange.action 'pause' -> false (not just any scheduledChange)",
      deriveCancelAtPeriodEnd({ scheduledChange: { action: "pause" } }) === false,
    );

    // 1) Genuine first-ever webhook: account goes active on "business", no
    // cancellation scheduled. Establishes the baseline row.
    const createdEvent: SubscriptionEvent = {
      kind: "tier",
      morSubscriptionId,
      accountEmail: email,
      accountId,
      tier: "business",
      status: "active",
      currentPeriodEnd: periodEnd,
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
      cancelAtPeriodEnd: false,
    };
    await syncSubscriptionFromWebhook(createdEvent);

    const { data: afterCreate } = await supabase
      .from("subscriptions")
      .select("status, cancel_at_period_end")
      .eq("account_id", accountId)
      .single();
    check(
      "baseline: active, not scheduled to cancel",
      afterCreate?.status === "active" && afterCreate?.cancel_at_period_end === false,
      JSON.stringify(afterCreate),
    );

    // 2) THE RACE: PaddleMorAdapter.cancelSubscription's own
    // effectiveFrom:"next_billing_period" call makes Paddle fire a
    // subscription.updated for the act of scheduling the cancellation --
    // status is still "active" (customer keeps access, matching the
    // 2026-08-11 fix and the cancel-modal's promise), but
    // scheduledChange.action is "cancel". This is exactly what
    // PaddleMorAdapter.parseWebhookEvent would hand sync.ts for that real
    // webhook, once deriveCancelAtPeriodEnd runs over it.
    const cancelScheduledEvent: SubscriptionEvent = {
      ...createdEvent,
      occurredAt: new Date(Date.now() - 60_000).toISOString(), // strictly newer than createdEvent
      cancelAtPeriodEnd: deriveCancelAtPeriodEnd({ scheduledChange: { action: "cancel" } }),
    };
    await syncSubscriptionFromWebhook(cancelScheduledEvent);

    const { data: afterScheduled } = await supabase
      .from("subscriptions")
      .select("status, cancel_at_period_end")
      .eq("account_id", accountId)
      .single();
    check(
      "THE FIX: cancellation-scheduled webhook sets cancel_at_period_end=true and does NOT un-cancel it back to false",
      afterScheduled?.cancel_at_period_end === true,
      JSON.stringify(afterScheduled),
    );
    check(
      "REGRESSION GUARD (2026-08-11 fix): status stays 'active' the moment cancellation is merely scheduled -- customer keeps access",
      afterScheduled?.status === "active",
      JSON.stringify(afterScheduled),
    );

    const { data: accountAfterScheduled } = await supabase.from("accounts").select("cancelled_at").eq("id", accountId).single();
    check(
      "accounts.cancelled_at stays null while only scheduled, not yet terminal",
      accountAfterScheduled?.cancelled_at === null,
      JSON.stringify(accountAfterScheduled),
    );

    // 3) Genuine resubscribe / cancellation reversed: a later, newer webhook
    // arrives with nothing scheduled any more (scheduledChange back to
    // null). The flag must clear.
    const resubscribeEvent: SubscriptionEvent = {
      ...createdEvent,
      occurredAt: new Date().toISOString(), // strictly newer than cancelScheduledEvent
      cancelAtPeriodEnd: deriveCancelAtPeriodEnd({ scheduledChange: null }),
    };
    await syncSubscriptionFromWebhook(resubscribeEvent);

    const { data: afterResubscribe } = await supabase
      .from("subscriptions")
      .select("status, cancel_at_period_end")
      .eq("account_id", accountId)
      .single();
    check(
      "genuine resubscribe (scheduledChange back to null) clears cancel_at_period_end back to false",
      afterResubscribe?.cancel_at_period_end === false && afterResubscribe?.status === "active",
      JSON.stringify(afterResubscribe),
    );
  } finally {
    // Clean up -- no test data left behind in the real Supabase project.
    await supabase.from("subscriptions").delete().eq("account_id", accountId);
    await supabase.from("accounts").delete().eq("id", accountId);
    await supabase.auth.admin.deleteUser(accountId);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
