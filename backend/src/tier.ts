import { supabase } from "./supabase.js";

/** Internal database tier codes are deliberately NOT the same as the
 *  customer-facing plan names, to avoid a live-data migration when the
 *  naming was restructured 2026-07-23 (Free/Pro/Business ->
 *  Free/Starter/Pro/Business). The old "pro" and "business" DB values keep
 *  their existing rows and meaning at the storage layer; only what they
 *  DISPLAY as changed. "enterprise" is the one genuinely new code, added
 *  purely additively (see migration 0011) — no existing subscriber rows
 *  needed to change at all, unlike the earlier 0006 tier-rename migration
 *  that caused a real production incident when it wasn't actually applied.
 */
export type Tier = "free" | "pro" | "business" | "enterprise";

export const TIER_DISPLAY_NAMES: Record<Tier, string> = {
  free: "Free",
  pro: "Starter",
  business: "Pro",
  enterprise: "Business",
};

export async function resolveTier(accountId: string): Promise<Tier> {
  const { data } = await supabase.from("subscriptions").select("tier, status").eq("account_id", accountId).maybeSingle();
  const isPaidInGoodStanding = data?.tier !== "free" && (data?.status === "active" || data?.status === "trialing");
  return isPaidInGoodStanding ? (data!.tier as Tier) : "free";
}
