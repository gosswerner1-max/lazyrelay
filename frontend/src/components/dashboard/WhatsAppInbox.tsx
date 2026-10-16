import { useCallback, useEffect, useId, useState } from "react";
import { api, type WhatsAppContact, type WhatsAppConversation } from "../../lib/api";
import { safeDisplay, safeName } from "../../lib/whatsappThreads";
import { windowLabel } from "../../lib/whatsappSend";
import { usePolling } from "../../lib/usePolling";
import { WhatsAppThread } from "./WhatsAppThread";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// The inbox: every conversation with one of the customer's WhatsApp numbers, newest first, with the unread count and whether Meta's 24
// hour window is open. A person is shown by their WhatsApp name or a masked number, never the number. It refreshes itself every 20
// seconds while the page is visible (the app has no websockets). "Message a saved contact" opens a chat with a saved contact who opted in.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export function WhatsAppInbox({ socialAccountId }: { socialAccountId: string }) {
  const id = useId();
  const [items, setItems] = useState<WhatsAppConversation[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [contacts, setContacts] = useState<WhatsAppContact[]>([]);
  const [contactId, setContactId] = useState("");
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listWhatsAppConversations(socialAccountId);
      setItems(r.conversations);
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

  useEffect(() => {
    let cancelled = false;
    api
      .listWhatsAppContacts({ socialAccountId, status: "opted_in", limit: 100 })
      .then((r) => {
        if (!cancelled) setContacts(r.contacts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [socialAccountId]);

  usePolling(() => void load(), 20_000, state === "ready");

  async function start() {
    if (!contactId) return;
    setStarting(true);
    setError("");
    try {
      const r = await api.startWhatsAppConversation(contactId);
      setContactId("");
      await load();
      setSelected(r.conversationId);
    } catch (err) {
      setError(errText(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="byok-card wac-card wac-chat" aria-labelledby={`${id}-title`}>
      <div className="wac-card">
        <h3 id={`${id}-title`} className="wac-title">
          Conversations
        </h3>
        <div className="wac-composer">
          <label className="byok-field wac-field">
            Message a saved contact
            <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">Choose a contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {safeName(c.displayName) ?? "No name"} ({safeDisplay(c.contactDisplay)})
                </option>
              ))}
            </select>
          </label>
          <div className="byok-actions">
            <button type="button" className="byok-secondary" disabled={!contactId || starting} onClick={() => void start()}>
              Start chat
            </button>
          </div>
        </div>
        {error && <p className="byok-error">{error}</p>}
        {state === "loading" && <p className="byok-card__hint">Loading conversations...</p>}
        {state === "ready" && items.length === 0 && <p className="byok-card__hint">No conversations yet. When someone messages your number, it shows up here.</p>}
        {items.length > 0 && (
          <ul className="wac-convs ph-no-capture ph-mask">
            {items.map((c) => {
              const name = safeName(c.displayName);
              return (
                <li key={c.id}>
                  <button type="button" aria-current={selected === c.id ? "true" : undefined} onClick={() => setSelected(c.id)}>
                    <span className="wac-conv-top">
                      <span>{name ?? safeDisplay(c.contactDisplay)}</span>
                      {c.unreadCount > 0 && (
                        <span className="wac-count" aria-label={`${c.unreadCount} unread`}>
                          {c.unreadCount}
                        </span>
                      )}
                    </span>
                    {name && <span className="wac-small">{safeDisplay(c.contactDisplay)}</span>}
                    <span className="wac-small">{windowLabel(c.window)}</span>
                    <span className="wac-small">{when(c.lastMessageAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="wac-card">{selected ? <WhatsAppThread key={selected} conversationId={selected} onChanged={() => void load()} /> : <p className="byok-card__hint">Pick a conversation to read it and reply.</p>}</div>
    </section>
  );
}
