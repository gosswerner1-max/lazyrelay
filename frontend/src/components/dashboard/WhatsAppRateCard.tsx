import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { COPY } from "../../lib/whatsappSend";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// The customer's OWN price per delivered message, by category. Meta bills the customer directly and its delivery receipts name a
// category but never an amount, so the cost shown next to a broadcast is an ESTIMATE made from these numbers. Nothing here comes from Meta.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");

export function WhatsAppRateCard({ socialAccountId }: { socialAccountId: string }) {
  const id = useId();
  const [currency, setCurrency] = useState("");
  const [marketing, setMarketing] = useState("");
  const [utility, setUtility] = useState("");
  const [authentication, setAuthentication] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [serverError, setServerError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .getWhatsAppRateCard(socialAccountId)
      .then((r) => {
        if (cancelled || !r.rateCard) return;
        setCurrency(r.rateCard.currency);
        setMarketing(String(r.rateCard.marketing));
        setUtility(String(r.rateCard.utility));
        setAuthentication(String(r.rateCard.authentication));
      })
      .catch((err) => {
        if (!cancelled) setServerError(errText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [socialAccountId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    setServerError("");
    const found: Record<string, string> = {};
    if (!/^[A-Z]{3}$/.test(currency)) found.currency = "Use the 3 letter currency code, for example USD.";
    const price = (label: string, raw: string) => {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1000) found[label] = "Enter a price of 0 or more.";
      return n;
    };
    const m = price("marketing", marketing);
    const u = price("utility", utility);
    const a = price("authentication", authentication);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await api.saveWhatsAppRateCard(socialAccountId, { currency, marketing: m, utility: u, authentication: a });
      setMessage("Prices saved.");
    } catch (err) {
      setServerError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (key: string) => ({ "aria-invalid": errors[key] ? (true as const) : undefined });
  const error = (key: string) =>
    errors[key] ? (
      <span className="byok-field__error" role="alert">
        {errors[key]}
      </span>
    ) : null;

  return (
    <form className="byok-card wac-card" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Your WhatsApp prices
      </h3>
      <p className="byok-card__hint">{COPY.estimateNote}</p>
      <div className="byok-fields">
        <label className="byok-field wac-field">
          Currency (3 letters)
          <input type="text" autoComplete="off" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} {...field("currency")} />
          {error("currency")}
        </label>
        <label className="byok-field wac-field">
          Marketing price per message
          <input type="number" inputMode="decimal" step="any" min="0" value={marketing} onChange={(e) => setMarketing(e.target.value)} {...field("marketing")} />
          {error("marketing")}
        </label>
        <label className="byok-field wac-field">
          Utility price per message
          <input type="number" inputMode="decimal" step="any" min="0" value={utility} onChange={(e) => setUtility(e.target.value)} {...field("utility")} />
          {error("utility")}
        </label>
        <label className="byok-field wac-field">
          Authentication price per message
          <input type="number" inputMode="decimal" step="any" min="0" value={authentication} onChange={(e) => setAuthentication(e.target.value)} {...field("authentication")} />
          {error("authentication")}
        </label>
      </div>
      <div className="byok-actions">
        <button type="submit" className="byok-primary" disabled={busy}>
          {busy ? "Saving..." : "Save prices"}
        </button>
      </div>
      <div aria-live="polite">
        {serverError && <p className="byok-error">{serverError}</p>}
        {message && <p className="byok-status">{message}</p>}
      </div>
    </form>
  );
}
