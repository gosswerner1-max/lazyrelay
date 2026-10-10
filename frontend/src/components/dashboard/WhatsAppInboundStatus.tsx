import type { WebhookInfoState } from "./useWhatsAppWebhookInfo";

// One line per connected WhatsApp number saying whether inbound messages can arrive yet. The only thing used from the
// server is a boolean per connection: whether an App Secret is saved. The secret itself is never sent to the browser,
// so there is nothing here to read back or show.

export const INBOUND_READY_TEXT = "Inbound ready";
export const INBOUND_OFF_TEXT = "Inbound off: App Secret not saved";

export function InboundChip({ ready }: { ready: boolean }) {
  return <span className={ready ? "byok-chip byok-chip--ok" : "byok-chip byok-chip--off"}>{ready ? INBOUND_READY_TEXT : INBOUND_OFF_TEXT}</span>;
}

export function WhatsAppInboundStatus({ state }: { state: WebhookInfoState }) {
  return (
    <div className="byok-inbound">
      <p className="byok-card__hint">Inbound messages stay off for a connection until an App Secret is saved for it. Sending is a separate feature and does not need one.</p>
      {state.status === "loading" && <p className="byok-card__hint">Checking your connections...</p>}
      {state.status === "error" && <p className="byok-card__hint byok-card__hint--error">Could not check the inbound status right now. {state.message}</p>}
      {state.status === "ready" &&
        (state.info.connections.length === 0 ? (
          <p className="byok-card__hint">No WhatsApp number is connected yet. Once you save one, its inbound status shows here.</p>
        ) : (
          <ul className="byok-conns" aria-label="Inbound status for each connected WhatsApp number">
            {state.info.connections.map((c) => (
              <li key={c.socialAccountId}>
                <span className="byok-conns__name">{c.displayName}</span>
                <InboundChip ready={c.inboundReady} />
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
