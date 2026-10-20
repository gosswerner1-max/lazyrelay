import { CATALOG, SKU, isSku, type SkuId, type SkuKind } from "./catalog.js";
import { walletPlanForTier } from "./tierMap.js";
import type { Tier } from "../tier.js";

/** Amounts here are data for the page to show "plus tax". No tax is computed: Paddle adds it at checkout. */
const CURRENCY = "USD";
const TAX_NOTE = "plus tax";

export interface CheckoutIntent {
  sku: SkuId;
  name: string;
  kind: SkuKind;
  credits: number;
  priceCents: number;
  currency: typeof CURRENCY;
  taxNote: typeof TAX_NOTE;
  expires: boolean;
}

export type IntentResult =
  | { ok: true; intent: CheckoutIntent }
  | { ok: false; status: 400; error: "unknown_sku" }
  | { ok: false; status: 403; error: "plan_required"; requiredPlan: string };

/**
 * Validates a purchase request. The Pro only gate (a SKU with requiresPlan) holds when the account's wallet plan, derived from its
 * tier, is that plan. The old paid tiers (starter, pro, business ...) have no wallet plan, so they never pass it. The database repeats
 * the same check when the credits are granted, so this is the polite early answer, not the only guard.
 */
export function buildCheckoutIntent(sku: unknown, tier: Tier): IntentResult {
  if (!isSku(sku) || !CATALOG[sku].active) return { ok: false, status: 400, error: "unknown_sku" };
  const entry = CATALOG[sku];
  if (entry.requiresPlan !== null && walletPlanForTier(tier) !== entry.requiresPlan) {
    return { ok: false, status: 403, error: "plan_required", requiredPlan: entry.requiresPlan };
  }
  return { ok: true, intent: { sku, name: entry.name, kind: entry.kind, credits: entry.credits, priceCents: entry.priceCents, currency: CURRENCY, taxNote: TAX_NOTE, expires: entry.expires } };
}

/** A wallet_packs row as the database returns it. */
export interface PackRow {
  sku: string;
  name: string;
  kind: SkuKind;
  price_cents: number;
  credits: number;
  expires: boolean;
  interval: "one_time" | "month";
  requires_plan: string | null;
  active: boolean;
}

export interface CatalogItem {
  sku: string;
  name: string;
  kind: SkuKind;
  priceCents: number;
  currency: typeof CURRENCY;
  taxNote: typeof TAX_NOTE;
  credits: number;
  expires: boolean;
  interval: "one_time" | "month";
  requiresPlan: string | null;
  description: string;
  purchasable: boolean;
  reason: CatalogReason | null;
}

export type CatalogReason = "needs_pro" | "already_subscribed" | "legacy_account" | "plan_ending";

/** What the catalog needs to know about the signed in account to say what it can buy right now. */
export interface CatalogContext {
  tier: Tier;
  legacy: boolean;
  /** The subscription is scheduled to end at the period end. */
  cancelPending: boolean;
}

/** The wallet plan each subscription SKU sells. */
const SUBSCRIPTION_PLAN: Partial<Record<SkuId, string>> = { [SKU.growthPlan]: "growth", [SKU.proPlan]: "pro" };

function reasonFor(sku: SkuId, requiresPlan: string | null, ctx: CatalogContext): CatalogReason | null {
  if (ctx.legacy) return "legacy_account";
  const plan = walletPlanForTier(ctx.tier);
  if (requiresPlan !== null) {
    if (plan !== requiresPlan) return "needs_pro";
    return ctx.cancelPending ? "plan_ending" : null;
  }
  const sold = SUBSCRIPTION_PLAN[sku];
  return sold !== undefined && sold === plan ? "already_subscribed" : null;
}

function purchasability(reason: CatalogReason | null): { purchasable: boolean; reason: CatalogReason | null } {
  return { purchasable: reason === null, reason };
}

/** The sellable list: active database rows that the code also knows (the copy comes from catalog.ts). Anything else is not shown. */
export function buildCatalogView(rows: PackRow[], ctx: CatalogContext): CatalogItem[] {
  const items: CatalogItem[] = [];
  for (const row of rows) {
    if (!row.active || !isSku(row.sku)) continue;
    items.push({
      sku: row.sku,
      name: row.name,
      kind: row.kind,
      priceCents: row.price_cents,
      currency: CURRENCY,
      taxNote: TAX_NOTE,
      credits: row.credits,
      // A plan-bound pack lasts only while the plan does, so the page must not say it never expires. View only; the database is unchanged.
      expires: row.expires || row.requires_plan !== null,
      interval: row.interval,
      requiresPlan: row.requires_plan,
      description: CATALOG[row.sku].description,
      ...purchasability(reasonFor(row.sku, row.requires_plan, ctx)),
    });
  }
  return items;
}
