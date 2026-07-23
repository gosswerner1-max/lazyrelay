import { supabase } from "./supabase.js";
import { resolveTier, type Tier } from "./tier.js";

/** Real per-tier connected-account caps, added 2026-07-23 alongside the
 *  Starter/Pro/Business restructure. Deliberately NOT unlimited even at
 *  the top tier — an uncapped plan would let a large company connect
 *  hundreds of accounts through LazyRelay for a flat $79.99/mo, which is
 *  both (1) a disproportionate share of LazyRelay's own shared app-level
 *  API quota with Meta/TikTok/Pinterest, degrading service for every other
 *  customer on that platform, and (2) a classic SaaS underpricing mistake —
 *  genuinely enterprise-scale usage at a small-business price. A company
 *  that outgrows 100 accounts is a "contact us" conversation, not a
 *  self-serve plan. Before this, account limits existed only as marketing
 *  copy — nothing in the code actually enforced them.
 */
export const ACCOUNT_LIMITS: Record<Tier, number> = {
  free: 3,
  pro: 20, // displays as "Starter"
  business: 40, // displays as "Pro"
  enterprise: 100, // displays as "Business"
};

/** Checked before starting a new connect flow — returns a customer-facing
 *  reason if the account is already at its plan's connected-account limit. */
export async function checkAccountLimit(accountId: string): Promise<string | null> {
  const tier = await resolveTier(accountId);
  const limit = ACCOUNT_LIMITS[tier];

  const { count, error } = await supabase
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .is("disconnected_at", null);
  if (error) throw error;

  if ((count ?? 0) >= limit) {
    return `You've reached your plan's limit of ${limit} connected accounts. Disconnect one, or upgrade for more.`;
  }
  return null;
}
