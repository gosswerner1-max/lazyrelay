import { supabase } from "../supabase.js";
import { ACCOUNT_LIMITS } from "../accountLimits.js";
import type { Tier } from "../tier.js";
import type {
  SubscriptionEvent,
  StorageAddonEvent,
  MerchantOfRecordAdapter,
  CancelResult,
  SaleRecordEvent,
  RefundRecordEvent,
} from "./types.js";

/** Reverses a prior downgrade-pause (ops/accounts/accounts_ops.js's
 *  planDowngradePause/enforceDowngradePause) when a webhook brings a
 *  subscription back to "active" — e.g. an upgrade, or a past_due account
 *  paying up. Without this, an account that was paused for exceeding its
 *  old tier's limit stayed paused forever after upgrading, since nothing
 *  called the JS ops module's unpauseAccounts() from the real webhook path
 *  (confirmed gap, 2026-07-28 — that function only ever ran in its own
 *  smoke test). Unpauses oldest-paused-first, up to the new tier's limit,
 *  mirroring the pause side's oldest-connected-stays-active convention. */
async function unpausePausedAccountsUpToLimit(accountId: string, tier: Tier): Promise<void> {
  const limit = ACCOUNT_LIMITS[tier];

  const { count: activeCount, error: activeError } = await supabase
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .is("disconnected_at", null)
    .is("paused_at", null);
  if (activeError) throw activeError;

  const room = limit - (activeCount ?? 0);
  if (room <= 0) return;

  const { data: paused, error: pausedError } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("account_id", accountId)
    .is("disconnected_at", null)
    .not("paused_at", "is", null)
    .order("paused_at", { ascending: true })
    .limit(room);
  if (pausedError) throw pausedError;
  if (!paused || paused.length === 0) return;

  const { error: unpauseError } = await supabase
    .from("social_accounts")
    .update({ paused_at: null })
    .in(
      "id",
      paused.map((p) => p.id),
    );
  if (unpauseError) throw unpauseError;
}

/** Called by the webhook HTTP handler after signature verification. Keeps
 *  our local `subscriptions` row in sync with what the MoR actually thinks
 *  the state is — this table is the source of truth for what a customer
 *  sees, and it must never silently drift from reality (that drift is
 *  exactly the "silent trial-to-paid conversion" pattern in Blotato's
 *  billing complaints). Branches to the storage-addons sync path for
 *  add-on subscriptions (2026-07-23) — see BillingEvent's `kind` field. */
export async function syncSubscriptionFromWebhook(event: SubscriptionEvent | StorageAddonEvent): Promise<void> {
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
        // A real webhook always reflects Paddle's current authoritative
        // state, which supersedes our own local "customer clicked cancel,
        // waiting for period end" flag — clears it whether this event is a
        // fresh resubscribe or the real end-of-period cancellation finally
        // landing (see cancel_at_period_end migration 0043).
        cancel_at_period_end: false,
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
      // See the matching comment on the storage_addons upsert above.
      cancel_at_period_end: false,
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
  } else if (event.status === "active") {
    // Resubscribe safety (2026-08-15): if this account was previously
    // cancelled and is now genuinely active again, the pending data-deletion
    // clock must be cleared -- otherwise a customer who cancels and comes
    // back within the 30-day grace period would still have their data
    // silently deleted on schedule by the reaper job, since cancelled_at
    // would still be set from the old cancellation. data_deleted_at is left
    // untouched -- if deletion already actually ran, that's a permanent fact,
    // not something a resubscribe can undo.
    await supabase
      .from("accounts")
      .update({ cancelled_at: null, data_deletion_ack_at: null, data_deletion_reminder_sent_at: null })
      .eq("id", account.id);
    await unpausePausedAccountsUpToLimit(account.id, event.tier as Tier);
  }
}

async function recordSale(event: SaleRecordEvent): Promise<void> {
  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id")
    .eq("email", event.accountEmail)
    .single();
  if (accountError || !account) {
    throw new Error(`No account found for email ${event.accountEmail}: ${accountError?.message}`);
  }

  const { error } = await supabase.from("billing_records").insert({
    account_id: account.id,
    kind: "sale",
    paddle_transaction_id: event.paddleTransactionId,
    paddle_subscription_id: event.paddleSubscriptionId,
    invoice_number: event.invoiceNumber,
    currency_code: event.currencyCode,
    subtotal: event.subtotal,
    tax: event.tax,
    total: event.total,
    grand_total: event.grandTotal,
    payout_currency_code: event.payoutCurrencyCode,
    payout_subtotal: event.payoutSubtotal,
    payout_tax: event.payoutTax,
    payout_fee: event.payoutFee,
    payout_earnings: event.payoutEarnings,
    occurred_at: event.occurredAt,
  });
  if (error) throw error;
}

/** A refund's Paddle payload carries no customer email — the account is
 *  resolved via the original sale record already stored for this
 *  transactionId, not by looking anything up in Paddle itself. If that sale
 *  record isn't found, this throws rather than inserting a refund record
 *  with a guessed/null account — an orphaned tax record is worse than a
 *  webhook retry (Paddle retries failed deliveries). */
async function recordRefund(event: RefundRecordEvent): Promise<void> {
  const { data: saleRecord, error: saleError } = await supabase
    .from("billing_records")
    .select("account_id")
    .eq("paddle_transaction_id", event.paddleTransactionId)
    .eq("kind", "sale")
    .single();
  if (saleError || !saleRecord) {
    throw new Error(
      `No sale record found for transaction ${event.paddleTransactionId} — cannot record refund ${event.paddleAdjustmentId} without it`,
    );
  }

  const { error } = await supabase.from("billing_records").insert({
    account_id: saleRecord.account_id,
    kind: "refund",
    paddle_transaction_id: event.paddleTransactionId,
    paddle_adjustment_id: event.paddleAdjustmentId,
    paddle_subscription_id: event.paddleSubscriptionId,
    reason: event.reason,
    currency_code: event.currencyCode,
    subtotal: event.subtotal,
    tax: event.tax,
    total: event.total,
    occurred_at: event.occurredAt,
  });
  if (error) throw error;
}

/** Writes an internal SARS bookkeeping record for a completed sale or a
 *  refund/credit adjustment — see billing_records migration 0014. Called by
 *  the webhook handler alongside (not instead of) syncSubscriptionFromWebhook,
 *  since a "sale_record"/"refund_record" event never overlaps with a
 *  subscription-lifecycle one for the same webhook delivery. */
export async function recordBillingEvent(event: SaleRecordEvent | RefundRecordEvent): Promise<void> {
  if (event.kind === "sale_record") {
    await recordSale(event);
  } else {
    await recordRefund(event);
  }
}

/** The actual cancel action, called from the customer-facing cancel button.
 *  Cancels with the MoR FIRST — only marks our own record once that real
 *  cancellation succeeds, never the other way around. A cancel button that
 *  just flips a local flag while billing continues is exactly the failure
 *  mode this whole product exists to not repeat.
 *
 *  Deferred to the end of the paid period (2026-08-11 — see
 *  cancel_at_period_end migration 0043): PaddleMorAdapter.cancelSubscription
 *  now cancels with effectiveFrom "next_billing_period", not "immediately".
 *  Real customer-facing bug found live the same day: the cancel modal always
 *  promised "you'll keep access until <period end>," but this used to flip
 *  `status` to "cancelled" right here, and resolveTier() treats anything
 *  other than active/trialing as Free immediately — so a customer lost paid
 *  access the instant they clicked cancel, a full billing period earlier
 *  than the UI told them. `status` now stays untouched (still active/
 *  trialing, so resolveTier() keeps granting paid access) and only
 *  `cancel_at_period_end` flips true; the real `status: "cancelled"` update
 *  — and `accounts.cancelled_at` — happens later, driven by the genuine
 *  subscription.canceled webhook when Paddle's deferred cancellation
 *  actually takes effect (see syncSubscriptionFromWebhook above).
 *
 *  Also cancels any active/trialing storage add-ons (2026-07-23 — decided
 *  against leaving them running after the main plan cancels: a Free-tier
 *  account silently still paying for +50GB is a confusing state nobody
 *  asked for, not a deliberate feature). Add-on cancellation failures are
 *  logged but don't block the main-plan cancellation from completing —
 *  the customer's primary intent (stop the big bill) still succeeds even
 *  if one add-on's MoR call has a transient failure. */
export async function cancelSubscription(
  accountId: string,
  adapter: MerchantOfRecordAdapter,
  feedback?: string,
  acknowledgedDataDeletion?: boolean,
): Promise<CancelResult> {
  // Enforced server-side, not just a disabled button in the UI (2026-08-15) --
  // a customer's posts and media now genuinely get deleted 30 days after this
  // cancellation takes effect, so the acknowledgement is a real precondition,
  // the same way webhook signature checks are a real precondition and not
  // just client-side politeness.
  if (!acknowledgedDataDeletion) {
    return { success: false, errorMessage: "You must acknowledge the data-deletion notice before cancelling." };
  }

  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select("mor_subscription_id, tier")
    .eq("account_id", accountId)
    .single();
  if (error || !subscription) {
    return { success: false, errorMessage: "No active subscription found for this account." };
  }

  const result = await adapter.cancelSubscription(subscription.mor_subscription_id);
  if (!result.success) return result;

  await supabase.from("accounts").update({ data_deletion_ack_at: new Date().toISOString() }).eq("id", accountId);

  // Best-effort — a feedback-insert failure must never block the actual
  // cancellation from completing, same principle as the storage-addon
  // cancellation below.
  if (feedback?.trim()) {
    await supabase
      .from("cancellation_feedback")
      .insert({ account_id: accountId, tier: subscription.tier, feedback: feedback.trim() })
      .then(({ error: feedbackError }) => {
        if (feedbackError) console.error("Failed to store cancellation feedback:", feedbackError.message);
      });
  }

  await supabase
    .from("subscriptions")
    .update({ cancel_at_period_end: true })
    .eq("mor_subscription_id", subscription.mor_subscription_id);

  const { data: addons } = await supabase
    .from("storage_addons")
    .select("id, mor_subscription_id")
    .eq("account_id", accountId)
    .in("status", ["active", "trialing"]);
  for (const addon of addons ?? []) {
    const addonResult = await adapter.cancelSubscription(addon.mor_subscription_id);
    if (addonResult.success) {
      await supabase.from("storage_addons").update({ cancel_at_period_end: true }).eq("id", addon.id);
    } else {
      console.error(`Failed to cancel storage add-on ${addon.id} alongside main plan:`, addonResult.errorMessage);
    }
  }

  return result;
}

/** Cancels a single storage add-on — separate from cancelSubscription()
 *  since one add-on's cancellation must never touch the account's main
 *  tier subscription (a customer can have several add-ons active and
 *  cancel just one). Same cancel-with-the-MoR-first discipline, same
 *  deferred-to-period-end behavior as the main plan above. */
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

  await supabase.from("storage_addons").update({ cancel_at_period_end: true }).eq("id", addon.id);
  return result;
}
