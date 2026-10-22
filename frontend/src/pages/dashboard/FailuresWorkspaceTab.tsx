// The Failures workspace tab: reads accounts and posts from the dashboard state (failed posts are already in that list) and makes no API call of its
// own. It takes the place of the old Failed page in the menu. Shown only when VITE_FAILURES_WORKSPACE_ENABLED is "true".

import { FailuresWorkspace } from "../../components/dashboard/FailuresWorkspace";
import { useDashboard } from "./DashboardContext";

export function FailuresWorkspaceTab() {
  const { accounts, posts } = useDashboard();
  return <FailuresWorkspace accounts={accounts} posts={posts} />;
}
