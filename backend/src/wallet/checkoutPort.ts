// The checkout port. Package B (wallet routes) owns this interface; Package C implements it in billing/checkout.ts. This file holds the
// identical interface so package C builds on its own; at merge, keep package B's copy (the shape is the same).
export interface CheckoutPort { createCheckout(accountId: string, sku: string): Promise<{ checkoutUrl: string; transactionId: string }> }
