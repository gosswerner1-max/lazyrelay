import { WalletValueError } from "./money.js";
import { PLANS } from "./plans.js";
import { WALLET_PRICES_MICRO } from "./prices.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION = /^[A-Za-z0-9_]{1,100}$/;

export interface SignupGrant {
  kind: "signup";
  credits: number;
  expiresAt: null;
  sourceKey: string;
}

/** The one time allowance for a new account (the Free plan's credits). The key is built from the account alone, so it can only be given once. */
export function signupGrant(accountId: string): SignupGrant {
  if (typeof accountId !== "string" || !UUID.test(accountId)) throw new WalletValueError("the account id is not valid");
  return { kind: "signup", credits: PLANS.free.credits, expiresAt: null, sourceKey: `signup:${accountId}` };
}

/**
 * The source key of a monthly plan lot. It is built from the subscription and the DAY the billing period starts, so a webhook delivered
 * twice in the same period grants once and the next period grants a new lot.
 * UNWIRED: nothing calls this until the wallet is on and the Paddle webhook handler is connected to it.
 */
export function subscriptionSourceKey(input: { subscriptionId: string; periodStart: string }): string {
  if (typeof input.subscriptionId !== "string" || !SUBSCRIPTION.test(input.subscriptionId)) throw new WalletValueError("the subscription id is missing or malformed");
  const when = new Date(input.periodStart);
  if (typeof input.periodStart !== "string" || input.periodStart === "" || Number.isNaN(when.getTime())) throw new WalletValueError("the billing period start is not a valid date");
  return `period:${input.subscriptionId}:${when.toISOString().slice(0, 10)}`;
}

/** What the cheapest action costs, in micro credits. Below this an account cannot pay for anything. */
export function minActionPriceMicro(): number {
  return Math.min(...Object.values(WALLET_PRICES_MICRO));
}

/**
 * True when an account's queue must stop: it HAS a wallet and the spendable credits cannot pay for the cheapest action (zero, or less
 * than that). An account with no wallet row at all (null) is never paused: it was never given a balance, and pausing it would stop
 * customers the moment the wallet is switched on. Give every account its credits first.
 */
export function shouldPauseQueue(balanceMicro: number | null): boolean {
  if (balanceMicro === null) return false;
  if (!Number.isSafeInteger(balanceMicro) || balanceMicro < 0) throw new WalletValueError("a balance must be a whole number, 0 or more");
  return balanceMicro < minActionPriceMicro();
}
