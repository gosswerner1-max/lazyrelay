import { supabase } from "./supabase.js";
import { walletMode } from "./wallet/mode.js";

/** Internal database tier codes match the public plan names exactly (renamed
 *  in migration 0119; before that, "pro" stored Starter, "business" stored
 *  Pro and "enterprise" stored Business, a historical offset left over from
 *  the 2026-07-23 restructure). Anything that reads a tier code from OUTSIDE
 *  the database (Paddle custom data on subscriptions created before the
 *  rename, old stored metadata) must go through billing/tierResolution.ts,
 *  because the old and new meanings of "pro" and "business" collide.
 */
export type Tier = "free" | "starter" | "pro" | "business" | "agency" | "agency_plus" | "payg" | "growth" | "lazy_pro";

/** Wallet plans, added alongside the six tiers above (which stay for grandfathered accounts). `payg` is DERIVED by resolveTier
 *  and never stored in subscriptions. `growth` and `lazy_pro` are stored. `lazy_pro` is the new Pro plan; the code is not
 *  `pro` because `pro` is the older $59.99 plan and must stay as it is. */

/** The tier codes a subscriptions row can hold (everything except the derived `payg`). */
export type StoredTier = Exclude<Tier, "payg">;

export const TIER_DISPLAY_NAMES: Record<Tier, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
  agency: "Agency",
  agency_plus: "Agency Plus",
  payg: "Pay as you go",
  growth: "Growth",
  lazy_pro: "Pro",
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
  payg: 3, // mirrors starter
  growth: 5, // mirrors the old pro
  lazy_pro: null, // mirrors agency_plus
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
  payg: 1, // mirrors starter
  growth: 3, // mirrors the old pro
  lazy_pro: 5, // mirrors agency_plus
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
  payg: 4, // 2 brands, mirrors starter
  growth: 8, // 4 brands, mirrors the old pro
  lazy_pro: 40, // mirrors agency_plus
};

/** True when the account has unlocked pay as you go (accounts.payg_unlocked_at is set). An unreadable row counts as not unlocked, so a
 *  failed read can only ever lower the limits, never raise them. Free accounts have no subscriptions row, so the column cannot ride on
 *  the subscription query; this is the one extra read, made only when wallet mode is "on" and the subscription resolved to free. */
async function isPaygUnlocked(accountId: string): Promise<boolean> {
  const { data, error } = await supabase.from("accounts").select("payg_unlocked_at").eq("id", accountId).maybeSingle();
  return !error && data?.payg_unlocked_at != null;
}

export async function resolveTier(accountId: string): Promise<Tier> {
  const { data } = await supabase.from("subscriptions").select("tier, status").eq("account_id", accountId).maybeSingle();
  const isPaidInGoodStanding = data?.tier !== "free" && (data?.status === "active" || data?.status === "trialing");
  if (isPaidInGoodStanding) return data!.tier as Tier;
  // payg is derived: a free account that has unlocked pay as you go. Only wallet mode "on" takes this branch; off and shadow never do.
  if (walletMode() === "on" && (await isPaygUnlocked(accountId))) return "payg";
  return "free";
}

/** X "bring your own key" (BYOK) plan gate (Werner, 2026-10-10; opened to every paid tier 2026-10-16). The ONE place that decides who
 *  may connect X with their own developer keys: every PAID tier, Starter, Pro, Business, Agency and Agency Plus. Free and lapsed
 *  accounts are blocked (resolveTier counts a lapsed plan as free). The customer pays X directly, so there is no metering. Every
 *  caller (GET /platforms, the keys route, the generic connect route) goes through canUseXByok; the frontend never decides. Keyed by
 *  DB tier code, which matches the public plan name. */
export const X_BYOK_ALLOWED_TIERS: ReadonlySet<Tier> = new Set<Tier>(["starter", "pro", "business", "agency", "agency_plus", "growth", "lazy_pro", "payg"]);

/** The cheapest plan that unlocks X BYOK, in public wording, for "Upgrade to ..." copy. */
export const X_BYOK_REQUIRED_PLAN_NAME = TIER_DISPLAY_NAMES.starter;

export function canUseXByok(tier: Tier): boolean {
  return X_BYOK_ALLOWED_TIERS.has(tier);
}

/** WhatsApp "bring your own key" (BYOK) plan gate (Werner, 2026-10-10; opened to every paid tier 2026-10-16). The customer links their
 *  OWN Meta WhatsApp Business credentials and Meta bills them directly, so LazyRelay carries no per-message cost and meters nothing.
 *  Every PAID tier may use it: Starter, Pro, Business, Agency and Agency Plus. Free and lapsed accounts are blocked. The ONE place
 *  that decides it: every caller (GET /platforms, the keys route, the generic connect route, the broadcast and chat routes) goes
 *  through canUseWhatsappByok / checkWhatsappPlan; the frontend never decides. Keyed by DB tier code (the plan name). */
export const WHATSAPP_BYOK_ALLOWED_TIERS: ReadonlySet<Tier> = new Set<Tier>(["starter", "pro", "business", "agency", "agency_plus", "growth", "lazy_pro", "payg"]);

/** The cheapest plan that unlocks WhatsApp BYOK, in public wording, for "Upgrade to ..." copy. */
export const WHATSAPP_BYOK_REQUIRED_PLAN_NAME = TIER_DISPLAY_NAMES.starter;

export function canUseWhatsappByok(tier: Tier): boolean {
  return WHATSAPP_BYOK_ALLOWED_TIERS.has(tier);
}
