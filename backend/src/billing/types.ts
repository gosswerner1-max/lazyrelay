// Merchant-of-Record adapter interface — Paddle vs Lemon Squeezy isn't
// finalized yet, so subscription/webhook handling is written against this
// interface rather than a specific provider's SDK, same pattern as the
// platform adapters.

export interface SubscriptionEvent {
  morSubscriptionId: string;
  accountEmail: string;
  tier: "solo" | "pro" | "agency";
  status: "trialing" | "active" | "past_due" | "cancelled";
  currentPeriodEnd: string; // ISO timestamp
}

export interface CancelResult {
  success: boolean;
  errorMessage: string | null;
}

export interface MerchantOfRecordAdapter {
  /** Parses a raw webhook payload into our normalized shape. Throws if the
   *  signature doesn't verify — never trust an unverified webhook. */
  parseWebhookEvent(rawBody: string, signatureHeader: string): SubscriptionEvent;

  /** Cancels a subscription with the MoR directly — this must actually
   *  cancel, not just mark our own local status, since Blotato's #1
   *  documented failure was exactly this gap (settings-page bug that
   *  never reached the real cancellation, causing repeat charges). */
  cancelSubscription(morSubscriptionId: string): Promise<CancelResult>;
}
