// The buy panel: what can be bought, built from the server's catalog. Prices are shown as the catalog gives them, because the
// payment window adds tax at checkout. An item the server says is not purchasable shows one line of reason instead of a Buy
// button. Clicking Buy asks the server for a transaction and then opens the payment window the dashboard already set up; the
// buttons stay off while a purchase is starting, so a double click cannot start two. Styles: styles/billing-live.css.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatCredits } from "../../lib/billingSummary";
import { getCatalog, type CatalogItem, type CatalogResult } from "../../lib/walletApi";
import { checkPartnerCode, startCheckout, type CheckoutResult, type CodeCheckResult } from "../../lib/walletCheckout";
import { getStoredReferralCode } from "../../lib/referral";
import { authedFetch } from "../../lib/api";
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
  /** The second argument is the code from the box, sent only when the box is not empty. */
  start?: (sku: string, partnerCode?: string) => Promise<CheckoutResult>;
  checkCode?: (code: string) => Promise<CodeCheckResult>;
  /** The code a ?ref= link left in this browser; it only pre-fills the box. */
  readStoredCode?: () => string | null;
}

/** Where the typed partner code stands. "valid" is only true for the exact text that was checked. */
type CodeState = { kind: "idle" } | { kind: "checking" } | { kind: "valid"; code: string; discount: boolean } | { kind: "invalid" } | { kind: "error" };

const CODE_INVALID = "That code is not valid";
const CODE_UNCHECKED = "We could not check the code just now. You can still buy without it.";

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
  /** "Code applied" lines for a valid code; null when there is none to show. */
  codeNote: string | null;
}

function Row({ item, busySku, onBuy, codeNote }: RowProps) {
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
          {codeNote && <p className="bm-buy__note bm-buy__code-note">{codeNote}</p>}
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
function useBuy(
  paddle: PaymentWindow | undefined,
  start: (sku: string, partnerCode?: string) => Promise<CheckoutResult>,
  getCode: () => string,
  onPartner: (outcome: "applied" | "invalid", discount: boolean) => void,
) {
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
        const code = getCode().trim();
        const result = code ? await start(sku, code) : await start(sku);
        if (result.ok && (result.partner === "invalid" || result.partner === "applied")) onPartner(result.partner, result.discount === true);
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
    [paddle, start, getCode, onPartner],
  );
  return { busySku, problem, buy };
}

/** The partner code box: pre-filled from the stored link code, editable and clearable. Only the text in the box is ever sent. */
function usePartnerCode(checkCode: (code: string) => Promise<CodeCheckResult>, readStoredCode: () => string | null) {
  const [code, setCode] = useState(() => readStoredCode() ?? "");
  const [state, setState] = useState<CodeState>({ kind: "idle" });
  const codeRef = useRef(code);
  const getCode = useCallback(() => codeRef.current, []);
  const check = useCallback(
    async (text: string) => {
      const typed = text.trim();
      if (!typed) return;
      setState({ kind: "checking" });
      const r = await checkCode(typed);
      if (codeRef.current.trim() !== typed) return; // the box changed while the answer was on its way
      setState(r.kind === "valid" ? { kind: "valid", code: typed, discount: r.discount } : r.kind === "invalid" ? { kind: "invalid" } : { kind: "error" });
    },
    [checkCode],
  );
  const change = (text: string) => {
    codeRef.current = text;
    setCode(text);
    setState({ kind: "idle" });
  };
  const onPartner = useCallback((outcome: "applied" | "invalid", discount: boolean) => {
    setState(outcome === "invalid" ? { kind: "invalid" } : { kind: "valid", code: codeRef.current.trim(), discount });
  }, []);
  // A link code that pre-filled the box is checked once on load, so its "Code applied" lines show without a click.
  const first = useRef(true);
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    if (codeRef.current.trim()) void check(codeRef.current);
  }, [check]);
  return { code, state, change, check, getCode, onPartner };
}

function codeNoteFor(item: CatalogItem, state: CodeState, code: string): string | null {
  if (state.kind !== "valid" || state.code !== code.trim()) return null;
  return item.kind === "subscription" && state.discount ? "Code applied: 10% off your first month" : "Code applied";
}

/** The real purchase call: the code from the box is the third argument of startCheckout. */
const startWithCode = (sku: string, partnerCode?: string) => startCheckout(sku, authedFetch, partnerCode ?? null);

export function BuyPanel({ paddle, loadCatalog = getCatalog, start = startWithCode, checkCode = checkPartnerCode, readStoredCode = getStoredReferralCode }: Props) {
  const titleId = useId();
  const codeId = useId();
  const { phase, load } = useCatalog(loadCatalog);
  const partner = usePartnerCode(checkCode, readStoredCode);
  const { busySku, problem, buy } = useBuy(paddle, start, partner.getCode, partner.onPartner);
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
      <div className="bm-buy__code">
        <label className="bm-buy__code-label" htmlFor={codeId}>
          Partner code (optional)
        </label>
        <div className="bm-buy__code-row">
          <input
            id={codeId}
            className="bm-buy__code-input"
            type="text"
            value={partner.code}
            maxLength={40}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => partner.change(e.target.value)}
          />
          <button type="button" className="bm-btn bm-btn--secondary" disabled={!partner.code.trim() || partner.state.kind === "checking"} onClick={() => void partner.check(partner.code)}>
            Apply code
          </button>
        </div>
        {partner.state.kind === "invalid" && (
          <p className="bm-buy__code-message" role="status">
            {CODE_INVALID}
          </p>
        )}
        {partner.state.kind === "error" && (
          <p className="bm-buy__code-message" role="status">
            {CODE_UNCHECKED}
          </p>
        )}
      </div>
      {problem && (
        <p className="bm-buy__problem" role="alert">
          {problem.message}
        </p>
      )}
      {phase.kind === "ok" && (
        <ul className="bm-buy__list">
          {phase.items.map((item) => (
            <Row key={item.sku} item={item} busySku={busySku} onBuy={(sku) => void buy(sku)} codeNote={codeNoteFor(item, partner.state, partner.code)} />
          ))}
        </ul>
      )}
    </section>
  );
}
