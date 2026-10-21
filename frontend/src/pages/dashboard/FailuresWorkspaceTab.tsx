// The Failures workspace tab: reads accounts and posts from the dashboard state (failed posts are already in that list) and makes no API call of its
// own. "Open in Posts" switches to the existing Failed tab, which owns retry, duplicate and delete. Shown only when VITE_FAILURES_WORKSPACE_ENABLED is "true".

import { FailuresWorkspace } from "../../components/dashboard/FailuresWorkspace";
import { useDashboard } from "./DashboardContext";

export function FailuresWorkspaceTab() {
  const { accounts, posts, setTab } = useDashboard();
  return <FailuresWorkspace accounts={accounts} posts={posts} onOpenFailed={() => setTab("Failed")} />;
}
