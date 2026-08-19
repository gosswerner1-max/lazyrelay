const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Polling trigger, not a REST Hook. LazyRelay's webhook_url/webhook_secret
// (accounts table, migration 0041_webhooks.sql) is a single slot per
// account fired once by the scheduler — not a multi-subscriber list — so a
// REST Hook here would silently fight over/overwrite whatever a customer
// already has wired into that slot. Polling needs no backend change and
// leaves that slot alone.
const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/scheduled-posts/history`,
    method: "GET",
    params: { limit: 25 },
  });

  const posts = response.data || [];

  // "Published" = status posted AND it actually has a post_results row
  // (verified proof-of-publish), not just "the scheduler tried". Zapier
  // dedupes polling triggers on each item's `id`, which is why the raw
  // scheduled_posts.id is left as the top-level id here.
  return posts
    .filter((post) => post.status === "posted" && Array.isArray(post.post_results) && post.post_results.length > 0)
    .map((post) => {
      const result = post.post_results[0];
      return {
        id: post.id,
        content: post.content,
        socialAccountId: post.social_account_id,
        scheduledFor: post.scheduled_for,
        publishedAt: result.verification_checked_at || result.created_at,
        platformPostUrl: result.platform_post_url || null,
        platformPostId: result.platform_post_id || null,
        verifiedLive: result.verified_live,
      };
    });
};

module.exports = {
  key: "new_post_published",
  noun: "Post",
  display: {
    label: "New Post Published",
    description: "Triggers when a scheduled post is confirmed live (Proof-of-Publish verified).",
  },
  operation: {
    type: "polling",
    perform,
    sample: {
      id: "b6f3c2a0-1e2d-4b3a-9c1a-0f8e2d3c4b5a",
      content: "Just shipped a new feature! Check it out.",
      socialAccountId: "3f2b1a90-8c7d-4e6f-9a1b-2c3d4e5f6a7b",
      scheduledFor: "2026-08-19T09:00:00.000Z",
      publishedAt: "2026-08-19T09:01:12.000Z",
      platformPostUrl: "https://example-platform.com/posts/12345",
      platformPostId: "12345",
      verifiedLive: true,
    },
  },
};
