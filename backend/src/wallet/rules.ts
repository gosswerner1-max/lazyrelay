import { WalletValueError } from "./money.js";
import { PLANS } from "./plans.js";
import { WALLET_PRICES_MICRO } from "./prices.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** What the cheapest action costs, in micro credits. Below this an account cannot pay for anything. */
export function minActionPriceMicro(): number {
  return Math.min(...Object.values(WALLET_PRICES_MICRO));
}
