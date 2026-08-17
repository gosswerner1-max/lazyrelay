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
export type Tier = "free" | "pro" | "business" | "enterprise" | "agency" | "agency_plus";

export const TIER_DISPLAY_NAMES: Record<Tier, string> = {
  free: "Free",
  pro: "Starter",
  business: "Pro",
  enterprise: "Business",
  agency: "Agency",
  agency_plus: "Agency Plus",
};

/** Recurring-schedule slot caps, added 2026-07-29. Free has none — one-off
 *  scheduling only. Every paid tier gets a real cap on distinct weekly
 *  content cadences (NOT on posting volume or platform count — a single
 *  slot can already target every connected platform at once), landed on
 *  after considering a flat "any paid tier = unlimited" gate: a real
 *  per-tier number gives a cleaner, more marketable upgrade ladder and
 *  ties access to something the customer actually values (how many
 *  distinct content cadences they run), rather than an arbitrary resource
 *  cap. `null` = unlimited. Keyed by DB code — see the Tier type comment
 *  above for why "pro" here means the tier that DISPLAYS as "Starter".
 */
export const RECURRING_SCHEDULE_SLOT_LIMITS: Record<Tier, number | null> = {
  free: 0,
  pro: 3, // displays as "Starter"
  business: 5, // displays as "Pro"
  enterprise: null, // displays as "Business" — unlimited
  agency: null, // unlimited, mirrors enterprise
  agency_plus: null, // unlimited, mirrors enterprise
};

export async function resolveTier(accountId: string): Promise<Tier> {
  const { data } = await supabase.from("subscriptions").select("tier, status").eq("account_id", accountId).maybeSingle();
  const isPaidInGoodStanding = data?.tier !== "free" && (data?.status === "active" || data?.status === "trialing");
  return isPaidInGoodStanding ? (data!.tier as Tier) : "free";
}
