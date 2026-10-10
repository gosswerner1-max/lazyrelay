import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../lib/api";
import type { WebhookInfoState } from "./useWhatsAppWebhookInfo";

// One line per connected WhatsApp number saying whether inbound messages can arrive yet. The only thing used from the
// server is a boolean per connection: whether an App Secret is saved. The secret itself is never sent to the browser,
// so there is nothing here to read back or show.
//
// A number that is inbound ready also has a small "Remove App Secret" button. It opens an inline confirm inside the card
// (not a browser dialog, not a modal): the focus moves to the confirm button, Escape or Cancel closes it and puts the focus
// back on the button that opened it. Removing needs only the connection id; the token and IDs are not touched.

export const INBOUND_READY_TEXT = "Inbound ready";
export const INBOUND_OFF_TEXT = "Inbound off: App Secret not saved";
export const REMOVE_SECRET_WARNING = "Inbound messages will stop for this number until you save an App Secret again. Your token and IDs are not changed.";
export const SECRET_REMOVED_TEXT = "App Secret removed. Inbound is off for this number.";
export const REMOVE_SECRET_ERROR = "The App Secret could not be removed right now. It is still saved. Please try again.";

export function InboundChip({ ready }: { ready: boolean }) {
  return <span className={ready ? "byok-chip byok-chip--ok" : "byok-chip byok-chip--off"}>{ready ? INBOUND_READY_TEXT : INBOUND_OFF_TEXT}</span>;
}

export function WhatsAppInboundStatus({ state, onSecretRemoved }: { state: WebhookInfoState; /** Called after a secret was removed, so the status is fetched again. */ onSecretRemoved?: () => void }) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const triggers = useRef(new Map<string, HTMLButtonElement | null>());
  const names = useRef(new Map<string, HTMLSpanElement | null>());
  const confirmButton = useRef<HTMLButtonElement | null>(null);

  // Opening the confirm (or an error that keeps it open) puts the focus on the confirm button.
  useEffect(() => {
    if (confirmingId && busyId === null) confirmButton.current?.focus();
  }, [confirmingId, busyId]);

  function open(id: string) {
    setErrorId(null);
    setAnnouncement("");
    setConfirmingId(id);
  }

  function cancel() {
    if (busyId !== null) return;
    const id = confirmingId;
    setConfirmingId(null);
    setErrorId(null);
    if (id) requestAnimationFrame(() => triggers.current.get(id)?.focus());
  }

  async function confirm(id: string) {
    if (busyId !== null) return;
    setBusyId(id);
    setErrorId(null);
    try {
      await api.removeWhatsAppAppSecret(id);
      setBusyId(null);
      setConfirmingId(null);
      setAnnouncement(SECRET_REMOVED_TEXT);
      onSecretRemoved?.();
      // The button that opened the confirm goes away once the status says inbound is off: keep the focus on the row.
      requestAnimationFrame(() => names.current.get(id)?.focus());
    } catch {
      // Calm and fixed: whatever the server said is not shown, and the confirm stays open so nothing is lost.
      setBusyId(null);
      setErrorId(id);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  }

  return (
    <div className="byok-inbound">
      <p className="byok-card__hint">Inbound messages stay off for a connection until an App Secret is saved for it. Sending is a separate feature and does not need one.</p>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p className="byok-inbound__live" role="status" aria-live="polite">
        {announcement}
      </p>
      {state.status === "loading" && <p className="byok-card__hint">Checking your connections...</p>}
      {state.status === "error" && <p className="byok-card__hint byok-card__hint--error">Could not check the inbound status right now. {state.message}</p>}
      {state.status === "ready" &&
        (state.info.connections.length === 0 ? (
          <p className="byok-card__hint">No WhatsApp number is connected yet. Once you save one, its inbound status shows here.</p>
        ) : (
          <ul className="byok-conns" aria-label="Inbound status for each connected WhatsApp number">
            {state.info.connections.map((c) => {
              const id = c.socialAccountId;
              const confirming = confirmingId === id && c.inboundReady;
              const busy = busyId === id;
              const titleId = `byok-rm-title-${id}`;
              const textId = `byok-rm-text-${id}`;
              return (
                <li key={id}>
                  <span className="byok-conns__name" ref={(el) => void names.current.set(id, el)} tabIndex={-1}>
                    {c.displayName}
                  </span>
                  <span className="byok-conns__state">
                    <InboundChip ready={c.inboundReady} />
                    {c.inboundReady && !confirming && (
                      <button
                        type="button"
                        className="byok-conns__remove"
                        ref={(el) => void triggers.current.set(id, el)}
                        aria-label={`Remove App Secret for ${c.displayName}`}
                        onClick={() => open(id)}
                      >
                        Remove App Secret
                      </button>
                    )}
                  </span>
                  {confirming && (
                    <div className="byok-confirm" role="alertdialog" aria-labelledby={titleId} aria-describedby={textId} onKeyDown={onKeyDown}>
                      <p className="byok-confirm__title" id={titleId}>
                        Remove the App Secret for {c.displayName}?
                      </p>
                      <p className="byok-confirm__text" id={textId}>
                        {REMOVE_SECRET_WARNING}
                      </p>
                      <div className="byok-confirm__actions">
                        <button type="button" className="byok-confirm__danger" ref={confirmButton} disabled={busy} aria-busy={busy} onClick={() => void confirm(id)}>
                          {busy ? "Removing..." : "Remove secret"}
                        </button>
                        <button type="button" className="byok-confirm__cancel" disabled={busy} onClick={cancel}>
                          Cancel
                        </button>
                      </div>
                      {errorId === id && (
                        <p role="alert" className="byok-confirm__error">
                          {REMOVE_SECRET_ERROR}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}
