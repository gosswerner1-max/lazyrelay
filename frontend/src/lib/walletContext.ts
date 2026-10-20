// Hands the one wallet the dashboard loads to the header balance and the billing view. Without a provider everything reads as off.

import { createContext, useContext } from "react";
import type { WalletView } from "./useWalletBalance";

export const OFF_VIEW: WalletView = { status: "off", wallet: null, error: null, fetchedAt: null, refresh: async () => {}, billingActive: false };

export const WalletContext = createContext<WalletView>(OFF_VIEW);

export const useWallet = (): WalletView => useContext(WalletContext);
