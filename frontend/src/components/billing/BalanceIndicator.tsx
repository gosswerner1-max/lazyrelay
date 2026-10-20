// Compact balance for the top navigation: the text, a status dot that says its state in words, and a short visible mark when the
// balance is not high so colour is never the only signal. The dot has a fixed box; the flash lives on a ring inside it, so
// nothing around it moves. Styles: styles/billing-mockup.css.

import { balanceStatus, formatCredits, statusLabel, statusMark, totalCredits, type CreditLot } from "../../lib/billingSummary";
import "../../styles/billing-mockup.css";
import "../../styles/billing-mockup-adapt.css";

interface Props {
  lots: CreditLot[];
  now: Date;
}

export function BalanceIndicator({ lots, now }: Props) {
  const total = totalCredits(lots, now);
  const status = balanceStatus(total);
  const mark = statusMark(status);
  return (
    <span className="bm-balance" data-status={status} data-tour="balance">
      <span className="bm-dot" role="img" aria-label={statusLabel(status)} data-status={status} />
      <span className="bm-balance__text">{`Available Balance: ${formatCredits(total)} Credits`}</span>
      {mark && <span className="bm-balance__mark">{mark}</span>}
    </span>
  );
}
