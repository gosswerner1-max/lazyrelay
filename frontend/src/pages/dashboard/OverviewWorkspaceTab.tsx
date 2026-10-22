// The Overview workspace tab: reads accounts and posts from the dashboard state and makes no API call of its own. It takes the place of the
// original Overview page when the new views are on (see Dashboard.tsx); the original OverviewTab stays in the code.

import { OverviewWorkspace } from "../../components/dashboard/OverviewWorkspace";
import { useDashboard } from "./DashboardContext";

export function OverviewWorkspaceTab() {
  const { accounts, posts, setTab } = useDashboard();
  return <OverviewWorkspace accounts={accounts} posts={posts} onConnect={() => setTab("Social Platforms")} />;
}
