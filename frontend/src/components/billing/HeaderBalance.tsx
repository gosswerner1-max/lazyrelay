// The balance in the dashboard header. Loaded lazily by Dashboard.tsx only when billing is on; shows only for an active,
// non-exempt wallet (the server's own balance number), so a legacy account sees the header exactly as before.

import { useWallet } from "../../lib/walletContext";
import { BalanceIndicator } from "./BalanceIndicator";
import "../../styles/byok-panels.css";
import "../../styles/billing-live.css";

export default function HeaderBalance() {
  const { wallet, billingActive, fetchedAt } = useWallet();
  if (!billingActive || !wallet) return null;
  return (
    <span className="billing-mock byok-panels bm-chip">
      <BalanceIndicator lots={wallet.lots} now={fetchedAt ?? new Date()} total={wallet.balance} />
    </span>
  );
}
