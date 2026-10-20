import { SKU, type SkuId } from "../wallet/catalog.js";
import type { PlanId } from "../wallet/plans.js";

// Paddle does NOT echo a price's own custom_data on a webhook, so the wallet SKU of a payment is found by its PRICE ID, through env
// vars (the ids are never written in source). A price id that matches none of these belongs to the old six tier path and is left
// to it, unchanged. Same shape as TIER_PRICE_ID_ENV_VARS in tierResolution.ts.

type Env = Record<string, string | undefined>;

export const SKU_PRICE_ENV_VARS: Record<SkuId, string> = {
  [SKU.starterPack]: "PADDLE_PRICE_ID_LC_STARTER_PACK",
  [SKU.growthPack]: "PADDLE_PRICE_ID_LC_GROWTH_PACK",
  [SKU.proTopUp]: "PADDLE_PRICE_ID_LC_PRO_TOPUP",
  [SKU.growthPlan]: "PADDLE_PRICE_ID_GROWTH_PLAN",
  [SKU.proPlan]: "PADDLE_PRICE_ID_PRO_PLAN",
};

const SKUS = Object.keys(SKU_PRICE_ENV_VARS) as SkuId[];

export function priceIdForSku(sku: SkuId, env: Env = process.env): string | undefined {
  return env[SKU_PRICE_ENV_VARS[sku]] || undefined;
}

/** The sku whose configured price id is `priceId`, or null (an old tier price, an add-on price, an env var that is not set). */
export function skuForPriceId(priceId: string, env: Env = process.env): SkuId | null {
  if (!priceId) return null;
  for (const sku of SKUS) {
    if (priceIdForSku(sku, env) === priceId) return sku;
  }
  return null;
}

/** The one sku among a payload's line items, null when none is a wallet price. Two different skus on one payload is contradictory: it throws. */
export function skuForPriceIds(priceIds: readonly string[], env: Env = process.env): SkuId | null {
  const found = new Set<SkuId>();
  for (const id of priceIds) {
    const sku = skuForPriceId(id, env);
    if (sku) found.add(sku);
  }
  if (found.size > 1) throw new Error(`the payload has more than one wallet sku (${[...found].join(", ")})`);
  return found.size === 1 ? [...found][0] : null;
}

/** The wallet plan a subscription sku puts the account on; null for a pack. */
export function walletPlanForSku(sku: SkuId): PlanId | null {
  if (sku === SKU.growthPlan) return "growth";
  if (sku === SKU.proPlan) return "pro";
  return null;
}
