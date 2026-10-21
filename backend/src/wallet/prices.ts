import { WalletValueError } from "./money.js";

/**
 * What each metered action costs, in micro credits (1 credit = 1,000,000). The database holds the same numbers in wallet_prices
 * (migration 0140) and is the one that charges; these exist so the code can show a price and so a test can catch the two drifting apart.
 *   post_publish          1 credit    one published post
 *   competitor_teardown   10 credits  one competitor content teardown
 */
export const WALLET_PRICES_MICRO = { post_publish: 1_000_000, competitor_teardown: 10_000_000 } as const;

export type WalletAction = keyof typeof WALLET_PRICES_MICRO;

export function isWalletAction(value: unknown): value is WalletAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(WALLET_PRICES_MICRO, value);
}

export function priceMicro(action: WalletAction): number {
  if (!isWalletAction(action)) throw new WalletValueError("unknown wallet action");
  return WALLET_PRICES_MICRO[action];
}
