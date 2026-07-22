import type { MerchantOfRecordAdapter, SubscriptionEvent, CancelResult } from "./types.js";

// Placeholder until the real Paddle account exists and this is swapped for
// the real adapter — same reasoning as the platform StubAdapter.
// routes.ts/webhook.ts don't need to change since they only depend on
// MerchantOfRecordAdapter.
export class StubMorAdapter implements MerchantOfRecordAdapter {
  async parseWebhookEvent(rawBody: string): Promise<SubscriptionEvent> {
    const parsed = JSON.parse(rawBody);
    return {
      morSubscriptionId: parsed.subscriptionId ?? "stub_sub",
      accountEmail: parsed.email ?? "unknown@lazyrelay.invalid",
      tier: parsed.tier ?? "free",
      status: parsed.status ?? "active",
      currentPeriodEnd: parsed.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    };
  }

  async cancelSubscription(morSubscriptionId: string): Promise<CancelResult> {
    console.log(`[stub] would cancel ${morSubscriptionId} with the real MoR`);
    return { success: true, errorMessage: null };
  }
}
