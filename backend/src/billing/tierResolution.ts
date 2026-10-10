import type { Tier } from "../tier.js";

// Tier resolution for Paddle: which internal tier code does a price id, or a
// tier string read back from Paddle, stand for?
//
// Migration 0119 renamed the stored codes to match the public plan names
// (pro -> starter, business -> pro, enterprise -> business). Paddle keeps the
// customData we embedded at checkout for the whole life of a subscription, so
// every subscription created before the rename still echoes the OLD codes on
// every renewal/update webhook, forever, until a change-tier rewrites it. The
// old and new meanings of "pro" and "business" collide (old "pro" was
// Starter, new "pro" is Pro), so a bare "pro" or "business" read from
// customData cannot be trusted by string alone.
//
// The authority is therefore the Paddle PRICE ID on the subscription's items,
// looked up through the PADDLE_PRICE_ID_* env vars below (the env var NAMES
// were deliberately not renamed, they always followed the public plan name).
// customData.tier is only a fallback for the codes that are unambiguous.

export const PAID_TIERS = ["starter", "pro", "business", "agency", "agency_plus"] as const;
export type PaidTier = (typeof PAID_TIERS)[number];

/** Tier codes a Paddle payload may legitimately resolve to (everything the
 *  database CHECK constraint allows). */
export const VALID_TIERS = ["free", ...PAID_TIERS] as const satisfies readonly Tier[];

/** The env var holding each paid tier's Paddle price id. Used in both
 *  directions: checkout/change-tier turn a tier into a price id, the webhook
 *  turns a price id back into a tier. */
export const TIER_PRICE_ID_ENV_VARS: Record<PaidTier, string> = {
  starter: "PADDLE_PRICE_ID_STARTER",
  pro: "PADDLE_PRICE_ID_PRO",
  business: "PADDLE_PRICE_ID_BUSINESS",
  agency: "PADDLE_PRICE_ID_AGENCY",
  agency_plus: "PADDLE_PRICE_ID_AGENCY_PLUS",
};

type Env = Record<string, string | undefined>;

export function priceIdForTier(tier: PaidTier, env: Env = process.env): string | undefined {
  return env[TIER_PRICE_ID_ENV_VARS[tier]] || undefined;
}

/** Reverse lookup: the paid tier whose configured price id is `priceId`, or
 *  null if it matches none (an add-on price, a retired price, an env var that
 *  is not set). */
export function tierForPriceId(priceId: string, env: Env = process.env): PaidTier | null {
  if (!priceId) return null;
  for (const tier of PAID_TIERS) {
    if (priceIdForTier(tier, env) === priceId) return tier;
  }
  return null;
}

/** The new code that each pre-rename code stands for. Only used to tell an
 *  expected legacy spelling apart from a genuine disagreement in logs; never
 *  used to decide a tier (old "pro"/"business" are ambiguous, see above). */
export const LEGACY_TIER_EQUIVALENT: Record<string, Tier | undefined> = {
  pro: "starter",
  business: "pro",
  enterprise: "business",
};

export type WebhookTierResolution =
  | { tier: Tier; source: "price_id" | "custom_data" }
  | { tier: null; reason: string };

/** Resolves the tier a subscription webhook stands for.
 *
 *  1. Price id (authoritative): if any of the subscription's price ids is a
 *     configured tier price, that is the tier, whatever customData says. If
 *     the items map to two different tiers the payload is contradictory and
 *     is treated as unresolved.
 *  2. customData.tier, ONLY for strings that mean the same thing before and
 *     after the rename: "enterprise" (old code for Business) becomes
 *     "business"; "starter", "agency", "agency_plus" and "free" never meant
 *     anything else.
 *  3. A bare "pro" or "business" with no resolvable price id is ambiguous
 *     (old Starter/Pro or new Pro/Business), so it fails closed: the caller
 *     must leave the account's stored tier unchanged and log the warning.
 *
 *  Anything that is not a known tier string at all (missing, garbage) throws,
 *  same as before the rename: that is a malformed payload, not an ambiguity. */
export function resolveWebhookTier(customDataTier: unknown, priceIds: readonly string[], env: Env = process.env): WebhookTierResolution {
  const fromPrices = new Set<PaidTier>();
  for (const priceId of priceIds) {
    const tier = tierForPriceId(priceId, env);
    if (tier) fromPrices.add(tier);
  }
  if (fromPrices.size > 1) {
    return { tier: null, reason: `price ids map to conflicting tiers (${[...fromPrices].join(", ")})` };
  }
  if (fromPrices.size === 1) {
    return { tier: [...fromPrices][0], source: "price_id" };
  }

  if (customDataTier === "enterprise") return { tier: "business", source: "custom_data" };
  if (customDataTier === "pro" || customDataTier === "business") {
    return {
      tier: null,
      reason: `customData.tier "${customDataTier}" is ambiguous between the pre- and post-rename codes and no price id matched a configured tier price`,
    };
  }
  if (typeof customDataTier === "string" && (VALID_TIERS as readonly string[]).includes(customDataTier)) {
    return { tier: customDataTier as Tier, source: "custom_data" };
  }
  throw new Error(`invalid/missing customData.tier "${String(customDataTier)}" and no price id matched a configured tier price`);
}
