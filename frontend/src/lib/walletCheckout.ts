// Starts a purchase: asks the server for a payment transaction for one catalog item. The caller then opens the payment window
// (the same Paddle overlay the plan checkout uses) with the transaction id. The server decides what may be bought; a refusal is
// turned into plain words here, and the raw error is kept on the result and never shown.

import { authedFetch } from "./api";
import type { Fetcher } from "./walletApi";
import { CHECKOUT_OFF, CHECKOUT_SIGN_IN, CHECKOUT_TRY_AGAIN, REFUSAL_WORDS } from "./walletWords";

export type CheckoutResult =
  | { ok: true; transactionId: string; checkoutUrl: string; sku: string }
  | { ok: false; message: string; code?: string; cause?: unknown };

type Failure = { status?: unknown; code?: unknown; message?: unknown };

function refusalFor(cause: unknown): CheckoutResult {
  const e = (typeof cause === "object" && cause !== null ? cause : {}) as Failure;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (code && Object.prototype.hasOwnProperty.call(REFUSAL_WORDS, code)) {
    return { ok: false, message: REFUSAL_WORDS[code as keyof typeof REFUSAL_WORDS], code, cause };
  }
  if (e.status === 404) return { ok: false, message: CHECKOUT_OFF, cause };
  if (e.status === 401 || e.message === "Not signed in") return { ok: false, message: CHECKOUT_SIGN_IN, cause };
  return { ok: false, message: CHECKOUT_TRY_AGAIN, cause };
}

export async function startCheckout(sku: string, fetcher: Fetcher = authedFetch): Promise<CheckoutResult> {
  let body: unknown;
  try {
    body = await fetcher("/wallet/checkout-intent", { method: "POST", body: JSON.stringify({ sku }) });
  } catch (cause) {
    return refusalFor(cause);
  }
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.transactionId !== "string" || b.transactionId === "" || typeof b.checkoutUrl !== "string" || typeof b.sku !== "string") {
    return { ok: false, message: CHECKOUT_TRY_AGAIN, cause: body };
  }
  return { ok: true, transactionId: b.transactionId, checkoutUrl: b.checkoutUrl, sku: b.sku };
}
