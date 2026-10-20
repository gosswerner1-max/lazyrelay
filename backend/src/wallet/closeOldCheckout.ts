import { walletMode, type WalletMode } from "./mode.js";
import { isLegacyAccount } from "./legacy.js";

// When the wallet is ON, the old six tier checkout (/subscription/checkout) is closed to anyone who is not a legacy account. Legacy
// accounts keep it, and their existing subscriptions are untouched (change plan, cancel and the add-ons are not gated here). With the
// wallet off or in shadow mode nothing changes for anybody.

export const OLD_CHECKOUT_CLOSED_MESSAGE = "This plan is no longer sold. Choose a Growth or Pro plan, or a credit pack, on the pricing page.";

export interface CloseOldCheckoutDeps {
  mode(): WalletMode;
  isLegacy(accountId: string): Promise<boolean>;
}

const realDeps: CloseOldCheckoutDeps = { mode: () => walletMode(), isLegacy: isLegacyAccount };

/** True when this account must be refused at the old checkout. */
export async function oldTierCheckoutClosed(accountId: string, deps: CloseOldCheckoutDeps = realDeps): Promise<boolean> {
  if (deps.mode() !== "on") return false;
  return !(await deps.isLegacy(accountId));
}
