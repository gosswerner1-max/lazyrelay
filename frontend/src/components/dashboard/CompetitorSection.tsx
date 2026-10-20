// Joins competitor mode to the app: the service client the build setting names. The blueprint is read and copied on
// screen; nothing here saves, schedules or posts anything.
// With VITE_BILLING_ENABLED set to "true" the blueprint is asked of the LazyRelay backend instead, which charges credits;
// with it unset everything below behaves exactly as it did before credits.

import { BILLING_UI } from "../../lib/competitorBilling";
import { defaultBillingClient } from "../../lib/competitorBillingDefault";
import { defaultCompetitorClient } from "../../lib/competitorDefault";
import { CompetitorPanel } from "./CompetitorPanel";

const BILLING_ON = import.meta.env.VITE_BILLING_ENABLED === "true";
const billingClient = BILLING_ON ? defaultBillingClient() : null;

interface Props {
  /** The customer's credits, when the page knows them. Shown in the notice (credits on) and in the "Help me set up" tour. */
  creditBalance?: number;
  /** Opens the place to buy credits. Without it the "Add credits" button stays hidden. */
  onAddCredits?: () => void;
  /** Called with the new balance after a paid blueprint is shown, so the page can refresh its credit widgets. */
  onBalanceChanged?: (balance: number) => void;
}

export default function CompetitorSection({ creditBalance, onAddCredits, onBalanceChanged }: Props) {
  return (
    <CompetitorPanel
      client={billingClient ?? defaultCompetitorClient}
      billing={billingClient ? BILLING_UI : undefined}
      creditBalance={creditBalance}
      onAddCredits={onAddCredits}
      onBalanceChanged={onBalanceChanged}
    />
  );
}
