import { WalletValueError } from "./money.js";

/**
 * The source key of a pack sale. Paddle is the merchant of record; the credits a pack gives come from the catalog (wallet_packs), never
 * from the dollars paid, so only the transaction id is needed. The key is built from the Paddle transaction id, so a webhook that is
 * delivered twice grants once (the database ignores the second one).
 */
export function packSourceKey(paddleTransactionId: string): string {
  if (typeof paddleTransactionId !== "string" || !/^[A-Za-z0-9_]{1,90}$/.test(paddleTransactionId)) {
    throw new WalletValueError("the Paddle transaction id is missing or malformed");
  }
  return `paddle:${paddleTransactionId}`;
}
