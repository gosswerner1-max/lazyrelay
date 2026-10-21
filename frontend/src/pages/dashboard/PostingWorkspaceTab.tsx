// The Posting workspace tab: reads accounts, brands and posts from the dashboard state (the same source every other tab uses) and sends through
// the existing draft and scheduling API only when the customer presses a button. Shown only when VITE_POSTING_WORKSPACE_ENABLED is "true".

import { api } from "../../lib/api";
import { PostingWorkspace, type DraftRequest, type ScheduleRequest } from "../../components/dashboard/PostingWorkspace";
import { useDashboard } from "./DashboardContext";

export function PostingWorkspaceTab() {
  const { accounts, brands, posts, refresh } = useDashboard();

  async function saveDraft({ content, plannedAccountIds }: DraftRequest) {
    await api.saveDraft({ content, plannedAccountIds });
    await refresh();
  }

  async function schedule({ content, accountIds, scheduledFor }: ScheduleRequest) {
    // One post per account, like the Posts tab does. A failure on one account must not hide the ones that went through.
    const results = await Promise.allSettled(accountIds.map((socialAccountId) => api.createScheduledPost({ socialAccountId, content, scheduledFor })));
    await refresh();
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length > 0) {
      const first = failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason);
      throw new Error(failed.length === results.length ? first : `${failed.length} of ${results.length} posts could not be scheduled: ${first}`);
    }
  }

  return <PostingWorkspace accounts={accounts} brands={brands} posts={posts} onSaveDraft={saveDraft} onSchedule={schedule} />;
}
