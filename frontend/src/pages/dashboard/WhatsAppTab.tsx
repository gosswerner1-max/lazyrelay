import { useMemo, useState } from "react";
import { useDashboard } from "./DashboardContext";
import { useWhatsAppSend } from "./useWhatsAppSend";
import { WhatsAppContactImport } from "../../components/dashboard/WhatsAppContactImport";
import { WhatsAppContactList, WhatsAppOptOuts } from "../../components/dashboard/WhatsAppContactList";
import { WhatsAppInbox } from "../../components/dashboard/WhatsAppInbox";
import { WhatsAppApprovals } from "../../components/dashboard/WhatsAppApprovals";
import { WhatsAppTemplates } from "../../components/dashboard/WhatsAppTemplates";
import { WhatsAppRateCard } from "../../components/dashboard/WhatsAppRateCard";
import { WhatsAppBroadcastComposer } from "../../components/dashboard/WhatsAppBroadcastComposer";
import { WhatsAppBroadcastList } from "../../components/dashboard/WhatsAppBroadcastList";
import { WhatsAppAudiences } from "../../components/dashboard/WhatsAppAudiences";
import { ByokGuide } from "../../components/dashboard/ByokGuide";
import { WHATSAPP_GUIDE } from "../../lib/byokGuides";
import { COPY } from "../../lib/whatsappSend";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// WhatsApp tab. Shown only when the server says broadcasts are on (useWhatsAppBroadcasts). It always carries the collapsed setup guide
// for a customer's OWN Meta credentials. When the server also says SENDING is on (useWhatsAppSend) the tab has five views: Inbox
// (two-way chat), Approvals, Broadcasts, Updates and Contacts. With sending off it is the Phase 1 contacts and consent screen, unchanged:
// nothing is sent from it.

type View = "inbox" | "approvals" | "broadcasts" | "updates" | "contacts";
const VIEWS: Array<{ key: View; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "approvals", label: "Approvals" },
  { key: "broadcasts", label: "Broadcasts" },
  { key: "updates", label: "Updates" },
  { key: "contacts", label: "Contacts" },
];

export function WhatsAppTab() {
  const { accounts } = useDashboard();
  const connections = useMemo(() => accounts.filter((a) => a.platform === "whatsapp"), [accounts]);
  const [picked, setPicked] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [templatesKey, setTemplatesKey] = useState(0);
  const [broadcastsKey, setBroadcastsKey] = useState(0);
  const [view, setView] = useState<View>("inbox");
  const send = useWhatsAppSend(connections.length > 0);
  const connId = connections.some((c) => c.id === picked) ? picked : (connections[0]?.id ?? "");
  const bump = () => setRefresh((n) => n + 1);

  if (connections.length === 0) {
    return (
      <div className="byok-panels">
        <p>Connect a WhatsApp number first (Social Platforms), then come back to add your contacts.</p>
        <ByokGuide guide={WHATSAPP_GUIDE} />
      </div>
    );
  }

  const active: View = send.sending ? view : "contacts";

  return (
    <div className="byok-panels wac">
      <div className="byok-panels__head">
        <h2>{send.sending ? "WhatsApp" : "WhatsApp contacts"}</h2>
        {send.sending ? (
          <p>{COPY.sendingIntro}</p>
        ) : (
          <p>
            Keep the people who said yes to WhatsApp marketing messages, with proof of when and how. Nothing is sent from here yet: this screen only stores your contacts and
            their consent. Anyone who opts out is blocked automatically.
          </p>
        )}
      </div>
      <ByokGuide guide={WHATSAPP_GUIDE} />
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
      {send.sending && (
        <nav className="wac-nav" aria-label="WhatsApp views">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" aria-current={active === v.key ? "page" : undefined} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </nav>
      )}
      {active === "inbox" && <WhatsAppInbox key={`inbox-${connId}`} socialAccountId={connId} />}
      {active === "approvals" && <WhatsAppApprovals key="approvals" />}
      {active === "broadcasts" && (
        <>
          <WhatsAppTemplates key={`templates-${connId}`} socialAccountId={connId} onChanged={() => setTemplatesKey((n) => n + 1)} />
          <WhatsAppRateCard key={`rate-${connId}`} socialAccountId={connId} />
          <WhatsAppBroadcastComposer key={`composer-${connId}`} socialAccountId={connId} refreshKey={templatesKey} onCreated={() => setBroadcastsKey((n) => n + 1)} />
          <WhatsAppBroadcastList key={`list-${connId}`} socialAccountId={connId} refreshKey={broadcastsKey} />
        </>
      )}
      {active === "updates" && <WhatsAppAudiences key={`aud-${connId}`} socialAccountId={connId} />}
      {active === "contacts" && (
        <>
          <WhatsAppContactImport key={`import-${connId}`} socialAccountId={connId} onImported={bump} />
          <WhatsAppContactList key={`list-${connId}`} socialAccountId={connId} refreshKey={refresh} onChanged={bump} />
          <WhatsAppOptOuts refreshKey={refresh} />
        </>
      )}
    </div>
  );
}
