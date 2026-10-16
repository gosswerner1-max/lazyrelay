import { useEffect, useState } from "react";
import { api } from "../../lib/api";

/** Whether sending (broadcasts and two-way chat) is on for this account: GET /whatsapp/send-capabilities, booleans only. It asks only
 *  when `enabled` (a WhatsApp number is connected), and any failure means "off". `stopped` is true when sending exists but is switched
 *  off right now. */
export function useWhatsAppSend(enabled: boolean): { sending: boolean; stopped: boolean; checked: boolean } {
  const [state, setState] = useState({ sending: false, stopped: false, checked: false });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await api.getWhatsAppSendCapabilities();
        if (!cancelled) setState({ sending: c.sending === true, stopped: c.stopped === true, checked: true });
      } catch {
        if (!cancelled) setState({ sending: false, stopped: false, checked: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}
