// Plain words for the credit screens. Only the billing screens import this file, so with billing off it is not in the build.

import type { CatalogReason } from "./walletApi";

const REASON_LINE: Record<CatalogReason, string> = {
  needs_pro: "Only for active Pro plan subscribers.",
  needs_growth: "Only for active Growth plan subscribers.",
  already_subscribed: "You are already subscribed to this plan.",
  legacy_account: "Not available on your current account type.",
  plan_ending: "Your Pro plan is set to end, so a top-up would lapse in days.",
};

/** The one-line reason shown in place of a Buy button. */
export function catalogReasonLine(reason: CatalogReason | null): string {
  return reason ? REASON_LINE[reason] : "Not available right now.";
}

/** What the buying call said when it refused, by its code. */
export const REFUSAL_WORDS: Record<CatalogReason, string> = {
  needs_pro: "The Pro top-up is only for active Pro plan subscribers.",
  needs_growth: "The Growth Pack is only for active Growth plan subscribers.",
  legacy_account: "Credit purchases are not available on your current account type.",
  already_subscribed: "You are already subscribed to this plan.",
  plan_ending: REASON_LINE.plan_ending,
};

export const CHECKOUT_TRY_AGAIN = "We could not start the checkout. Please try again.";
export const CHECKOUT_OFF = "Credit purchases are not switched on yet.";
export const CHECKOUT_SIGN_IN = "Please sign in again to buy credits.";
export const CHECKOUT_NO_WINDOW = "The payment window could not load. Please refresh the page and try again.";
