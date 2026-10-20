// The billing view in Settings when billing is on and the account is not exempt: the expiry banner, the balance card with the
// real lots, the plan limits, and the buy panel. Loaded lazily by SettingsTab.tsx, so a build with billing off does not carry it.

import { useCallback, useRef } from "react";
import { useDashboard } from "../../pages/dashboard/DashboardContext";
import { useWallet } from "../../lib/walletContext";
import { capsLine } from "../../lib/walletFormat";
import type { CatalogResult, Wallet } from "../../lib/walletApi";
import type { CheckoutResult } from "../../lib/walletCheckout";
import { BillingCard } from "./BillingCard";
import { BuyPanel, type PaymentWindow } from "./BuyPanel";
import { ExpirationBanner } from "./ExpirationBanner";
import "../../styles/billing-live.css";

interface ViewProps {
  wallet: Wallet;
  now: Date;
  paddle: PaymentWindow | undefined;
  loadCatalog?: () => Promise<CatalogResult>;
  start?: (sku: string) => Promise<CheckoutResult>;
}

/** "1 credit" or "10 credits". */
const rate = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;

export function LiveBillingView({ wallet, now, paddle, loadCatalog, start }: ViewProps) {
  const buyRef = useRef<HTMLDivElement>(null);
  const toBuyPanel = useCallback(() => buyRef.current?.scrollIntoView?.({ block: "start" }), []);
  return (
    <div className="billing-mock byok-panels bm-live">
      <ExpirationBanner lots={wallet.lots} now={now} />
      <BillingCard lots={wallet.lots} now={now} total={wallet.balance} onBuy={toBuyPanel} />
      <p className="bm-plan">{capsLine(wallet.plan.caps)}</p>
      <p className="bm-plan" data-testid="billing-rates">
        {`Publishing costs ${rate(wallet.prices.post_publish)} per channel. A competitor page teardown costs ${rate(wallet.prices.competitor_teardown)}, charged only when it is delivered.`}
      </p>
      <div ref={buyRef}>
        <BuyPanel paddle={paddle} loadCatalog={loadCatalog} start={start} />
      </div>
    </div>
  );
}

export default function LiveBilling() {
  const { wallet, billingActive, fetchedAt } = useWallet();
  const { paddle } = useDashboard();
  if (!billingActive || !wallet) return null;
  return <LiveBillingView wallet={wallet} now={fetchedAt ?? new Date()} paddle={paddle} />;
}
