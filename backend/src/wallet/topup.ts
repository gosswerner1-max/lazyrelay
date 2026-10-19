import { WalletValueError, minorUnitsToMicro } from "./money.js";

/**
 * Turns a completed Paddle sale into the credit it should give. Paddle is the merchant of record and works out tax at checkout, so the
 * customer pays the pre tax amount plus whatever tax their address needs. The wallet is credited with the PRE TAX amount (`total`: the
 * subtotal after any discount, before tax), never with the grand total, so tax is never mistaken for balance.
 *
 * Paddle reports amounts as a string in the smallest currency unit, so "1000" with USD means 10.00 USD. The idempotency key is built
 * from the Paddle transaction id, so a webhook that is delivered twice credits once (the database ignores the second one).
 *
 * UNWIRED: this is the calculation only. It is not called by the webhook handler until the wallet is switched on and a wallet top up
 * checkout (a new customData.kind) exists. Check the amounts against a Paddle sandbox transaction before use.
 */
export interface SaleForTopUp {
  currencyCode: string;
  /** Pre tax amount after discount, in the smallest currency unit. */
  total: string;
  tax: string;
  grandTotal: string;
  paddleTransactionId: string;
}

export function walletCreditFromSale(input: { sale: SaleForTopUp; isWalletTopUp: boolean }): { amountMicro: number; idempotencyKey: string; reference: string } | null {
  if (!input.isWalletTopUp) return null;
  const { sale } = input;
  if (sale.currencyCode !== "USD") throw new WalletValueError("wallet top ups are in USD only");
  if (typeof sale.paddleTransactionId !== "string" || !/^[A-Za-z0-9_]{1,100}$/.test(sale.paddleTransactionId)) {
    throw new WalletValueError("the Paddle transaction id is missing or malformed");
  }
  return {
    amountMicro: minorUnitsToMicro(sale.total),
    idempotencyKey: `paddle:${sale.paddleTransactionId}`,
    reference: sale.paddleTransactionId,
  };
}
