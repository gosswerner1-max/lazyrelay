import { WalletValueError } from "./money.js";
import { WALLET_PRICES_MICRO } from "./prices.js";

/** A Free Core account starts with 0.50 USD so it can try the product straight away, then buys top ups. */
export const SIGNUP_GRANT_MICRO = 500_000;
/** An Enterprise account gets 10 USD of credit every billing period, when the subscription is confirmed. */
export const ENTERPRISE_MONTHLY_BUNDLE_MICRO = 10_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION = /^[A-Za-z0-9_]{1,100}$/;

export interface GrantCredit {
  amountMicro: number;
  idempotencyKey: string;
  reference: string;
  kind: "grant";
}

/** The one time allowance for a new account. The key is built from the account alone, so it can only ever be given once. */
export function signupGrant(accountId: string): GrantCredit {
  if (typeof accountId !== "string" || !UUID.test(accountId)) throw new WalletValueError("the account id is not valid");
  return { amountMicro: SIGNUP_GRANT_MICRO, idempotencyKey: `signup-grant:${accountId}`, reference: "signup allowance", kind: "grant" };
}

/**
 * The monthly Enterprise credit. The key is built from the subscription and the DAY the billing period starts, so a webhook delivered
 * twice in the same period deposits once and the next period deposits again. Called when a subscription is confirmed or renewed.
 * UNWIRED: nothing calls this until the wallet is on and the Paddle webhook handler is connected to it.
 */
export function enterpriseBundle(input: { subscriptionId: string; periodStart: string }): GrantCredit {
  if (typeof input.subscriptionId !== "string" || !SUBSCRIPTION.test(input.subscriptionId)) throw new WalletValueError("the subscription id is missing or malformed");
  const when = new Date(input.periodStart);
  if (typeof input.periodStart !== "string" || input.periodStart === "" || Number.isNaN(when.getTime())) throw new WalletValueError("the billing period start is not a valid date");
  const day = when.toISOString().slice(0, 10);
  return { amountMicro: ENTERPRISE_MONTHLY_BUNDLE_MICRO, idempotencyKey: `bundle:${input.subscriptionId}:${day}`, reference: input.subscriptionId, kind: "grant" };
}

/** What the cheapest action costs. Below this an account cannot pay for anything. */
export function minActionPriceMicro(): number {
  return Math.min(...Object.values(WALLET_PRICES_MICRO));
}

/**
 * True when an account's queue must stop: it HAS a wallet and the balance cannot pay for the cheapest action (zero, or less than that).
 * An account with no wallet row at all (null) is never paused: it was never given a balance, and pausing it would stop customers the
 * moment the wallet is switched on. Give every account its allowance or bundle first (docs/WALLET-DESIGN.md, backfill).
 */
export function shouldPauseQueue(balanceMicro: number | null): boolean {
  if (balanceMicro === null) return false;
  if (!Number.isSafeInteger(balanceMicro) || balanceMicro < 0) throw new WalletValueError("a balance must be a whole number, 0 or more");
  return balanceMicro < minActionPriceMicro();
}
