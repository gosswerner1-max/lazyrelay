import { WalletValueError } from "./money.js";

/**
 * What each metered action costs, in micro dollars. The database holds the same numbers in wallet_prices (migration 0139) and is the
 * one that charges; these exist so the code can show a price and so a test can catch the two drifting apart.
 *   api_dispatch  0.002 USD  one verified dispatch to a platform's API
 *   sitemap_sync  0.05 USD   one crawl and sync of a Content Sources sitemap source
 */
export const WALLET_PRICES_MICRO = { api_dispatch: 2000, sitemap_sync: 50_000 } as const;

export type WalletAction = keyof typeof WALLET_PRICES_MICRO;

export const WALLET_ACTIONS = Object.keys(WALLET_PRICES_MICRO) as WalletAction[];

export function isWalletAction(value: unknown): value is WalletAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(WALLET_PRICES_MICRO, value);
}

export function priceMicro(action: WalletAction): number {
  if (!isWalletAction(action)) throw new WalletValueError("unknown wallet action");
  return WALLET_PRICES_MICRO[action];
}
