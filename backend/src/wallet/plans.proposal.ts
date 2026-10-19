import { ENTERPRISE_MONTHLY_BUNDLE_MICRO, SIGNUP_GRANT_MICRO } from "./rules.js";
import { WalletValueError } from "./money.js";

/**
 * The pure two tier model decided by the owner on 2026-10-19, written down as data. NOTHING READS THIS. It does not change a live plan,
 * a Paddle price, a limit or a page. All other tiers are to be removed from the catalog by the owner; that is a billing and customer step
 * done outside this code (see the wallet design notes (kept outside this repository) section 9).
 *
 * Free Core: 0 USD. Up to 3 brands; inside each brand any or all of the 18 distribution platforms; 3 publications a day per brand.
 *   Starts with a 0.50 USD wallet allowance, then buys top ups. No WhatsApp workflows, no signed proof links, no client reporting.
 * Enterprise: 99 USD a month flat. UNLIMITED brands, UNLIMITED team seats (no per seat charge), WhatsApp broadcast workflows, signed proof
 *   links. 10 USD of wallet credit is deposited every billing period.
 *
 * `null` means unlimited. `totalConnectionsCeiling` is the one number the owner left open ("scale the ceiling up"): unlimited brands times
 * 18 platforms has no natural end, so a technical ceiling is kept as an abuse guard and to protect platform quotas. The value is MY
 * PROPOSAL (1,000 connected accounts) and needs the owner's confirmation. `notBuilt` lists what the model names that the product does
 * not have today, so it cannot be advertised by accident.
 */
export const DISTRIBUTION_PLATFORM_COUNT = 18;

export const WALLET_PLAN_PROPOSAL = {
  status: "owner decision 2026-10-19, not wired to any live tier",
  free: {
    monthlyUsd: "0",
    brands: 3,
    platformsPerBrand: DISTRIBUTION_PLATFORM_COUNT,
    dailyPostCapPerBrand: 3,
    signupAllowanceMicro: SIGNUP_GRANT_MICRO,
    whatsappWorkflows: false,
    signedProofLinks: false,
    whiteLabelReporting: false,
  },
  enterprise: {
    monthlyUsd: "99",
    brands: null,
    teamSeats: null,
    extraSeatMonthlyUsd: null,
    monthlyBundleMicro: ENTERPRISE_MONTHLY_BUNDLE_MICRO,
    totalConnectionsCeiling: 1000,
    totalConnectionsCeilingStatus: "proposed by James, awaiting owner confirmation",
    whatsappWorkflows: true,
    signedProofLinks: true,
    customClientReporting: true,
  },
  notBuilt: ["customClientReporting", "whiteLabelReporting", "signedProofLinks"],
} as const;

/** LOCKED by the owner: one free registration can never run more than 3 businesses. */
export const FREE_BRAND_CAP_LOCKED = 3;

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

/** Whether an Enterprise account may connect one more platform account: a null brand limit is unlimited, the connection ceiling is not. */
export function enterpriseMayConnectAnother(currentConnections: number): boolean {
  if (!Number.isInteger(currentConnections) || currentConnections < 0) throw new WalletValueError("connections must be a whole number, 0 or more");
  return currentConnections < WALLET_PLAN_PROPOSAL.enterprise.totalConnectionsCeiling;
}

/**
 * The six live tiers, copied from the landing page pricing data on 2026-10-19. Under the pure two tier model these are RETIRED by the
 * owner. They are kept here only so the size of that step is on record: each has paying customers on its own Paddle price.
 */
export const LEGACY_TIERS_TO_RETIRE = {
  free: { monthlyUsd: 0, connectedAccounts: 3, brands: 1 },
  starter: { monthlyUsd: 29.99, connectedAccounts: 20, brands: 2 },
  pro: { monthlyUsd: 59.99, connectedAccounts: 30, brands: 4 },
  business: { monthlyUsd: 99.99, connectedAccounts: 50, brands: 7, seatsIncluded: 2 },
  agency: { monthlyUsd: 149.99, connectedAccounts: 100, brands: 12, seatsIncluded: 3 },
  agency_plus: { monthlyUsd: 199.99, connectedAccounts: 150, brands: 20, seatsIncluded: 6 },
} as const;

/** The legacy PAID tiers whose customers would have to be moved, grandfathered or refunded: every tier but the old Free. */
export function legacyPaidTiersToRetire(): string[] {
  return Object.keys(LEGACY_TIERS_TO_RETIRE).filter((name) => name !== "free");
}

/**
 * GRANDFATHERING (owner decision, 2026-10-19). Every account that exists when the two tier model launches keeps its exact price,
 * limits and setup, with no interruption, and the wallet never meters or pauses it. The new model (3 brand Free Core, Enterprise,
 * universal wallet metering) applies only to accounts created on or after the cutoff. The five retired paid tiers are closed to new
 * buyers; their Paddle prices stay active so renewals continue untouched. In the database the list is a one time snapshot
 * (wallet_grandfather_accounts(cutoff), migration 0139) taken by hand on launch day.
 *
 * ASSUMPTION to confirm: existing accounts on the OLD Free tier are grandfathered too (the cutoff covers every existing account, on any
 * tier), so they keep 3 connected accounts and 1 brand and are not metered.
 */
export const GRANDFATHERING = {
  status: "owner decision 2026-10-19, not wired to any live tier",
  appliesTo: "every account created before the cutoff, on any tier",
  keepsPriceAndLimits: true,
  walletMetering: false,
  walletPause: false,
  paddlePricesStayActive: true,
  closedToNewBuyers: ["starter", "pro", "business", "agency", "agency_plus"],
  newModelAppliesTo: "accounts created on or after the cutoff",
  cutoffStatus: "set by the owner on launch day when the snapshot is taken",
} as const;

/** True when an account was created before the cutoff. Created exactly AT the cutoff counts as new. Refuses dates it cannot read. */
export function isGrandfathered(createdAt: string | Date, cutoff: string | Date): boolean {
  const created = createdAt instanceof Date ? createdAt.getTime() : typeof createdAt === "string" && createdAt !== "" ? Date.parse(createdAt) : Number.NaN;
  const limit = cutoff instanceof Date ? cutoff.getTime() : typeof cutoff === "string" && cutoff !== "" ? Date.parse(cutoff) : Number.NaN;
  if (Number.isNaN(created) || Number.isNaN(limit)) throw new WalletValueError("a date could not be read");
  return created < limit;
}
