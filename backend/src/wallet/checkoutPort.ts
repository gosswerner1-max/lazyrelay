/**
 * The seam between the wallet API (package B) and the Paddle package (C). The wallet API validates a purchase and then asks this port to
 * create the checkout; it never calls Paddle itself. Package C implements createCheckout (a server side Paddle transaction for the signed
 * in account) and registers it with setCheckoutPort. Until then the checkout route answers 503 checkout_not_available.
 */
export interface CheckoutPort {
  /** opts.partnerCode is an already validated affiliate code; it rides in the transaction's custom data so the webhook can attribute the sale. */
  createCheckout(accountId: string, sku: string, opts?: { partnerCode?: string }): Promise<unknown>;
}

let registered: CheckoutPort | null = null;

export function setCheckoutPort(port: CheckoutPort | null): void {
  registered = port;
}

export function getCheckoutPort(): CheckoutPort | null {
  return registered;
}
