// Shows only when a plan or top-up lot has less than 7 days left (the rule lives in lib/billingSummary.ts). Dismissed for this
// view only: plain state, no storage.

import { useState } from "react";
import { expirationNotice, type CreditLot } from "../../lib/billingSummary";
import "../../styles/billing-mockup.css";

interface Props {
  lots: CreditLot[];
  now: Date;
}

export function ExpirationBanner({ lots, now }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const notice = expirationNotice(lots, now);
  if (!notice || dismissed) return null;
  return (
    <div className="bm-banner" role="status">
      <p className="bm-banner__text">{notice.message}</p>
      <button type="button" className="bm-btn bm-btn--secondary" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
