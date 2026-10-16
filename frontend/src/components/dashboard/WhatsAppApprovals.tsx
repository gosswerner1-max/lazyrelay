import { useCallback, useEffect, useId, useState } from "react";
import { api, type WhatsAppApprovalListItem, type WhatsAppApprovalStatus } from "../../lib/api";
import { safeDisplay, safeName } from "../../lib/whatsappThreads";
import { COPY, approvalStatusLabel } from "../../lib/whatsappSend";
import { usePolling } from "../../lib/usePolling";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// Approval requests sent from a conversation, with what the client tapped. A CONVENIENCE RECORD only: it is not legal consent, a
// signature or proof of a contract, and this screen says so in plain words. Refreshes every 30 seconds.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");
const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

type Filter = "" | WhatsAppApprovalStatus;
const CHIPS: Array<{ key: Exclude<Filter, "">; label: string }> = [
  { key: "pending", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "changes_requested", label: "Changes requested" },
  { key: "question", label: "Question" },
];

export function WhatsAppApprovals() {
  const id = useId();
  const [filter, setFilter] = useState<Filter>("");
  const [items, setItems] = useState<WhatsAppApprovalListItem[]>([]);
  const [counts, setCounts] = useState<Record<WhatsAppApprovalStatus, number> | null>(null);
  const [note, setNote] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.listWhatsAppApprovals(filter || undefined);
      setItems(r.approvals);
      setCounts(r.counts);
      setNote(r.note);
      setError("");
      setState("ready");
    } catch (err) {
      setError(errText(err));
      setState("error");
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(() => void load(), 30_000, state === "ready");

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Approval requests
      </h3>
      <p className="byok-card__hint">{note || COPY.approvalNote}</p>
      <div className="wac-nav" role="group" aria-label="Filter by answer">
        <button type="button" aria-current={filter === "" ? "page" : undefined} onClick={() => setFilter("")}>
          All
        </button>
        {CHIPS.map((c) => (
          <button key={c.key} type="button" aria-current={filter === c.key ? "page" : undefined} onClick={() => setFilter(c.key)}>
            {`${c.label} (${counts?.[c.key] ?? 0})`}
          </button>
        ))}
      </div>
      {error && <p className="byok-error">{error}</p>}
      {state === "loading" && <p className="byok-card__hint">Loading approval requests...</p>}
      {state === "ready" && items.length === 0 && <p className="byok-card__hint">No approval requests yet. Use Ask for approval inside a conversation.</p>}
      {items.length > 0 && (
        <ul className="byok-conns wac-list ph-no-capture ph-mask">
          {items.map((a) => (
            <li key={a.id} className="wac-approval-row">
              <div className="wac-who">
                <span className="byok-conns__name">{a.title}</span>
                <span className="wac-small">
                  {safeName(a.displayName) ?? safeDisplay(a.contactDisplay)}, asked {when(a.createdAt)}
                </span>
                {a.responseTitle && (
                  <span className="wac-small">
                    They tapped: {a.responseTitle} {when(a.respondedAt)}
                  </span>
                )}
              </div>
              <span className={`byok-chip ${a.status === "approved" ? "byok-chip--ok" : "byok-chip--off"}`}>{approvalStatusLabel(a.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
