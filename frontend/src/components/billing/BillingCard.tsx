// The billing tab body: the total first, one primary button, then the credit allocation grid that separates the lots.
// In this mockup the button starts nothing; it only shows a note.

import { useId, useState, type ReactNode } from "react";
import { buildAllocation, formatCredits, totalCredits, type CreditLot } from "../../lib/billingSummary";
import "../../styles/billing-mockup.css";
import "../../styles/billing-mockup-adapt.css";

interface Props {
  lots: CreditLot[];
  now: Date;
  /** The balance the server reports. When given it is shown instead of the sum of the lots. */
  total?: number;
  /** In the live app the main button calls this (it brings the buy panel into view). Without it the button only shows a note. */
  onBuy?: () => void;
}

interface LotProps {
  title: string;
  value: string;
  children?: ReactNode;
}

function Lot({ title, value, children }: LotProps) {
  const id = useId();
  return (
    <section className="bm-lot" aria-labelledby={id}>
      <h3 className="bm-lot__title" id={id}>
        {title}
      </h3>
      <p className="bm-lot__value">{value}</p>
      {children}
    </section>
  );
}

const credits = (n: number) => `${formatCredits(n)} credits`;

export function BillingCard({ lots, now, total: given, onBuy }: Props) {
  const titleId = useId();
  const [noted, setNoted] = useState(false);
  const total = given ?? totalCredits(lots, now);
  const { subscription, topup, payg } = buildAllocation(lots, now);
  return (
    <section className="bm-card" aria-labelledby={titleId}>
      <div className="bm-total">
        <h2 className="bm-total__label" id={titleId}>
          Total available balance
        </h2>
        <p className="bm-total__value">
          <span className="bm-total__num" data-testid="billing-total">
            {formatCredits(total)}
          </span>{" "}
          <span className="bm-total__unit">credits</span>
        </p>
        <button type="button" className="bm-btn bm-btn--primary" onClick={onBuy ?? (() => setNoted(true))}>
          Buy Credits / Upgrade Plan
        </button>
        {noted && (
          <p className="bm-note" role="status">
            Billing is not switched on yet.
          </p>
        )}
      </div>

      <div className="bm-grid" data-testid="billing-grid">
        <Lot title="Subscription Plan" value={subscription ? credits(subscription.remaining) : "None"}>
          {subscription?.countdown && <p className="bm-lot__line">{subscription.countdown}</p>}
          {subscription && <p className="bm-lot__small">{subscription.rolloverNote}</p>}
        </Lot>
        {topup && (
          <Lot title="Pro Top-Up Pack" value={credits(topup.remaining)}>
            <p className="bm-lot__line">{topup.lapse}</p>
          </Lot>
        )}
        <Lot title="Pay-As-You-Go" value={credits(payg.remaining)}>
          <p className="bm-lot__tag">Never Expires</p>
          {payg.freeSignup > 0 && <p className="bm-lot__small">{`includes ${formatCredits(payg.freeSignup)} free sign-up credits`}</p>}
        </Lot>
      </div>
    </section>
  );
}
