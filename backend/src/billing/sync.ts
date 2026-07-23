import { supabase } from "../supabase.js";
import type { BillingEvent, MerchantOfRecordAdapter, CancelResult } from "./types.js";

/** Called by the webhook HTTP handler after signature verification. Keeps
 *  our local `subscriptions` row in sync with what the MoR actually thinks
 *  the state is — this table is the source of truth for what a customer
 *  sees, and it must never silently drift from reality (that drift is
 *  exactly the "silent trial-to-paid conversion" pattern in Blotato's
 *  billing complaints). Branches to the storage-addons sync path for
 *  add-on subscriptions (2026-07-23) — see BillingEvent's `kind` field. */
export async function syncSubscriptionFromWebhook(event: BillingEvent): Promise<void> {
  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id")
    .eq("email", event.accountEmail)
    .single();
  if (accountError || !account) {
    throw new Error(`No account found for email ${event.accountEmail}: ${accountError?.message}`);
  }

  if (event.kind === "storage_addon") {
    // Upserted on mor_subscription_id, NOT account_id — unlike the tier
    // subscription, a customer can legitimately stack several active
    // add-ons at once, so each Paddle subscription gets its own row.
    const { error } = await supabase.from("storage_addons").upsert(
      {
        account_id: account.id,
        mor_subscription_id: event.morSubscriptionId,
        gb_amount: event.gbAmount,
        status: event.status,
        current_period_end: event.currentPeriodEnd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "mor_subscription_id" },
    );
    if (error) throw error;
    return;
  }

  // onConflict targets account_id, not mor_subscription_id — a customer has
  // exactly one subscription row, but Paddle issues a brand-new subscription
  // id on every checkout, so conflicting on mor_subscription_id let a
  // cancel-then-resubscribe insert a second row instead of updating the
  // existing one (found live 2026-07-22; see migration 0007's note).
  const { error } = await supabase.from("subscriptions").upsert(
    {
      account_id: account.id,
      mor_subscription_id: event.morSubscriptionId,
      tier: event.tier,
      status: event.status,
      current_period_end: event.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
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

/** Cancels a single storage add-on — separate from cancelSubscription()
 *  since one add-on's cancellation must never touch the account's main
 *  tier subscription (a customer can have several add-ons active and
 *  cancel just one). Same cancel-with-the-MoR-first discipline. */
export async function cancelStorageAddon(
  accountId: string,
  addonId: string,
  adapter: MerchantOfRecordAdapter,
): Promise<CancelResult> {
  const { data: addon, error } = await supabase
    .from("storage_addons")
    .select("id, account_id, mor_subscription_id")
    .eq("id", addonId)
    .single();
  if (error || !addon || addon.account_id !== accountId) {
    return { success: false, errorMessage: "Storage add-on not found or not owned by this caller." };
  }

  const result = await adapter.cancelSubscription(addon.mor_subscription_id);
  if (!result.success) return result;

  await supabase.from("storage_addons").update({ status: "cancelled" }).eq("id", addon.id);
  return result;
}
