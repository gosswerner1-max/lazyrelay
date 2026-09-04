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
  business: 30, // displays as "Pro" (trimmed from 40, 2026-08-16 — still beats every competitor at this price)
  enterprise: 50, // displays as "Business" (trimmed from 100, 2026-08-16 — 100 was excessive vs the shared API quota; 50 still leads the market)
  agency: 100, // Agency tier (2026-08-17) — deliberately below the trimmed enterprise rationale's old 100 ceiling isn't reused casually; this is a fresh, considered number for a genuinely higher-priced tier, not a reversal of the 2026-08-16 trim
  agency_plus: 150, // Agency Plus — a real step up from Agency, still short of the 200 first proposed, to stay closer to the shared-API-quota reasoning above
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

// checkAccountLimit above only counts accounts connected RIGHT NOW
// (disconnected_at is null) -- on its own, that lets a customer disconnect
// one real account and connect a DIFFERENT one every day, never exceeding
// the "currently connected" cap while cycling through far more distinct
// accounts than their plan actually allows over time (e.g. a Free-tier
// customer running an agency's worth of clients through the product for
// $0, one at a time). Reconnecting an account already known to us (same
// account_id + platform + platform_account_id) is NOT a new distinct
// account and must never be blocked by this -- found 2026-09-04.
const DISTINCT_ACCOUNT_WINDOW_DAYS = 30;

/** Checked in storeConnectedAccount (platforms/connect.ts), right before a
 *  genuinely new platform_account_id is upserted for this customer for the
 *  first time. Counts every account_id row first connected within the last
 *  30 days (connected_at, which reconnecting an EXISTING row never bumps --
 *  see the upsert comment in connect.ts) -- currently-connected or since
 *  disconnected, since the point is limiting distinct accounts CYCLED
 *  THROUGH, not just accounts held open at once. Callers must only invoke
 *  this for a platform_account_id they've confirmed is new; a reconnect of
 *  a known account should never reach this check at all. */
export async function checkNewDistinctAccountLimit(accountId: string): Promise<string | null> {
  const tier = await resolveTier(accountId);
  const limit = ACCOUNT_LIMITS[tier];
  const windowStart = new Date(Date.now() - DISTINCT_ACCOUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .gte("connected_at", windowStart);
  if (error) throw error;

  if ((count ?? 0) >= limit) {
    return `You've connected ${limit} different accounts in the last ${DISTINCT_ACCOUNT_WINDOW_DAYS} days — your plan's real limit, even if you've since disconnected some. A slot frees up ${DISTINCT_ACCOUNT_WINDOW_DAYS} days after that account was first connected, or upgrade for more.`;
  }
  return null;
}
