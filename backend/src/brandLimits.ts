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
 *  Agency-tier conversation, not a Business plan. Paid tiers will additionally
 *  allow buying extra brands as an overage (Phase 1b, not yet built).
 */
export const BRAND_LIMITS: Record<Tier, number> = {
  free: 1,
  pro: 2, // displays as "Starter"
  business: 4, // displays as "Pro"
  enterprise: 7, // displays as "Business"
};

/** Checked before creating a new brand — returns a customer-facing reason if
 *  the account is already at its plan's brand limit, else null. Same shape as
 *  checkAccountLimit in accountLimits.ts. */
export async function checkBrandLimit(accountId: string): Promise<string | null> {
  const tier = await resolveTier(accountId);
  const limit = BRAND_LIMITS[tier];

  const { count, error } = await supabase
    .from("brands")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (error) throw error;

  if ((count ?? 0) >= limit) {
    return `You've reached your plan's limit of ${limit} ${limit === 1 ? "brand" : "brands"}. Delete one, or upgrade for more.`;
  }
  return null;
}
