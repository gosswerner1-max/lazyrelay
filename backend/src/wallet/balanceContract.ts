import { ACCOUNT_LIMITS } from "../accountLimits.js";
import { BRAND_LIMITS, UNLIMITED_BRANDS } from "../brandLimits.js";
import { FREE_QUEUE_CAP } from "../queueCap.js";
import { TIER_DISPLAY_NAMES, type Tier } from "../tier.js";
import { MICRO_PER_USD } from "./money.js";
import { WALLET_PRICES_MICRO } from "./prices.js";
import { minActionPriceMicro } from "./rules.js";
import type { BalanceView } from "./service.js";
import { walletPlanForTier } from "./tierMap.js";

// The shape GET /wallet/balance answers in, which is the shape the website reads (frontend/src/lib/walletApi.ts, readWallet). The service's
// own view (micro credits by lot kind) is kept and sent too, so nothing that read it before breaks. Whole credits are rounded DOWN, so the
// screen never promises a credit the wallet does not have. Both ends are tested against the same files in /contracts.

export interface WalletContext {
  tier: Tier;
  legacy: boolean;
  cancelPending: boolean;
  /** True only when wallet mode is exactly "on" (charges and pauses are real). */
  walletOn: boolean;
}

const credits = (micro: number): number => Math.floor(Math.max(0, micro) / MICRO_PER_USD);

export function toWalletContract(view: BalanceView, ctx: WalletContext) {
  const planName = TIER_DISPLAY_NAMES[ctx.tier];
  const lots = view.lots
    .map((lot) => ({
      kind: lot.kind,
      remaining: credits(lot.remainingMicro - lot.reservedMicro),
      expiresAt: lot.expiresAt,
      ...(lot.boundPlan === "pro" ? { boundPlan: "pro" as const } : {}),
      ...(lot.kind === "subscription" ? { autoRenew: !ctx.cancelPending, planName } : {}),
    }))
    .filter((lot) => lot.remaining > 0);
  const brands = BRAND_LIMITS[ctx.tier];
  return {
    ...view,
    exempt: ctx.legacy,
    balance: credits(view.spendableMicro),
    held: credits(view.heldMicro),
    lots,
    nextExpiry: view.nextExpiryAt !== null && view.nextExpiryMicro !== null ? { at: view.nextExpiryAt, credits: credits(view.nextExpiryMicro) } : null,
    // Same rule the publisher uses (wallet/pause.ts): a real wallet that cannot pay for the cheapest action. Never for a grandfathered account.
    paused: ctx.walletOn && !ctx.legacy && view.spendableMicro < minActionPriceMicro(),
    plan: {
      tier: ctx.tier,
      walletPlan: walletPlanForTier(ctx.tier),
      caps: { accounts: ACCOUNT_LIMITS[ctx.tier], brands: brands >= UNLIMITED_BRANDS ? null : brands, queued: ctx.tier === "free" && !ctx.legacy ? FREE_QUEUE_CAP : null },
    },
    prices: { post_publish: credits(WALLET_PRICES_MICRO.post_publish), competitor_teardown: credits(WALLET_PRICES_MICRO.competitor_teardown) },
  };
}
