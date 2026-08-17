import { supabase } from "./supabase.js";
import { resolveTier, type Tier } from "./tier.js";

/** Per-tier team-seat caps (Agency pricing pass, 2026-08-17). Prices what
 *  Agency-tier-v1 (account_members, migration 0053) shipped uncapped — same
 *  leak shape already closed once for brands (see brandLimits.ts). 0 means
 *  the tier has no team access at all, not just a cap of zero extra seats;
 *  checkSeatLimit below gives that case its own message rather than the
 *  generic "reached your limit of 0" phrasing. */
export const SEAT_LIMITS: Record<Tier, number> = {
  free: 0,
  pro: 0, // displays as "Starter"
  business: 0, // displays as "Pro"
  enterprise: 2, // displays as "Business"
  agency: 3,
  agency_plus: 6,
};

/** Deliberately NOT the brand-addon-style cap of 10 — included seat counts
 *  already do most of the tier differentiation here, so the paid overflow
 *  buffer is small and flat across every tier with team access. */
export const MAX_SEAT_ADDONS_PER_ACCOUNT = 2;

/** Counts only active/trialing rows, same convention as
 *  getActiveBrandAddonSlots. */
export async function getActiveSeatAddonSlots(accountId: string): Promise<number> {
  const { count, error } = await supabase
    .from("seat_addons")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .in("status", ["active", "trialing"]);
  if (error) throw error;
  return count ?? 0;
}

/** The real effective cap for this account right now: base tier allowance
 *  plus any purchased add-on slots. Same shape as getBrandCapacity. */
export async function getSeatCapacity(accountId: string): Promise<{ tier: Tier; baseLimit: number; addonSlots: number; totalLimit: number }> {
  const tier = await resolveTier(accountId);
  const baseLimit = SEAT_LIMITS[tier];
  const addonSlots = await getActiveSeatAddonSlots(accountId);
  return { tier, baseLimit, addonSlots, totalLimit: baseLimit + addonSlots };
}

/** Checked before creating a new team invite — returns a customer-facing
 *  reason if the account is already at its plan's (base + purchased
 *  add-ons) seat limit, else null. Counts every non-owner account_members
 *  row (pending invites AND accepted members) against the cap, so an owner
 *  can't spam-invite past their limit by leaving invites unaccepted. */
export async function checkSeatLimit(accountId: string): Promise<string | null> {
  const { totalLimit, addonSlots } = await getSeatCapacity(accountId);

  if (totalLimit === 0) {
    return "Team members aren't available on your plan — upgrade to Business or Agency.";
  }

  const { count, error } = await supabase
    .from("account_members")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .neq("role", "owner");
  if (error) throw error;

  if ((count ?? 0) >= totalLimit) {
    const upgradeHint = addonSlots > 0 ? "upgrade, or buy another seat add-on" : "upgrade for more, or buy a seat add-on";
    return `You've reached your plan's limit of ${totalLimit} team ${totalLimit === 1 ? "seat" : "seats"}. Remove one, or ${upgradeHint}.`;
  }
  return null;
}
