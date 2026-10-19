import { WalletValueError } from "./money.js";

/**
 * The two tier structure decided by the owner on 2026-10-19, written down as data. NOTHING READS THIS. It does not change a live plan, a
 * Paddle price, a limit or a page. It exists so the proposal is exact and can be compared with the six live tiers (docs/WALLET-DESIGN.md).
 *
 * Free Core: up to 3 brands. Inside each brand any or all of the 18 distribution platforms can be connected. Output is limited to 3
 * publications per day PER BRAND. No WhatsApp workflows, no signed proof links, no client reporting.
 * Enterprise (99 USD a month): no limit on brands, no limit on team seats, WhatsApp broadcast workflows, signed proof links.
 *
 * `null` means unlimited. `notBuilt` lists what the structure names that the product does not have today, so it cannot be advertised by
 * accident: there is no custom client reporting or white label reporting, and nothing signs a proof link cryptographically.
 */
export const DISTRIBUTION_PLATFORM_COUNT = 18;

export const WALLET_PLAN_PROPOSAL = {
  status: "proposal, not wired to any live tier",
  free: {
    monthlyUsd: "0",
    brands: 3,
    platformsPerBrand: DISTRIBUTION_PLATFORM_COUNT,
    dailyPostCapPerBrand: 3,
    whatsappWorkflows: false,
    signedProofLinks: false,
    whiteLabelReporting: false,
  },
  enterprise: {
    monthlyUsd: "99",
    brands: null,
    teamSeats: null,
    whatsappWorkflows: true,
    signedProofLinks: true,
    customClientReporting: true,
  },
  notBuilt: ["customClientReporting", "whiteLabelReporting", "signedProofLinks"],
} as const;

/** The most platform connections a Free Core account could hold: every brand connected to every platform (3 x 18 = 54). */
export function maxFreeConnections(): number {
  return WALLET_PLAN_PROPOSAL.free.brands * WALLET_PLAN_PROPOSAL.free.platformsPerBrand;
}

/** The most publications a Free Core account could make in a day: the per brand cap times the number of brands (3 x 3 = 9). */
export function maxFreeDailyPublications(): number {
  return WALLET_PLAN_PROPOSAL.free.brands * WALLET_PLAN_PROPOSAL.free.dailyPostCapPerBrand;
}

/** True once a brand has used its publications for the day. The count comes from the caller and is for ONE brand; this only compares. */
export function dailyPostCapReached(postsTodayForBrand: number, cap: number): boolean {
  if (!Number.isInteger(postsTodayForBrand) || postsTodayForBrand < 0) throw new WalletValueError("postsToday must be a whole number, 0 or more");
  if (!Number.isInteger(cap) || cap < 1) throw new WalletValueError("the cap must be a whole number, 1 or more");
  return postsTodayForBrand >= cap;
}

/** The live tiers, copied from the landing page pricing data on 2026-10-19, so the proposal can be compared with them in a test. */
export const LIVE_TIERS = {
  free: { monthlyUsd: 0, connectedAccounts: 3, brands: 1 },
  starter: { monthlyUsd: 29.99, connectedAccounts: 20, brands: 2 },
  pro: { monthlyUsd: 59.99, connectedAccounts: 30, brands: 4 },
  business: { monthlyUsd: 99.99, connectedAccounts: 50, brands: 7, seatsIncluded: 2 },
  agency: { monthlyUsd: 149.99, connectedAccounts: 100, brands: 12, seatsIncluded: 3 },
  agency_plus: { monthlyUsd: 199.99, connectedAccounts: 150, brands: 20, seatsIncluded: 6 },
} as const;

/** The live tiers that the proposed FREE tier would out give on connected accounts (the proposed Free would hold more than they do). */
export function paidTiersOutgivenByFree(): string[] {
  const free = maxFreeConnections();
  return Object.entries(LIVE_TIERS)
    .filter(([name, t]) => name !== "free" && free > t.connectedAccounts)
    .map(([name]) => name);
}

/** The live tiers whose brand count the proposed ENTERPRISE tier would pass at a lower or equal price (it has no brand limit at 99 USD). */
export function paidTiersUndercutByEnterprise(): string[] {
  const price = Number(WALLET_PLAN_PROPOSAL.enterprise.monthlyUsd);
  return Object.entries(LIVE_TIERS)
    .filter(([name, t]) => name !== "free" && t.monthlyUsd >= price - 1)
    .map(([name]) => name);
}
