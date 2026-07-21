import { supabase } from "../supabase.js";
import type { SubscriptionEvent, MerchantOfRecordAdapter, CancelResult } from "./types.js";

/** Called by the webhook HTTP handler after signature verification. Keeps
 *  our local `subscriptions` row in sync with what the MoR actually thinks
 *  the state is — this table is the source of truth for what a customer
 *  sees, and it must never silently drift from reality (that drift is
 *  exactly the "silent trial-to-paid conversion" pattern in Blotato's
 *  billing complaints). */
export async function syncSubscriptionFromWebhook(event: SubscriptionEvent): Promise<void> {
  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id")
    .eq("email", event.accountEmail)
    .single();
  if (accountError || !account) {
    throw new Error(`No account found for email ${event.accountEmail}: ${accountError?.message}`);
  }

  const { error } = await supabase.from("subscriptions").upsert(
    {
      account_id: account.id,
      mor_subscription_id: event.morSubscriptionId,
      tier: event.tier,
      status: event.status,
      current_period_end: event.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "mor_subscription_id" },
  );
  if (error) throw error;

  if (event.status === "cancelled") {
    await supabase
      .from("accounts")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", account.id);
  }
}

/** The actual cancel action, called from the customer-facing cancel button.
 *  Cancels with the MoR FIRST — only marks our own record cancelled once
 *  that real cancellation succeeds, never the other way around. A cancel
 *  button that just flips a local flag while billing continues is exactly
 *  the failure mode this whole product exists to not repeat. */
export async function cancelSubscription(
  accountId: string,
  adapter: MerchantOfRecordAdapter,
): Promise<CancelResult> {
  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select("mor_subscription_id")
    .eq("account_id", accountId)
    .single();
  if (error || !subscription) {
    return { success: false, errorMessage: "No active subscription found for this account." };
  }

  const result = await adapter.cancelSubscription(subscription.mor_subscription_id);
  if (!result.success) return result;

  await supabase
    .from("subscriptions")
    .update({ status: "cancelled" })
    .eq("mor_subscription_id", subscription.mor_subscription_id);
  await supabase.from("accounts").update({ cancelled_at: new Date().toISOString() }).eq("id", accountId);

  return result;
}
