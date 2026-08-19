const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Wraps POST /mentions/reply (backend/src/http/routes.ts:2203). Only works
// on platforms whose adapter declares replyToComment (Facebook, Instagram,
// Mastodon, Bluesky as of this build) — the backend itself returns a plain
// 400 with a clear message on unsupported platforms, surfaced to Zapier as
// a normal action failure rather than something this file special-cases.
const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/mentions/reply`,
    method: "POST",
    body: {
      postId: bundle.inputData.postId,
      commentId: bundle.inputData.commentId,
      text: bundle.inputData.text,
    },
  });

  return response.data;
};

module.exports = {
  key: "reply_to_mention",
  noun: "Reply",
  display: {
    label: "Reply to a Mention",
    description: "Replies to a comment surfaced by the New Mention trigger.",
  },
  operation: {
    perform,
    inputFields: [
      { key: "postId", label: "Post ID", type: "string", required: true, helpText: "From the New Mention trigger's Post ID field." },
      { key: "commentId", label: "Comment ID", type: "string", required: true, helpText: "From the New Mention trigger's Comment ID field." },
      { key: "text", label: "Reply Text", type: "text", required: true },
    ],
    sample: {
      success: true,
    },
  },
};
