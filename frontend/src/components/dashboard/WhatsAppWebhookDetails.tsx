import { useEffect, useId, useRef, useState } from "react";
import type { WebhookInfoState } from "./useWhatsAppWebhookInfo";

// What the customer types into THEIR OWN Meta developer console so Meta can deliver WhatsApp messages to LazyRelay: the
// live callback URL and the verify token, each with a Copy button, and the short steps. Everything shown comes from
// GET /whatsapp/webhook-info. The verify token is a shared handshake string, not an API credential; the App Secret is
// never part of this answer.

export const VERIFY_TOKEN_NOTE =
  "The verify token is the same shared handshake string for everyone: it only lets Meta confirm this address is ours and cannot send or read any message, and every delivery is checked with your own App Secret.";
export const VERIFY_TOKEN_MISSING = "The verify token is not configured yet. Ask support and they will set it up.";

type CopyOutcome = "copied" | "manual" | null;

/** Clipboard API first; then the old selection-based copy; if both are refused, the text is left selected for Ctrl+C. */
async function copyText(value: string, input: HTMLInputElement | null): Promise<CopyOutcome> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return "copied";
    }
  } catch {
    // fall through to the selection-based copy
  }
  try {
    if (input) {
      input.focus();
      input.select();
      if (typeof document.execCommand === "function" && document.execCommand("copy")) return "copied";
    }
  } catch {
    // fall through
  }
  input?.select();
  return "manual";
}

function CopyField({ label, value }: { label: string; value: string }) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [outcome, setOutcome] = useState<CopyOutcome>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy() {
    const result = await copyText(value, inputRef.current);
    setOutcome(result);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome(null), 4000);
  }

  return (
    <div className="byok-field byok-field--wide">
      <label htmlFor={id}>{label}</label>
      <span className="byok-field__row">
        <input id={id} ref={inputRef} type="text" readOnly value={value} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="byok-reveal" onClick={() => void handleCopy()} aria-label={`Copy ${label}`}>
          Copy
        </button>
      </span>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <span className="byok-copy__live" role="status" aria-live="polite">
        {outcome === "copied" ? "Copied" : outcome === "manual" ? "Could not copy automatically. The text is selected: press Ctrl+C." : ""}
      </span>
    </div>
  );
}

export function WhatsAppWebhookDetails({ state }: { state: WebhookInfoState }) {
  if (state.status === "loading") return null;
  if (state.status === "error") {
    return (
      <section className="byok-webhook" aria-label="Webhook details for your Meta app">
        <h4 className="byok-webhook__title">Webhook details for your Meta app</h4>
        <p className="byok-card__hint byok-card__hint--error">The webhook details could not be loaded right now. Reload the page to try again.</p>
      </section>
    );
  }
  const { info } = state;
  return (
    <section className="byok-webhook" aria-label="Webhook details for your Meta app">
      <h4 className="byok-webhook__title">Webhook details for your Meta app</h4>
      <p className="byok-card__hint">To receive WhatsApp messages here, add this address to your own Meta app:</p>
      <ol className="byok-steps">
        <li>In the Meta developer console open your app, then WhatsApp, then Configuration.</li>
        <li>Under Webhooks choose Edit, paste the callback URL and the verify token below, then verify and save.</li>
        <li>
          Still under Webhooks, subscribe to the <code>messages</code> field.
        </li>
        <li>Save your App Secret above (Meta app, App settings, Basic), or inbound stays off.</li>
      </ol>
      <div className="byok-fields">
        <CopyField label="Callback URL" value={info.webhookUrl} />
        {info.verifyToken && info.verifyTokenConfigured ? (
          <CopyField label="Verify token" value={info.verifyToken} />
        ) : (
          <p className="byok-card__hint byok-field--wide">{VERIFY_TOKEN_MISSING}</p>
        )}
      </div>
      <p className="byok-card__hint">{VERIFY_TOKEN_NOTE}</p>
    </section>
  );
}
