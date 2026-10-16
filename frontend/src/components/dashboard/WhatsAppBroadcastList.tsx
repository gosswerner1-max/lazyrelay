import { useCallback, useEffect, useId, useState } from "react";
import { api, type WhatsAppBroadcast } from "../../lib/api";
import { broadcastStatusLabel, costLine, deliveryLine, pauseReasonText } from "../../lib/whatsappSend";
import { usePolling } from "../../lib/usePolling";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// The customer's broadcasts, newest first. Delivery is shown ONLY from Meta's own receipts, as "N delivered of M, confirmed by Meta":
// "handed to WhatsApp" is never presented as delivered. Cost is an ESTIMATE from the customer's own rate card. The list refreshes
// itself every 30 seconds while anything is scheduled or sending.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");
const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
const RESUMABLE = new Set(["connection_paused", "quality", "restricted", "credentials", "policy"]);
const CANCELLABLE = new Set(["scheduled", "sending", "paused"]);

interface Props {
  socialAccountId: string;
  /** Change this to reload the list (after scheduling one). */
  refreshKey: number;
}

export function WhatsAppBroadcastList({ socialAccountId, refreshKey }: Props) {
  const id = useId();
  const [items, setItems] = useState<WhatsAppBroadcast[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.listWhatsAppBroadcasts(socialAccountId);
      setItems(r.broadcasts);
      setError("");
      setState("ready");
    } catch (err) {
      setError(errText(err));
      setState("error");
    }
  }, [socialAccountId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  usePolling(() => void load(), 30_000, items.some((b) => b.status === "scheduled" || b.status === "sending"));

  async function cancel(b: WhatsAppBroadcast) {
    setRowBusy(b.id);
    setError("");
    try {
      await api.cancelWhatsAppBroadcast(b.id);
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function resume(b: WhatsAppBroadcast) {
    setRowBusy(b.id);
    setError("");
    try {
      await api.resumeWhatsAppSending(b.socialAccountId);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Your broadcasts
      </h3>
      {error && <p className="byok-error">{error}</p>}
      {state === "loading" && <p className="byok-card__hint">Loading broadcasts...</p>}
      {state === "ready" && items.length === 0 && <p className="byok-card__hint">No broadcasts yet. Schedule your first one above.</p>}
      {items.length > 0 && (
        <ul className="byok-conns wac-list">
          {items.map((b) => (
            <li key={b.id}>
              <div className="wac-broadcast">
                <div className="wac-broadcast-head">
                  <span className="wac-big">{b.name}</span>
                  <span className={`byok-chip ${b.status === "completed" || b.status === "sending" ? "byok-chip--ok" : "byok-chip--off"}`}>{broadcastStatusLabel(b.status)}</span>
                </div>
                <span className="wac-small">
                  {b.templateName} ({b.templateCategory}). {b.status === "scheduled" ? `Scheduled for ${when(b.scheduledFor)}` : `Started ${when(b.startedAt ?? b.scheduledFor)}`}
                </span>
                <span>{deliveryLine(b.delivery)}</span>
                <span className="wac-small">{costLine(b.costEstimate)}</span>
                {(b.counts.failed > 0 || b.counts.skipped > 0) && (
                  <span className="wac-small">
                    {[b.counts.failed > 0 ? `${b.counts.failed} not sent` : "", b.counts.skipped > 0 ? `${b.counts.skipped} skipped (opted out or not allowed)` : ""].filter(Boolean).join(", ")}
                  </span>
                )}
                {b.status === "paused" && <span className="wac-small wac-warn">{pauseReasonText(b.pauseReason)}</span>}
                <div className="byok-actions">
                  {b.status === "paused" && b.pauseReason && RESUMABLE.has(b.pauseReason) && (
                    <button type="button" className="byok-secondary" disabled={rowBusy === b.id} onClick={() => void resume(b)}>
                      Resume this number
                    </button>
                  )}
                  {CANCELLABLE.has(b.status) &&
                    (confirmId === b.id ? (
                      <div role="group" aria-label="Confirm cancel" className="wac-confirm">
                        <span>Cancel this broadcast? Messages already handed to WhatsApp cannot be recalled.</span>
                        <button type="button" className="byok-primary" disabled={rowBusy === b.id} onClick={() => void cancel(b)}>
                          Yes, cancel it
                        </button>
                        <button type="button" className="byok-secondary" onClick={() => setConfirmId(null)}>
                          Keep it
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="byok-secondary" aria-label={`Cancel ${b.name}`} onClick={() => setConfirmId(b.id)}>
                        Cancel
                      </button>
                    ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
