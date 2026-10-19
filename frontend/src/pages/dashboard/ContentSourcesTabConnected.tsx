// Joins the Content Sources tab to the dashboard's own state and handlers. Each of the three draft actions goes through a flow
// the Posts and Calendar tabs already use. The tab's two links go to the API Keys tab and to the plan page (the same place the
// dashboard's Upgrade button opens). Everything about sources, keys and proofs goes through the default companion service client.

import { ContentSourcesTab } from "../../components/dashboard/ContentSourcesTab";
import type { ScheduledPost } from "../../lib/api";
import { defaultContentSourcesClient } from "../../lib/contentSourcesDefault";
import { useDashboard } from "./DashboardContext";

export default function ContentSourcesTabConnected() {
  const { posts, brands, handleEditDraft, handleApprove, handlePromotePlanItem, handleDelete, setTab, setScrollToBillingPending } = useDashboard();

  // The Posts tab's draft editor, the same one its Edit button opens.
  function reviewAndEdit(post: ScheduledPost) {
    handleEditDraft(post);
    setTab("Posts");
  }

  // A post already waiting for approval with an account and a time gets the Posts tab's Approve. Anything else is a draft
  // (or an undated one), so it goes through the same promotion the Calendar's plan list uses: it schedules the draft when an
  // account and a time are already set, and otherwise opens the draft editor to pick them.
  function approveToCalendar(post: ScheduledPost) {
    if (post.status === "needs_approval") {
      if (post.social_account_id && post.scheduled_for) return handleApprove(post.id);
      return reviewAndEdit(post);
    }
    return handlePromotePlanItem(post);
  }

  // The tab has already asked "Delete this draft permanently?", so the delete is called as a non-history delete, which
  // skips its own second question.
  function purge(post: ScheduledPost) {
    return handleDelete(post.id, false);
  }

  // The dashboard's Upgrade button: the Settings tab, scrolled to billing.
  function openPlan() {
    setTab("Settings");
    setScrollToBillingPending(true);
  }

  return (
    <ContentSourcesTab
      posts={posts}
      brands={brands}
      client={defaultContentSourcesClient}
      onReviewAndEdit={reviewAndEdit}
      onApproveToCalendar={approveToCalendar}
      onPurge={purge}
      onOpenApiKeys={() => setTab("API Keys")}
      onOpenPlan={openPlan}
    />
  );
}
