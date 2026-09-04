import type { MerchantOfRecordAdapter, BillingEvent, CancelResult } from "./types.js";
import { WebhookSignatureError } from "./types.js";

// Placeholder until the real Paddle account exists and this is swapped for
// the real adapter — same reasoning as the platform StubAdapter.
// routes.ts/webhook.ts don't need to change since they only depend on
// MerchantOfRecordAdapter.
//
// Found 2026-09-04 by the newly-CI-wired security test (which deliberately
// runs with no Paddle credentials, so it exercises this stub, not the real
// PaddleMorAdapter): parseWebhookEvent used to accept ANY POST body as a
// verified billing event -- it never even looked at the signature header,
// so "verification" was a no-op. Never reachable in real production
// (index.ts refuses to boot with PADDLE_ENVIRONMENT=production unless real
// MOR credentials are present, so the live app always uses the real
// adapter, confirmed live) -- but it meant the stub silently broke the
// same security contract the real adapter enforces, and the only thing
// that had been exercising this path before today was ad hoc local dev,
// never a test asserting the rejection actually happens. A fixed shared
// secret (falls back to a stub-only literal if MOR_WEBHOOK_SECRET isn't
// set, since nothing production-real is ever signing against this stub)
// keeps the contract identical in shape to the live adapter: no valid
// signature, no event.
const STUB_WEBHOOK_SECRET = process.env.MOR_WEBHOOK_SECRET || "stub-mode-not-a-real-secret";

export class StubMorAdapter implements MerchantOfRecordAdapter {
  async parseWebhookEvent(rawBody: string, signatureHeader: string): Promise<BillingEvent> {
    if (signatureHeader !== STUB_WEBHOOK_SECRET) {
      throw new WebhookSignatureError("Webhook signature verification failed (stub adapter)");
    }
    const parsed = JSON.parse(rawBody);
    return {
      kind: "tier",
      morSubscriptionId: parsed.subscriptionId ?? "stub_sub",
      accountEmail: parsed.email ?? "unknown@lazyrelay.invalid",
      tier: parsed.tier ?? "free",
      status: parsed.status ?? "active",
      currentPeriodEnd: parsed.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      occurredAt: parsed.occurredAt ?? new Date().toISOString(),
    };
  }

  async cancelSubscription(morSubscriptionId: string): Promise<CancelResult> {
    console.log(`[stub] would cancel ${morSubscriptionId} with the real MoR`);
    return { success: true, errorMessage: null };
  }

  async changeSubscriptionTier(morSubscriptionId: string, priceId: string, tier: string): Promise<CancelResult> {
    console.log(`[stub] would change ${morSubscriptionId} to price ${priceId} (tier ${tier}) with the real MoR`);
    return { success: true, errorMessage: null };
  }

  async revokeSubscriptionImmediately(morSubscriptionId: string): Promise<CancelResult> {
    console.log(`[stub] would immediately revoke ${morSubscriptionId} with the real MoR`);
    return { success: true, errorMessage: null };
  }
}
