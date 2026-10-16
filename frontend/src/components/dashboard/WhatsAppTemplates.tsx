import { useCallback, useEffect, useId, useState } from "react";
import { api, type WhatsAppTemplate } from "../../lib/api";
import { COPY } from "../../lib/whatsappSend";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// The message templates of the customer's OWN Meta account, copied here with their own token. Only an APPROVED template whose only
// variables are in the message text can be sent (a scheduled message is outside WhatsApp's 24 hour window, where only an approved
// template is allowed). Templates are created and approved in Meta Business Manager, not here.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");

const UNSUPPORTED: Record<string, string> = {
  media_header: "Not supported yet: has a picture, video or document header",
  header_variable: "Not supported yet: the header has a value to fill in",
  button_variable: "Not supported yet: a button has a value to fill in",
  authentication_not_supported: "Not supported yet: one-time code templates",
  no_body: "Not supported yet: it has no message text",
};

export function templateStateText(t: Pick<WhatsAppTemplate, "status" | "usable" | "unsupportedReason">): { text: string; ok: boolean } {
  if (t.usable) return { text: "Ready to use", ok: true };
  if (t.status === "approved") return { text: UNSUPPORTED[t.unsupportedReason ?? ""] ?? "Not supported yet", ok: false };
  const byStatus: Record<string, string> = { pending: "Waiting for Meta", in_appeal: "Waiting for Meta", rejected: "Rejected by Meta", paused: "Paused by Meta", disabled: "Disabled or removed in Meta" };
  return { text: byStatus[t.status] ?? "Not available", ok: false };
}

export function WhatsAppTemplates({ socialAccountId, onChanged }: { socialAccountId: string; onChanged?: () => void }) {
  const id = useId();
  const [items, setItems] = useState<WhatsAppTemplate[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listWhatsAppTemplates(socialAccountId);
      setItems(r.templates);
      setError("");
      setState("ready");
    } catch (err) {
      setError(errText(err));
      setState("error");
    }
  }, [socialAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const r = await api.syncWhatsAppTemplates(socialAccountId);
      setMessage(`Synced ${r.synced} ${r.synced === 1 ? "template" : "templates"}, ${r.approved} approved.`);
      await load();
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Message templates
      </h3>
      <p className="byok-card__hint">Templates come from your own Meta account. Only approved templates can be sent. Create and approve them in Meta Business Manager.</p>
      <div className="byok-actions">
        <button type="button" className="byok-secondary" disabled={busy} onClick={() => void sync()}>
          {busy ? "Syncing..." : "Sync templates"}
        </button>
      </div>
      <div aria-live="polite">
        {message && <p className="byok-status">{message}</p>}
        {error && <p className="byok-error">{error}</p>}
      </div>
      {state === "loading" && <p className="byok-card__hint">Loading templates...</p>}
      {state === "ready" && items.length === 0 && <p className="byok-card__hint">{COPY.noTemplates}</p>}
      {items.length > 0 && (
        <ul className="byok-conns wac-list">
          {items.map((t) => {
            const s = templateStateText(t);
            return (
              <li key={t.id}>
                <div className="wac-who">
                  <span className="byok-conns__name">{t.name}</span>
                  <span className="wac-small">
                    {t.language}, {t.category}
                  </span>
                </div>
                <span className={`byok-chip ${s.ok ? "byok-chip--ok" : "byok-chip--off"}`}>{s.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
