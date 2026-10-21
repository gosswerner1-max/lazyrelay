import { supabase } from "./supabase.js";
import { resolveTier, type Tier } from "./tier.js";

/** Per-tier brand caps, added 2026-08-16 alongside the brands table
 *  (migration 0047). Closes the pricing leak where unlimited brands on any
 *  plan let one login run an agency's worth of client businesses for a flat
 *  fee. A "brand" groups connected accounts by business for filtering — still
 *  one login / one subscription, NOT multi-tenant workspaces with separate
 *  billing. Keyed by DB code, which
 *  matches the public plan name (see tier.ts). Deliberately capped even at the top
 *  self-serve tier: an agency running many client brands is a Phase-2
 *  Agency-tier conversation, not a Business plan.
 */
/** Stands for "no brand limit" (the Pro plan). A number rather than Infinity so the arithmetic and the "N/cap" displays stay finite. */
export const UNLIMITED_BRANDS = 1_000_000;

export const BRAND_LIMITS: Record<Tier, number> = {
  free: 1,
  starter: 2,
  pro: 4,
  business: 7,
  agency: 12, // Agency tier (2026-08-17)
  agency_plus: 20, // Agency Plus
  payg: 2, // mirrors starter
  growth: 4,
  lazy_pro: UNLIMITED_BRANDS,
};

/** Brand add-ons are no longer sold (2026-10-20): the checkout route answers 410, so no new row can be created. Rows that
 *  already exist (active/trialing) are still honoured so existing subscribers keep the slot they paid for until they cancel.
 *  Counts only active/trialing rows, same convention as storageQuota.ts getActiveAddonBytes. */
export async function getActiveBrandAddonSlots(accountId: string): Promise<number> {
  const { count, error } = await supabase
    .from("brand_addons")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .in("status", ["active", "trialing"]);
  if (error) throw error;
  return count ?? 0;
}

/** The real effective cap for this account right now: base tier allowance
 *  plus any purchased add-on slots. Used both to enforce the limit and to
 *  display "N/cap" honestly once add-ons exist. */
export async function getBrandCapacity(accountId: string): Promise<{ tier: Tier; baseLimit: number; addonSlots: number; totalLimit: number }> {
  const tier = await resolveTier(accountId);
  const baseLimit = BRAND_LIMITS[tier];
  const addonSlots = await getActiveBrandAddonSlots(accountId);
  return { tier, baseLimit, addonSlots, totalLimit: baseLimit + addonSlots };
}

/** Checked before creating a new brand — returns a customer-facing reason if
 *  the account is already at its plan's (base + purchased add-ons) brand
 *  limit, else null. Same shape as checkAccountLimit in accountLimits.ts. */
export async function checkBrandLimit(accountId: string): Promise<string | null> {
  const { totalLimit } = await getBrandCapacity(accountId);

  const { count, error } = await supabase
    .from("brands")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (error) throw error;

  if ((count ?? 0) >= totalLimit) {
    if (totalLimit >= UNLIMITED_BRANDS) return "Your plan has no brand limit, but this account has reached the maximum we can hold. Please contact support.";
    return `You've reached your plan's limit of ${totalLimit} ${totalLimit === 1 ? "brand" : "brands"}. Delete one, or upgrade your plan.`;
  }
  return null;
}
