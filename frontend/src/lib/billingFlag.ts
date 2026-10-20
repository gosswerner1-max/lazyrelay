// The one switch for the credit-wallet billing screens, and the only place that loads them. Build-time and exact: anything except
// the word "true" is off. The screens are loaded lazily from here, next to the flag, so the bundler sees the flag and the loads
// in one file: with the flag off they fold to null and the build carries none of the billing code or words (the same pattern as
// the Content Sources tab). Do not move the flag or the loads into separate files; the bundler then keeps the chunks.

import { lazy } from "react";
import { OFF_VIEW } from "./walletContext";
import { useWalletBalance, type WalletView } from "./useWalletBalance";

export const BILLING_ENABLED = import.meta.env.VITE_BILLING_ENABLED === "true";

/** The balance chip for the dashboard header, or null with billing off. */
export const HeaderBalance = BILLING_ENABLED ? lazy(() => import("../components/billing/HeaderBalance")) : null;

/** The billing view for Settings, or null with billing off. */
export const LiveBilling = BILLING_ENABLED ? lazy(() => import("../components/billing/LiveBilling")) : null;

/** The dashboard's wallet: the real one with billing on, a constant "off" without it (nothing is requested). */
export const useBillingWallet: (checkoutDoneCount: number) => WalletView = BILLING_ENABLED
  ? (checkoutDoneCount) => useWalletBalance({ enabled: true, checkoutDoneCount })
  : () => OFF_VIEW;
