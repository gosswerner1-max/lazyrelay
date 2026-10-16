import { useMemo, useState } from "react";
import { useDashboard } from "./DashboardContext";
import { WhatsAppOptInForm } from "../../components/dashboard/WhatsAppOptInForm";
import { WhatsAppContactImport } from "../../components/dashboard/WhatsAppContactImport";
import { WhatsAppContactList, WhatsAppOptOuts } from "../../components/dashboard/WhatsAppContactList";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";

// WhatsApp tab, Phase 1 of scheduled broadcasts: store the people who said yes (and the proof), import a list, see who opted out.
// Shown only when the server says broadcasts are on (useWhatsAppBroadcasts). Sending is NOT built yet: nothing here messages anyone.

export function WhatsAppTab() {
  const { accounts } = useDashboard();
  const connections = useMemo(() => accounts.filter((a) => a.platform === "whatsapp"), [accounts]);
  const [picked, setPicked] = useState("");
  const [refresh, setRefresh] = useState(0);
  const connId = connections.some((c) => c.id === picked) ? picked : (connections[0]?.id ?? "");
  const bump = () => setRefresh((n) => n + 1);

  if (connections.length === 0) {
    return (
      <div className="byok-panels">
        <p>Connect a WhatsApp number first (Social Platforms), then come back to add your contacts.</p>
      </div>
    );
  }

  return (
    <div className="byok-panels wac">
      <div className="byok-panels__head">
        <h2>WhatsApp contacts</h2>
        <p>
          Keep the people who said yes to WhatsApp marketing messages, with proof of when and how. Nothing is sent from here yet: this screen only stores your contacts and
          their consent. Anyone who opts out is blocked automatically.
        </p>
      </div>
      {connections.length > 1 && (
        <label className="byok-field wac-field">
          WhatsApp number
          <select value={connId} onChange={(e) => setPicked(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name || "WhatsApp number"}
              </option>
            ))}
          </select>
        </label>
      )}
      <WhatsAppOptInForm key={`add-${connId}`} socialAccountId={connId} onAdded={bump} />
      <WhatsAppContactImport key={`import-${connId}`} socialAccountId={connId} onImported={bump} />
      <WhatsAppContactList key={`list-${connId}`} socialAccountId={connId} refreshKey={refresh} onChanged={bump} />
      <WhatsAppOptOuts refreshKey={refresh} />
    </div>
  );
}
