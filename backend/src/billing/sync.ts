import { supabase } from "../supabase.js";
import { ACCOUNT_LIMITS } from "../accountLimits.js";
import type { Tier } from "../tier.js";
import type {
  SubscriptionEvent,
  StorageAddonEvent,
  BrandAddonEvent,
  SeatAddonEvent,
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

/** Resolves the account a webhook event belongs to. Prefers the stable
 *  account UUID embedded in customData at checkout time (see
 *  buildCheckoutTransaction in billing/paddle.ts) over the accountEmail
 *  fallback — email is a secondary attribute that could in principle be
 *  duplicated or changed later, while the UUID is set once, by us, at
 *  checkout creation and never modified afterward (2026-09-01 audit fix).
 *  accountId is optional only so a transaction created by the pre-fix
 *  checkout code, still in flight across the deploy, still resolves. */
async function resolveAccountId(event: { accountId?: string; accountEmail: string }): Promise<string> {
  if (event.accountId) {
    const { data, error } = await supabase.from("accounts").select("id").eq("id", event.accountId).single();
    if (error || !data) {
      throw new Error(`No account found for id ${event.accountId}: ${error?.message}`);
    }
    return data.id;
  }
  const { data, error } = await supabase.from("accounts").select("id").eq("email", event.accountEmail).single();
  if (error || !data) {
    throw new Error(`No account found for email ${event.accountEmail}: ${error?.message}`);
  }
  return data.id;
}

/** Called by the webhook HTTP handler after signature verification. Keeps
 *  our local `subscriptions` row in sync with what the MoR actually thinks
 *  the state is — this table is the source of truth for what a customer
 *  sees, and it must never silently drift from reality (that drift is
 *  exactly the "silent trial-to-paid conversion" pattern in Blotato's
 *  billing complaints). Branches to the storage-addons sync path for
 *  add-on subscriptions (2026-07-23) — see BillingEvent's `kind` field. */
export async function syncSubscriptionFromWebhook(event: SubscriptionEvent | StorageAddonEvent | BrandAddonEvent | SeatAddonEvent): Promise<void> {
  const accountId = await resolveAccountId(event);

  if (event.kind === "storage_addon") {
    // Upserted on mor_subscription_id, NOT account_id — unlike the tier
    // subscription, a customer can legitimately stack several active
    // add-ons at once, so each Paddle subscription gets its own row.
    const { error } = await supabase.from("storage_addons").upsert(
      {
        account_id: accountId,
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

  if (event.kind === "brand_addon") {
    // Same upsert-on-mor_subscription_id reasoning as storage_addons above —
    // a customer can stack several active brand add-ons at once.
    const { error } = await supabase.from("brand_addons").upsert(
      {
        account_id: accountId,
        mor_subscription_id: event.morSubscriptionId,
        status: event.status,
        current_period_end: event.currentPeriodEnd,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "mor_subscription_id" },
    );
    if (error) throw error;
    return;
  }

  if (event.kind === "seat_addon") {
    // Same upsert-on-mor_subscription_id reasoning as brand_addons above —
    // a customer can stack up to MAX_SEAT_ADDONS_PER_ACCOUNT active seat
    // add-ons at once (see seatLimits.ts).
    const { error } = await supabase.from("seat_addons").upsert(
      {
        account_id: accountId,
        mor_subscription_id: event.morSubscriptionId,
        status: event.status,
        current_period_end: event.currentPeriodEnd,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "mor_subscription_id" },
    );
    if (error) throw error;
    return;
  }

  // Stale/out-of-order webhook guard (2026-08-25 pre-launch audit fix,
  // HARDENED 2026-09-01 to close a real race in the original version: it
  // read last_webhook_occurred_at, checked it in application code, and only
  // then wrote -- two concurrent deliveries could both read before either
  // wrote, so whichever one's write landed LAST in wall-clock order would
  // win, regardless of which event was actually newer per Paddle's own
  // occurredAt. Paddle does not guarantee in-order delivery, and this app
  // has a confirmed history of delayed/backlogged deliveries, so this isn't
  // hypothetical (see migration 0067).
  //
  // The fix below makes the ordering check part of the same atomic UPDATE
  // statement instead of a separate read: Postgres's own row lock on the
  // UPDATE means two concurrent requests for the same account_id serialize,
  // and the second one's WHERE clause is evaluated against whatever the
  // first one just committed -- so an older event can never overwrite a
  // newer one no matter which request's JS reached this line first.
  const subscriptionRow = {
    account_id: accountId,
    mor_subscription_id: event.morSubscriptionId,
    tier: event.tier,
    status: event.status,
    current_period_end: event.currentPeriodEnd,
    // See the matching comment on the storage_addons upsert above.
    cancel_at_period_end: false,
    last_webhook_occurred_at: event.occurredAt,
    updated_at: new Date().toISOString(),
  };

  const applyIfNewer = async () => {
    const { data, error } = await supabase
      .from("subscriptions")
      .update(subscriptionRow)
      .eq("account_id", accountId)
      .or(`last_webhook_occurred_at.is.null,last_webhook_occurred_at.lt.${event.occurredAt}`)
      .select("account_id");
    if (error) throw error;
    return data ?? [];
  };

  let winningRow = await applyIfNewer();
  if (winningRow.length === 0) {
    // No row was updated: either no subscription row exists yet for this
    // account (its first-ever webhook), or the existing row is already
    // same-or-newer (genuinely stale, nothing to do) -- this single
    // statement can't tell the two apart yet. onConflict + ignoreDuplicates
    // targets account_id, not mor_subscription_id -- a customer has exactly
    // one subscription row, but Paddle issues a brand-new subscription id
    // on every checkout, so conflicting on mor_subscription_id let a
    // cancel-then-resubscribe insert a second row instead of updating the
    // existing one (found live 2026-07-22; see migration 0007's note).
    // ignoreDuplicates makes this a pure no-op if a row already exists
    // (whether current or stale) -- it only actually inserts on this
    // account's genuine first-ever webhook, and .select() tells us which
    // case just happened (PostgREST returns the row it actually inserted;
    // an ON CONFLICT DO NOTHING no-op returns nothing).
    const { data: inserted, error: insertError } = await supabase
      .from("subscriptions")
      .upsert(subscriptionRow, { onConflict: "account_id", ignoreDuplicates: true })
      .select("account_id");
    if (insertError) throw insertError;
    if ((inserted ?? []).length > 0) {
      winningRow = inserted!;
    } else {
      // The insert no-op'd, meaning a row already existed at that moment
      // too. Closes one remaining gap: a concurrent request could have
      // inserted that row, with an older occurredAt than ours, in the
      // window between the two calls above -- re-running the conditional
      // update catches that case; it's a cheap no-op in every other case.
      winningRow = await applyIfNewer();
    }
  }

  if (winningRow.length === 0) {
    console.log(`Skipping stale webhook for account ${accountId}: event occurred at ${event.occurredAt}.`);
    return;
  }

  if (event.status === "cancelled") {
    // Only set cancelled_at if it isn't already -- a retried/duplicate
    // cancellation webhook (Paddle retries any delivery that doesn't get a
    // clean 2xx) must not keep pushing this further into the future on
    // every redelivery, which would silently extend the 30-day
    // data-deletion grace period described below.
    await supabase
      .from("accounts")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", accountId)
      .is("cancelled_at", null);
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
      .eq("id", accountId);
    await unpausePausedAccountsUpToLimit(accountId, event.tier as Tier);
  }
}

async function recordSale(event: SaleRecordEvent): Promise<void> {
  const accountId = await resolveAccountId(event);

  const { error } = await supabase.from("billing_records").insert({
    account_id: accountId,
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
  if (error) {
    // 23505 = billing_records_event_key_key (migration 0065) -- this exact
    // transaction was already recorded, almost certainly a Paddle webhook
    // retry of a delivery we'd already processed. Not an error: recording it
    // twice is the actual bug this constraint exists to prevent.
    if ((error as { code?: string }).code === "23505") {
      console.log(`Sale already recorded for transaction ${event.paddleTransactionId}, skipping duplicate webhook delivery.`);
      return;
    }
    throw error;
  }
}

/** A refund's Paddle payload carries no customer email — the account is
 *  resolved via the original sale record already stored for this
 *  transactionId, not by looking anything up in Paddle itself. If that sale
 *  record isn't found, this throws rather than inserting a refund record
 *  with a guessed/null account — an orphaned tax record is worse than a
 *  webhook retry (Paddle retries failed deliveries). */
async function recordRefund(event: RefundRecordEvent, morAdapter: MerchantOfRecordAdapter): Promise<void> {
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
  if (error) {
    // Same reasoning as recordSale's 23505 handling above -- a retried
    // adjustment.created webhook for an adjustment we've already recorded,
    // not a new refund.
    if ((error as { code?: string }).code === "23505") {
      console.log(`Refund already recorded for adjustment ${event.paddleAdjustmentId}, skipping duplicate webhook delivery.`);
      return;
    }
    throw error;
  }

  // 2026-09-01 audit fix: a chargeback used to be recorded here for internal
  // SARS bookkeeping only -- nothing ever revoked the customer's access, so
  // a chargeback was pure loss (money back to them, access unchanged).
  // event.reason is built in billing/paddle.ts's buildRefundRecordEvent as
  // `${adj.action}: ${adj.reason}`, so this matches only the exact
  // "chargeback" action -- deliberately NOT chargeback_reverse (money
  // returned to us) or chargeback_warning (no money has moved yet).
  // revokeSubscriptionImmediately, not the deferred cancelSubscription used
  // by the customer-facing cancel button -- a customer who has already
  // reversed a payment via their bank should not keep paid access for the
  // rest of that billing period. Paddle's own docs don't state whether a
  // chargeback already auto-cancels the subscription on their side; calling
  // this regardless is the defensive choice. Best-effort: a failed clawback
  // call is logged, not thrown, since the bookkeeping record above (the
  // thing Paddle will retry this webhook for) has already been written
  // successfully and must not be undone by a downstream failure.
  if (event.paddleSubscriptionId && event.reason.startsWith("chargeback:")) {
    const revokeResult = await morAdapter.revokeSubscriptionImmediately(event.paddleSubscriptionId);
    if (!revokeResult.success) {
      console.error(
        `Chargeback ${event.paddleAdjustmentId}: failed to revoke subscription ${event.paddleSubscriptionId} at Paddle — needs manual follow-up:`,
        revokeResult.errorMessage,
      );
    } else {
      console.log(`Chargeback ${event.paddleAdjustmentId}: revoked subscription ${event.paddleSubscriptionId} immediately.`);
    }
  }
}

/** Writes an internal SARS bookkeeping record for a completed sale or a
 *  refund/credit adjustment — see billing_records migration 0014. Called by
 *  the webhook handler alongside (not instead of) syncSubscriptionFromWebhook,
 *  since a "sale_record"/"refund_record" event never overlaps with a
 *  subscription-lifecycle one for the same webhook delivery. */
export async function recordBillingEvent(event: SaleRecordEvent | RefundRecordEvent, morAdapter: MerchantOfRecordAdapter): Promise<void> {
  if (event.kind === "sale_record") {
    await recordSale(event);
  } else {
    await recordRefund(event, morAdapter);
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

  // Brand add-ons (Phase 1b, 2026-08-16) get the same treatment as storage
  // add-ons above, same reasoning: a Free-tier account silently still paying
  // for extra brand slots is a confusing state nobody asked for.
  const { data: brandAddons } = await supabase
    .from("brand_addons")
    .select("id, mor_subscription_id")
    .eq("account_id", accountId)
    .in("status", ["active", "trialing"]);
  for (const addon of brandAddons ?? []) {
    const addonResult = await adapter.cancelSubscription(addon.mor_subscription_id);
    if (addonResult.success) {
      await supabase.from("brand_addons").update({ cancel_at_period_end: true }).eq("id", addon.id);
    } else {
      console.error(`Failed to cancel brand add-on ${addon.id} alongside main plan:`, addonResult.errorMessage);
    }
  }

  // Seat add-ons (Agency pricing pass, 2026-08-17) — same treatment as
  // storage/brand add-ons above.
  const { data: seatAddons } = await supabase
    .from("seat_addons")
    .select("id, mor_subscription_id")
    .eq("account_id", accountId)
    .in("status", ["active", "trialing"]);
  for (const addon of seatAddons ?? []) {
    const addonResult = await adapter.cancelSubscription(addon.mor_subscription_id);
    if (addonResult.success) {
      await supabase.from("seat_addons").update({ cancel_at_period_end: true }).eq("id", addon.id);
    } else {
      console.error(`Failed to cancel seat add-on ${addon.id} alongside main plan:`, addonResult.errorMessage);
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

/** Cancels a single brand add-on — same isolation/deferred-cancel discipline
 *  as cancelStorageAddon above. Does not free up the brand it may have been
 *  covering; a customer over their base cap who cancels an add-on will see
 *  the standard "reached your plan's limit" error on their next brand-create
 *  once the cancellation actually takes effect (checkBrandLimit counts only
 *  active/trialing add-ons, see brandLimits.ts). */
export async function cancelBrandAddon(
  accountId: string,
  addonId: string,
  adapter: MerchantOfRecordAdapter,
): Promise<CancelResult> {
  const { data: addon, error } = await supabase
    .from("brand_addons")
    .select("id, account_id, mor_subscription_id")
    .eq("id", addonId)
    .single();
  if (error || !addon || addon.account_id !== accountId) {
    return { success: false, errorMessage: "Brand add-on not found or not owned by this caller." };
  }

  const result = await adapter.cancelSubscription(addon.mor_subscription_id);
  if (!result.success) return result;

  await supabase.from("brand_addons").update({ cancel_at_period_end: true }).eq("id", addon.id);
  return result;
}

/** Cancels a single seat add-on — same isolation/deferred-cancel discipline
 *  as cancelBrandAddon above. Does not remove any team member; an account
 *  over its base cap who cancels an add-on will see the standard "reached
 *  your plan's limit" error on the next invite once the cancellation
 *  actually takes effect (checkSeatLimit counts only active/trialing
 *  add-ons, see seatLimits.ts). */
export async function cancelSeatAddon(
  accountId: string,
  addonId: string,
  adapter: MerchantOfRecordAdapter,
): Promise<CancelResult> {
  const { data: addon, error } = await supabase
    .from("seat_addons")
    .select("id, account_id, mor_subscription_id")
    .eq("id", addonId)
    .single();
  if (error || !addon || addon.account_id !== accountId) {
    return { success: false, errorMessage: "Seat add-on not found or not owned by this caller." };
  }

  const result = await adapter.cancelSubscription(addon.mor_subscription_id);
  if (!result.success) return result;

  await supabase.from("seat_addons").update({ cancel_at_period_end: true }).eq("id", addon.id);
  return result;
}
