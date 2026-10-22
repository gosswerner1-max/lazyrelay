// The Connections workspace tab: reads accounts, brands, posts and the Google statuses from the dashboard state. It connects nothing itself; every
// click hands over to the Social Platforms tab, which owns the connect flows. Shown only when VITE_CONNECTIONS_WORKSPACE_ENABLED is "true".

import { ConnectionsWorkspace } from "../../components/dashboard/ConnectionsWorkspace";
import { useDashboard } from "./DashboardContext";

export function ConnectionsWorkspaceTab() {
  const { accounts, brands, posts, gcalStatus, gsheetStatus } = useDashboard();
  return (
    <ConnectionsWorkspace
      accounts={accounts}
      brands={brands}
      posts={posts}
      gcalStatus={gcalStatus}
      gsheetStatus={gsheetStatus}
    />
  );
}
