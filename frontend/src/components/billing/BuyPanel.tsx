// The buy panel: what can be bought, built from the server's catalog. Prices are shown as the catalog gives them, because the
// payment window adds tax at checkout. An item the server says is not purchasable shows one line of reason instead of a Buy
// button. Clicking Buy asks the server for a transaction and then opens the payment window the dashboard already set up; the
// buttons stay off while a purchase is starting, so a double click cannot start two. Styles: styles/billing-live.css.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatCredits } from "../../lib/billingSummary";
import { getCatalog, type CatalogItem, type CatalogResult } from "../../lib/walletApi";
import { startCheckout, type CheckoutResult } from "../../lib/walletCheckout";
import { CHECKOUT_NO_WINDOW, catalogReasonLine } from "../../lib/walletWords";
import "../../styles/byok-panels.css";
import "../../styles/billing-mockup.css";
import "../../styles/billing-mockup-adapt.css";
import "../../styles/billing-live.css";

/** The one part of the payment window object this panel uses. */
export interface PaymentWindow {
  Checkout: { open: (options: { transactionId: string }) => void };
}

interface Props {
  paddle: PaymentWindow | undefined;
  loadCatalog?: () => Promise<CatalogResult>;
  start?: (sku: string) => Promise<CheckoutResult>;
}

type Phase = { kind: "loading" } | { kind: "off" } | { kind: "error"; message: string } | { kind: "ok"; items: CatalogItem[] };
interface Problem {
  message: string;
  cause?: unknown;
}

const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

function priceText(item: CatalogItem): string {
  return `${dollars(item.priceCents)}${item.interval === "month" ? " per month" : ""}`;
}

/** What the person is told about when the credits end. Only what the catalog itself says. A plan-bound item (the Pro top-up) has its own text in Row, so it never reads "never expire". */
function expiryText(item: CatalogItem): string {
  if (item.kind === "subscription") return "credits expire each billing cycle";
  return item.expires ? "credits expire" : "credits never expire";
}

/** The pay-as-you-go pack (the Starter Pack in the catalog). Its two lines are fixed wording. */
const PAYG_SKU = "lazycredits-starter-pack";
const PAYG_LINES = ["300 credits that stay in your wallet until used", "Balance can be topped up at any time"] as const;

/** Whole dollars read "$30", anything else "$30.50". */
const plainDollars = (cents: number) => (cents % 100 === 0 ? "$" + String(cents / 100) : dollars(cents));

/** The Pro top-up is bound to the active Pro plan, so it is described that way and never as "never expires". */
function ProTopUpText({ item }: { item: CatalogItem }) {
  return (
    <>
      <p className="bm-buy__credits">{`${plainDollars(item.priceCents)} for ${formatCredits(item.credits)} credits (bound to active subscription status, expires if canceled).`}</p>
    </>
  );
}

interface RowProps {
  item: CatalogItem;
  busySku: string | null;
  onBuy: (sku: string) => void;
}

function Row({ item, busySku, onBuy }: RowProps) {
  const nameId = useId();
  const busy = busySku === item.sku;
  return (
    <li className="bm-buy__item" aria-labelledby={nameId}>
      <h4 className="bm-buy__name" id={nameId}>
        {item.name}
      </h4>
      {item.purchasable ? (
        <>
          {item.requiresPlan === "pro" ? (
            <ProTopUpText item={item} />
          ) : item.sku === PAYG_SKU ? (
            <>
              <p className="bm-buy__price">{priceText(item)}</p>
              {PAYG_LINES.map((line) => (
                <p key={line} className="bm-buy__credits">{line}</p>
              ))}
            </>
          ) : (
            <>
              <p className="bm-buy__price">{priceText(item)}</p>
              <p className="bm-buy__credits">{`${formatCredits(item.credits)} credits`}</p>
              <p className="bm-buy__note">{expiryText(item)}</p>
            </>
          )}
          <button type="button" className="bm-btn bm-btn--primary" aria-label={`Buy ${item.name}`} disabled={busySku !== null} onClick={() => onBuy(item.sku)}>
            {busy ? "Starting checkout..." : "Buy"}
          </button>
        </>
      ) : (
        <>
          {item.requiresPlan === "pro" && (
            <ProTopUpText item={item} />
          )}
          <p className="bm-buy__reason">{catalogReasonLine(item.reason)}</p>
        </>
      )}
    </li>
  );
}

function useCatalog(loadCatalog: () => Promise<CatalogResult>) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const loadRef = useRef(loadCatalog);
  useEffect(() => {
    loadRef.current = loadCatalog;
  });
  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    const r = await loadRef.current();
    setPhase(r.kind === "ok" ? { kind: "ok", items: r.items } : r.kind === "error" ? { kind: "error", message: r.message } : { kind: "off" });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { phase, load };
}

/** Starts a purchase for one sku and opens the payment window. One at a time: a second click while one is starting does nothing. */
function useBuy(paddle: PaymentWindow | undefined, start: (sku: string) => Promise<CheckoutResult>) {
  const [busySku, setBusySku] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const pending = useRef(false);
  const buy = useCallback(
    async (sku: string) => {
      if (pending.current) return;
      pending.current = true;
      setBusySku(sku);
      setProblem(null);
      try {
        const result = await start(sku);
        if (!result.ok) setProblem({ message: result.message, cause: result.cause });
        else if (!paddle) setProblem({ message: CHECKOUT_NO_WINDOW });
        else paddle.Checkout.open({ transactionId: result.transactionId });
      } catch (cause) {
        setProblem({ message: CHECKOUT_NO_WINDOW, cause });
      } finally {
        pending.current = false;
        setBusySku(null);
      }
    },
    [paddle, start],
  );
  return { busySku, problem, buy };
}

export function BuyPanel({ paddle, loadCatalog = getCatalog, start = startCheckout }: Props) {
  const titleId = useId();
  const { phase, load } = useCatalog(loadCatalog);
  const { busySku, problem, buy } = useBuy(paddle, start);
  if (phase.kind === "off") return null;
  return (
    <section className="bm-buy" aria-labelledby={titleId} id="bm-buy">
      <h3 className="bm-buy__title" id={titleId}>
        Buy credits
      </h3>
      {phase.kind === "loading" && (
        <p className="bm-buy__line" role="status">
          Loading credit options...
        </p>
      )}
      {phase.kind === "error" && (
        <div className="bm-buy__problem" role="alert">
          <p className="bm-buy__line">{phase.message}</p>
          <button type="button" className="bm-btn bm-btn--secondary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {problem && (
        <p className="bm-buy__problem" role="alert">
          {problem.message}
        </p>
      )}
      {phase.kind === "ok" && (
        <ul className="bm-buy__list">
          {phase.items.map((item) => (
            <Row key={item.sku} item={item} busySku={busySku} onBuy={(sku) => void buy(sku)} />
          ))}
        </ul>
      )}
    </section>
  );
}
