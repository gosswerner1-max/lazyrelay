const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Wraps GET /mentions (backend/src/http/routes.ts:2102), which is
// per-POST comment listing, not a flat mention feed — it returns
// { posts: [{ postId, platform, content, comments: [...] }] }. Flattened
// here into one item per comment, since that's the actual "thing that
// happened" a Zap should trigger on. Only platforms whose adapter declares
// getComments are included at all (`supported: true`); unsupported
// platforms are silently skipped, same as the dashboard does.
//
// id is synthesized as `${postId}_${commentId}` rather than the bare
// comment id — Zapier's polling dedup keys off the top-level `id`, and a
// bare platform comment id isn't guaranteed unique across posts/platforms.
const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/mentions`,
    method: "GET",
  });

  const posts = (response.data && response.data.posts) || [];
  const mentions = [];
  for (const post of posts) {
    if (!post.supported) continue;
    for (const comment of post.comments || []) {
      mentions.push({
        id: `${post.postId}_${comment.id}`,
        postId: post.postId,
        commentId: comment.id,
        socialAccountId: post.socialAccountId,
        platform: post.platform,
        postContent: post.content,
        platformPostUrl: post.platformPostUrl,
        author: comment.author,
        text: comment.text,
        commentUrl: comment.url,
        createdAt: comment.createdAt,
        canReply: !!post.canReply,
      });
    }
  }
  return mentions;
};

module.exports = {
  key: "new_mention",
  noun: "Mention",
  display: {
    label: "New Mention",
    description: "Triggers when a new comment/reply appears on one of your published posts (platforms that support reading comments only).",
  },
  operation: {
    type: "polling",
    perform,
    sample: {
      id: "b6f3c2a0-1e2d-4b3a-9c1a-0f8e2d3c4b5a_c1d2e3f4",
      postId: "b6f3c2a0-1e2d-4b3a-9c1a-0f8e2d3c4b5a",
      commentId: "c1d2e3f4",
      socialAccountId: "3f2b1a90-8c7d-4e6f-9a1b-2c3d4e5f6a7b",
      platform: "mastodon",
      postContent: "Just shipped a new feature! Check it out.",
      platformPostUrl: "https://example-platform.com/posts/12345",
      author: "@a_customer",
      text: "This looks great, congrats!",
      commentUrl: "https://example-platform.com/posts/12345#comment-1",
      createdAt: "2026-08-19T09:05:00.000Z",
      canReply: true,
    },
  },
};
