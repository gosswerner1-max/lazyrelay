import type { Tier } from "../tier.js";
import type { PlanId } from "./plans.js";

/**
 * The wallet plan ids used by the SQL functions, and the Tier each one is enforced as. The wallet's `pro` is the tier `lazy_pro`, never
 * the tier `pro` (that is the older Starter-above plan and stays untouched). `payg` is derived by resolveTier, not stored.
 */
export const WALLET_PLAN_TIERS: Readonly<Record<PlanId, Tier>> = {
  free: "free",
  payg: "payg",
  growth: "growth",
  pro: "lazy_pro",
};

const TIER_WALLET_PLANS = new Map<Tier, PlanId>(Object.entries(WALLET_PLAN_TIERS).map(([plan, tier]) => [tier, plan as PlanId]));

/** The wallet plan a tier belongs to, or null for the old paid tiers (they are grandfathered and never use the wallet plans). */
export function walletPlanForTier(tier: Tier): PlanId | null {
  return TIER_WALLET_PLANS.get(tier) ?? null;
}

/** The tier a wallet plan is enforced as. */
export function tierForWalletPlan(plan: PlanId): Tier {
  return WALLET_PLAN_TIERS[plan];
}
