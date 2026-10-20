import { WalletValueError } from "./money.js";

/**
 * GRANDFATHERING (owner decision, 2026-10-19). Every account that exists when the new model launches keeps its exact price, limits and
 * setup, with no interruption, and the wallet never meters or pauses it. The new model applies only to accounts created on or after the
 * cutoff. In the database the list is a one time snapshot (wallet_grandfather_accounts(cutoff), migration 0139) taken by hand on launch
 * day. The wallet functions of migration 0140 still answer exempt for these accounts.
 *
 * ASSUMPTION to confirm: existing accounts on the old Free tier are grandfathered too (the cutoff covers every existing account, on any
 * tier).
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
