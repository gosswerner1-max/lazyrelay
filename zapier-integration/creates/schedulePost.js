const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Wraps POST /scheduled-posts (backend/src/http/routes.ts:1801), validated
// server-side by validatePostFields (routes.ts:1615) — this action
// deliberately does no client-side re-validation of its own, since the
// backend is the single source of truth for tier limits, media/platform
// compatibility, and ownership checks. Errors come back as a real 4xx with
// a plain-English `error` field, which Zapier surfaces to the customer.
const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/scheduled-posts`,
    method: "POST",
    body: {
      socialAccountId: bundle.inputData.socialAccountId,
      content: bundle.inputData.content,
      scheduledFor: bundle.inputData.scheduledFor,
      mediaUrl: bundle.inputData.mediaUrl || undefined,
      firstComment: bundle.inputData.firstComment || undefined,
      mediaAltText: bundle.inputData.mediaAltText || undefined,
    },
  });

  return response.data;
};

module.exports = {
  key: "schedule_post",
  noun: "Post",
  display: {
    label: "Schedule Post",
    description: "Schedules (or immediately posts) content to a connected LazyRelay social account.",
  },
  operation: {
    perform,
    inputFields: [
      {
        key: "socialAccountId",
        label: "Social Account",
        type: "string",
        required: true,
        dynamic: "list_social_accounts.id.label",
        helpText: "Which connected LazyRelay account to post to.",
      },
      { key: "content", label: "Content", type: "text", required: true },
      {
        key: "scheduledFor",
        label: "Scheduled For",
        type: "datetime",
        required: true,
        helpText: "When to publish. Use the current time (or a moment just past) to post immediately.",
      },
      {
        key: "mediaUrl",
        label: "Media URL",
        type: "string",
        required: false,
        helpText: "A media URL from a prior \"Upload Media\" step, or any LazyRelay-hosted media URL.",
      },
      { key: "firstComment", label: "First Comment", type: "string", required: false, helpText: "Facebook/Instagram only — ignored by other platforms." },
      { key: "mediaAltText", label: "Media Alt Text", type: "string", required: false, helpText: "Mastodon only — ignored by other platforms." },
    ],
    // Matches the real INSERT ... .select().single() response shape
    // (routes.ts:1774-1798) — snake_case, straight from the scheduled_posts
    // row, not a hand-shaped API contract.
    sample: {
      id: "b6f3c2a0-1e2d-4b3a-9c1a-0f8e2d3c4b5a",
      account_id: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      social_account_id: "3f2b1a90-8c7d-4e6f-9a1b-2c3d4e5f6a7b",
      content: "Just shipped a new feature! Check it out.",
      scheduled_for: "2026-08-19T09:00:00.000Z",
      status: "pending",
      created_at: "2026-08-19T08:55:00.000Z",
    },
  },
};
