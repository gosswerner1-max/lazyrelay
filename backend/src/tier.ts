import { supabase } from "./supabase.js";

/** Internal database tier codes match the public plan names exactly (renamed
 *  in migration 0119; before that, "pro" stored Starter, "business" stored
 *  Pro and "enterprise" stored Business, a historical offset left over from
 *  the 2026-07-23 restructure). Anything that reads a tier code from OUTSIDE
 *  the database (Paddle custom data on subscriptions created before the
 *  rename, old stored metadata) must go through billing/tierResolution.ts,
 *  because the old and new meanings of "pro" and "business" collide.
 */
export type Tier = "free" | "starter" | "pro" | "business" | "agency" | "agency_plus";

export const TIER_DISPLAY_NAMES: Record<Tier, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
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
 *  cap. `null` = unlimited. Keyed by DB code (matches the public plan name).
 */
export const RECURRING_SCHEDULE_SLOT_LIMITS: Record<Tier, number | null> = {
  free: 0,
  starter: 3,
  pro: 5,
  business: null, // unlimited
  agency: null, // unlimited, mirrors business
  agency_plus: null, // unlimited, mirrors business
};

/** RSS feed caps (2026-09-30, Werner approved): a paid convenience feature, capped per
 *  plan like recurring schedules. Free has none. Keyed by DB code (matches the public plan name). */
export const RSS_FEED_LIMITS: Record<Tier, number> = {
  free: 0,
  starter: 1,
  pro: 3,
  business: 5,
  agency: 5,
  agency_plus: 5,
};

/** Active client review links (master list #23): two per brand the plan allows, since a client
 *  often has more than one person approving. Free has none. Keyed by DB code (matches the
 *  public plan name). Werner decided 2026-09-30. */
export const REVIEW_LINK_LIMITS: Record<Tier, number> = {
  free: 0,
  starter: 4, // 2 brands
  pro: 8, // 4 brands
  business: 14, // 7 brands
  agency: 24, // 12 brands
  agency_plus: 40, // 20 brands
};

export async function resolveTier(accountId: string): Promise<Tier> {
  const { data } = await supabase.from("subscriptions").select("tier, status").eq("account_id", accountId).maybeSingle();
  const isPaidInGoodStanding = data?.tier !== "free" && (data?.status === "active" || data?.status === "trialing");
  return isPaidInGoodStanding ? (data!.tier as Tier) : "free";
}

/** X "bring your own key" (BYOK) plan gate (Werner, 2026-10-10). The ONE place that decides who may connect X with
 *  their own developer keys: Pro, Business, Agency and Agency Plus. Free and Starter are blocked entirely. Every
 *  caller (GET /platforms, the keys route, the generic connect route) goes through canUseXByok; the frontend never
 *  decides. Keyed by DB tier code, which matches the public plan name. */
export const X_BYOK_ALLOWED_TIERS: ReadonlySet<Tier> = new Set<Tier>(["pro", "business", "agency", "agency_plus"]);

/** The cheapest plan that unlocks X BYOK, in public wording, for "Upgrade to ..." copy. */
export const X_BYOK_REQUIRED_PLAN_NAME = TIER_DISPLAY_NAMES.pro;

export function canUseXByok(tier: Tier): boolean {
  return X_BYOK_ALLOWED_TIERS.has(tier);
}
