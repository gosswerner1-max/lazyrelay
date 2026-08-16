import { supabase } from "./supabase.js";
import { resolveTier, type Tier } from "./tier.js";

/** Per-tier brand caps, added 2026-08-16 alongside the brands table
 *  (migration 0047). Closes the pricing leak where unlimited brands on any
 *  plan let one login run an agency's worth of client businesses for a flat
 *  fee. A "brand" groups connected accounts by business for filtering — still
 *  one login / one subscription, NOT multi-tenant workspaces with separate
 *  billing. Keyed by DB code — see the Tier type comment in tier.ts for why
 *  "pro" here DISPLAYS as "Starter". Deliberately capped even at the top
 *  self-serve tier: an agency running many client brands is a Phase-2
 *  Agency-tier conversation, not a Business plan.
 */
export const BRAND_LIMITS: Record<Tier, number> = {
  free: 1,
  pro: 2, // displays as "Starter"
  business: 4, // displays as "Pro"
  enterprise: 7, // displays as "Business"
};

/** Phase 1b (2026-08-16) — a paid customer can exceed their base brand cap by
 *  buying add-ons, one brand slot each, ~$10/mo (anchored to SocialBee's own
 *  $10/workspace add-on). Free tier can't buy add-ons, same rule as storage
 *  add-ons — see the free-tier check in routes.ts's POST /brand-addons/checkout.
 *  Counts only active/trialing rows, same convention as
 *  storageQuota.ts's getActiveAddonBytes. */
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
  const { totalLimit, addonSlots } = await getBrandCapacity(accountId);

  const { count, error } = await supabase
    .from("brands")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (error) throw error;

  if ((count ?? 0) >= totalLimit) {
    const upgradeHint = addonSlots > 0 ? "upgrade, or buy another brand add-on" : "upgrade for more, or buy a brand add-on";
    return `You've reached your plan's limit of ${totalLimit} ${totalLimit === 1 ? "brand" : "brands"}. Delete one, or ${upgradeHint}.`;
  }
  return null;
}
