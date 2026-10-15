import { useEffect, useState } from "react";
import { api, type WhatsAppWebhookInfo } from "../../lib/api";

export type WebhookInfoState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; info: WhatsAppWebhookInfo };

/** Loads GET /whatsapp/webhook-info once, and again whenever `reloadKey` changes (after a connection was saved). The
 *  answer holds no secret: only the shared handshake token, the public URL and a boolean per connection. A failure is
 *  a plain message, never a thrown error, and a reload keeps showing the last good answer until the new one arrives. */
export function useWhatsAppWebhookInfo(enabled: boolean, reloadKey: number): WebhookInfoState {
  const [state, setState] = useState<WebhookInfoState>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await api.getWhatsAppWebhookInfo();
        if (!info || !Array.isArray(info.connections)) throw new Error("Unexpected answer.");
        if (!cancelled) setState({ status: "ready", info });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error && err.message ? err.message : "Could not load the webhook details." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);
  return state;
}
