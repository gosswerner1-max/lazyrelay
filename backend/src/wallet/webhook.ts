import { supabase } from "../supabase.js";
import { notifyOps } from "../notify.js";
import { recordSale, syncSubscriptionFromWebhook } from "../billing/sync.js";
import { walletPlanForSku } from "../billing/skuPrices.js";
import type { RefundRecordEvent, SaleRecordEvent, SubscriptionEvent, WalletBillingEvent, WalletPackEvent, WalletPlanLifecycleEvent, WalletPlanPaymentEvent } from "../billing/types.js";
import { CATALOG } from "./catalog.js";
import { createWalletLedger, type WalletRpc } from "./ledger.js";
import { packSourceKey } from "./topup.js";
import { walletPlanForTier } from "./tierMap.js";
import type { Tier } from "../tier.js";

// Paddle events -> the wallet (migration 0140 functions). The webhook route has already verified the signature and the adapter has
// already turned the payload into one of the wallet events. Everything here is idempotent by a key taken from Paddle's own ids, so a
// webhook delivered twice (Paddle retries anything that is not a clean 200) changes nothing the second time:
//   a payment            grant key  paddle:<transaction id>   (the database ignores a second grant with the same key)
//   a lapse or revoke    plan event key  cancel:<subscription id>  or  adj:<adjustment id>
// A payment that cannot be applied (no account, a Pro only pack without a Pro plan) is never dropped: it is logged raw, ops are told,
// and the webhook still answers 200 (a retry could not fix it). A database failure is thrown so the route answers 500 and Paddle retries.

export interface WalletWebhookDeps {
  ledger: Pick<ReturnType<typeof createWalletLedger>, "grantForSku" | "handlePlanEvent">;
  now(): Date;
  /** The wallet plan id of the account's live plan (active, trialing or past due), or null. */
  activePlan(accountId: string): Promise<string | null>;
  accountForSubscription(paddleSubscriptionId: string): Promise<string | null>;
  /** The wallet lot a Paddle transaction granted, if any. */
  lotForTransaction(paddleTransactionId: string): Promise<{ accountId: string; kind: string; boundPlan: string | null } | null>;
  syncSubscription(event: SubscriptionEvent): Promise<void>;
  recordSale(event: SaleRecordEvent): Promise<void>;
  /** Ops alert: the manual refund queue and every unattributed payment. */
  alert(message: string): Promise<void>;
}

export type WalletOutcome =
  | "granted" | "replay" | "refused_plan_required" | "unattributed" | "skipped_period_over"
  | "synced" | "no_lapse" | "lapsed" | "revoked" | "alerted" | "ignored" | "not_wallet";

export async function handleWalletBillingEvent(event: WalletBillingEvent, deps: WalletWebhookDeps): Promise<{ outcome: WalletOutcome }> {
  if (event.kind === "wallet_pack") return handlePack(event, deps);
  if (event.phase === "payment") return handlePlanPayment(event, deps);
  return handleLifecycle(event, deps);
}

async function alertRaw(deps: WalletWebhookDeps, message: string): Promise<void> {
  console.error(`[wallet-webhook] ${message}`);
  await deps.alert(message);
}

async function handlePack(event: WalletPackEvent, deps: WalletWebhookDeps): Promise<{ outcome: WalletOutcome }> {
  if (!event.accountId) {
    await alertRaw(deps, `Paid credit pack ${event.sku} (Paddle transaction ${event.paddleTransactionId}) names no account in its custom data. Nothing was granted. Needs a manual look.`);
    return { outcome: "unattributed" };
  }
  if (event.sale) await deps.recordSale(event.sale);

  const needsPlan = CATALOG[event.sku].requiresPlan !== null;
  const activePlan = needsPlan ? await deps.activePlan(event.accountId) : null;
  const result = await deps.ledger.grantForSku({ accountId: event.accountId, sku: event.sku, sourceKey: packSourceKey(event.paddleTransactionId), now: deps.now(), activePlan });
  if (!result.ok) {
    await alertRaw(
      deps,
      `Refused ${event.sku} for account ${event.accountId}: it needs an active ${result.requiredPlan} plan and the account has ${activePlan ?? "none"}. Paddle transaction ${event.paddleTransactionId} is paid and nothing was granted. Queued for manual refund.`,
    );
    return { outcome: "refused_plan_required" };
  }
  return { outcome: result.replay ? "replay" : "granted" };
}

async function handlePlanPayment(event: WalletPlanPaymentEvent, deps: WalletWebhookDeps): Promise<{ outcome: WalletOutcome }> {
  const accountId = event.accountId ?? (event.paddleSubscriptionId ? await deps.accountForSubscription(event.paddleSubscriptionId) : null);
  if (!accountId) {
    await alertRaw(deps, `Paid plan ${event.sku} (Paddle transaction ${event.paddleTransactionId}, subscription ${event.paddleSubscriptionId ?? "none"}) could not be matched to an account. Nothing was granted. Needs a manual look.`);
    return { outcome: "unattributed" };
  }
  if (event.sale) await deps.recordSale({ ...event.sale, accountId });

  if (!event.periodEnd) throw new Error(`Plan payment ${event.paddleTransactionId} has no billing period; the monthly lot cannot be given an expiry`);
  const periodEnd = new Date(event.periodEnd);
  if (Number.isNaN(periodEnd.getTime())) throw new Error(`Plan payment ${event.paddleTransactionId} has an invalid billing period end "${event.periodEnd}"`);
  const now = deps.now();
  if (periodEnd.getTime() <= now.getTime()) {
    console.warn(`[wallet-webhook] plan payment ${event.paddleTransactionId}: its period ended ${event.periodEnd}, so there is nothing left to grant.`);
    return { outcome: "skipped_period_over" };
  }

  const result = await deps.ledger.grantForSku({ accountId, sku: event.sku, sourceKey: packSourceKey(event.paddleTransactionId), now, activePlan: null, periodEnd });
  if (!result.ok) throw new Error(`Plan ${event.sku} was refused (${result.reason}); a plan sku never needs another plan`);
  return { outcome: result.replay ? "replay" : "granted" };
}

async function handleLifecycle(event: WalletPlanLifecycleEvent, deps: WalletWebhookDeps): Promise<{ outcome: WalletOutcome }> {
  // The tier first, through the existing sync path (accounts and limits see growth or lazy_pro). If it fails, nothing else happens.
  await deps.syncSubscription(event.subscription);

  const plan = walletPlanForSku(event.sku);
  if (!plan) throw new Error(`Lifecycle event ${event.eventId} is on ${event.sku}, which is not a plan`);
  const now = deps.now();

  if (event.subscription.status === "past_due") {
    // A failed payment never lapses credits; the database confirms it (past_due_retry answers no_lapse).
    await deps.ledger.handlePlanEvent({ accountId: event.accountId, plan, event: "past_due_retry", idempotencyKey: `pastdue:${event.eventId}`, now });
    return { outcome: "no_lapse" };
  }
  if (event.subscription.status === "cancelled") {
    // A voluntary cancel is scheduled with the status still active; Paddle sends subscription.canceled when the paid period ends (or
    // at once for a refund, a chargeback or an exhausted retry cycle). Lapsing here therefore keeps the plan until the period end for
    // a voluntary cancel, needs no undo if the customer resumes before then, and lapses at once for the others.
    const result = await deps.ledger.handlePlanEvent({ accountId: event.accountId, plan, event: "billing_gave_up", idempotencyKey: `cancel:${event.paddleSubscriptionId}`, now });
    return { outcome: "outcome" in result ? "no_lapse" : result.replay ? "replay" : "lapsed" };
  }
  return { outcome: "synced" };
}

/** Called after the refund bookkeeping record is written. Only a FULL refund or a chargeback on a plan payment revokes anything. */
export async function handleWalletRefund(event: RefundRecordEvent, deps: WalletWebhookDeps): Promise<{ outcome: WalletOutcome }> {
  const lot = await deps.lotForTransaction(event.paddleTransactionId);
  if (!lot) return { outcome: "not_wallet" };

  const action = event.reason.split(":")[0].trim();
  if (action !== "refund" && action !== "chargeback") return { outcome: "ignored" };

  if (lot.kind !== "subscription" || !lot.boundPlan) {
    await alertRaw(deps, `${action} ${event.paddleAdjustmentId} on credit pack payment ${event.paddleTransactionId} (account ${lot.accountId}). Credits are not clawed back automatically; review by hand.`);
    return { outcome: "alerted" };
  }
  if (action === "refund" && event.adjustmentType !== "full") {
    await alertRaw(deps, `Partial refund ${event.paddleAdjustmentId} on plan payment ${event.paddleTransactionId} (account ${lot.accountId}). The plan was not changed; review by hand.`);
    return { outcome: "alerted" };
  }

  const result = await deps.ledger.handlePlanEvent({ accountId: lot.accountId, plan: lot.boundPlan, event: action, idempotencyKey: `adj:${event.paddleAdjustmentId}`, now: deps.now() });
  return { outcome: "outcome" in result ? "no_lapse" : result.replay ? "replay" : "revoked" };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The real dependencies.
// ---------------------------------------------------------------------------------------------------------------------------
const walletClient: WalletRpc = {
  async rpc(fn, args) {
    const { data, error } = await supabase.rpc(fn as never, args as never);
    return { data, error: error ? { message: error.message, code: error.code } : null };
  },
};

const LIVE_STATUSES = ["active", "trialing", "past_due"];

export function defaultWalletWebhookDeps(): WalletWebhookDeps {
  return {
    ledger: createWalletLedger(walletClient),
    now: () => new Date(),
    async activePlan(accountId) {
      const { data, error } = await supabase.from("subscriptions").select("tier, status").eq("account_id", accountId).maybeSingle();
      if (error) throw error;
      if (!data || !LIVE_STATUSES.includes(data.status)) return null;
      return walletPlanForTier(data.tier as Tier);
    },
    async accountForSubscription(paddleSubscriptionId) {
      const { data, error } = await supabase.from("subscriptions").select("account_id").eq("mor_subscription_id", paddleSubscriptionId).maybeSingle();
      if (error) throw error;
      return data?.account_id ?? null;
    },
    async lotForTransaction(paddleTransactionId) {
      const { data, error } = await supabase.from("wallet_lots").select("account_id, kind, bound_plan").eq("source_key", packSourceKey(paddleTransactionId)).limit(1).maybeSingle();
      if (error) throw error;
      return data ? { accountId: data.account_id, kind: data.kind, boundPlan: data.bound_plan } : null;
    },
    syncSubscription: syncSubscriptionFromWebhook,
    recordSale,
    alert: notifyOps,
  };
}
