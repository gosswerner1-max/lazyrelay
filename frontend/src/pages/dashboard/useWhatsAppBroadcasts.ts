import { useEffect, useState } from "react";
import { api } from "../../lib/api";

/** Whether to show the WhatsApp (contacts and consent) tab: true only when the server says broadcasts are on for this account
 *  (GET /whatsapp/capabilities, booleans only). It asks only when a WhatsApp number is connected, and any failure means false. */
export function useWhatsAppBroadcasts(hasWhatsAppConnection: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!hasWhatsAppConnection) return;
    let cancelled = false;
    api
      .getWhatsAppCapabilities()
      .then((c) => {
        if (!cancelled) setOn(c.broadcasts === true);
      })
      .catch(() => {
        if (!cancelled) setOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasWhatsAppConnection]);
  return hasWhatsAppConnection && on;
}
