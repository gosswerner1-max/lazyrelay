// The Calendar workspace tab: reads posts, accounts, brands and the Google Calendar connection from the dashboard state and the tracked-link click totals
// from the existing analytics endpoint. It changes nothing except to start the Google connection when the customer presses the button.
// Shown only when VITE_CALENDAR_WORKSPACE_ENABLED is "true".

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { CalendarWorkspace, type GoogleCalendarState, type LinkClickRow } from "../../components/dashboard/CalendarWorkspace";
import { useDashboard } from "./DashboardContext";

export function CalendarWorkspaceTab() {
  const { posts, accounts, brands, gcalStatus, handleConnectGoogleCalendar } = useDashboard();
  const [linkClicks, setLinkClicks] = useState<LinkClickRow[]>([]);

  useEffect(() => {
    let live = true;
    api.getLinkClicks(90).then((r) => { if (live) setLinkClicks(r.links); }).catch(() => { if (live) setLinkClicks([]); });
    return () => { live = false; };
  }, []);

  const google: GoogleCalendarState =
    gcalStatus === undefined ? { state: "unknown" } : gcalStatus === null ? { state: "disconnected" } : { state: "connected", email: gcalStatus.connected_email ?? null, lastSyncedAt: gcalStatus.last_synced_at ?? null };

  return <CalendarWorkspace posts={posts} accounts={accounts} brands={brands} google={google} linkClicks={linkClicks} onConnectGoogle={() => { void handleConnectGoogleCalendar(); }} />;
}
