import type { MerchantOfRecordAdapter, SubscriptionEvent, CancelResult } from "./types.js";

// Placeholder until Paddle vs Lemon Squeezy is decided and that account
// exists — same reasoning as the platform StubAdapter. Swap this for the
// real adapter later; routes.ts/webhook.ts don't need to change since they
// only depend on MerchantOfRecordAdapter.
export class StubMorAdapter implements MerchantOfRecordAdapter {
  parseWebhookEvent(rawBody: string): SubscriptionEvent {
    const parsed = JSON.parse(rawBody);
    return {
      morSubscriptionId: parsed.subscriptionId ?? "stub_sub",
      accountEmail: parsed.email ?? "unknown@lazyrelay.invalid",
      tier: parsed.tier ?? "solo",
      status: parsed.status ?? "active",
      currentPeriodEnd: parsed.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    };
  }

  async cancelSubscription(morSubscriptionId: string): Promise<CancelResult> {
    console.log(`[stub] would cancel ${morSubscriptionId} with the real MoR`);
    return { success: true, errorMessage: null };
  }
}
