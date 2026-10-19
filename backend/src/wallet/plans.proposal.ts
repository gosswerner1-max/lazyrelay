import { WalletValueError } from "./money.js";

/**
 * The two tier proposal from the owner (2026-10-19), written down as data. NOTHING READS THIS. It does not change a live plan, a Paddle
 * price, a limit or a page. It exists so the proposal is exact and reviewable next to the existing tiers (docs/WALLET-DESIGN.md compares them).
 *
 * `notBuilt` lists what the proposal names that the product does not have today, so it can never be advertised by accident.
 */
export const WALLET_PLAN_PROPOSAL = {
  status: "proposal, not wired to any live tier",
  free: { monthlyUsd: "0", dailyPostCap: 3, whatsappWorkflows: false, whiteLabelReporting: false },
  enterprise: { monthlyUsd: "99", whatsappWorkflows: true, customClientReporting: true, signedProofLinks: true },
  notBuilt: ["customClientReporting", "whiteLabelReporting", "signedProofLinks"],
} as const;

/** True once an account has used its posts for the day. The count comes from the caller; this only compares. */
export function dailyPostCapReached(postsToday: number, cap: number): boolean {
  if (!Number.isInteger(postsToday) || postsToday < 0) throw new WalletValueError("postsToday must be a whole number, 0 or more");
  if (!Number.isInteger(cap) || cap < 1) throw new WalletValueError("the cap must be a whole number, 1 or more");
  return postsToday >= cap;
}
