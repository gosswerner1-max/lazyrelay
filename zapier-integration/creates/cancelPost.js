const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Wraps DELETE /scheduled-posts/:id (backend/src/http/routes.ts:2834).
// Backend rejects a post that's mid-publish with a 409 ("try again in a
// moment") and a post that doesn't exist/isn't owned by this account with
// a 404 — both surface to Zapier as a normal action failure, nothing
// special-cased here. DELETE returns 204 No Content on success, so there's
// no response.data to return; a Zap needs something to show it worked.
const perform = async (z, bundle) => {
  await z.request({
    url: `${BASE_URL}/scheduled-posts/${bundle.inputData.postId}`,
    method: "DELETE",
  });

  return { id: bundle.inputData.postId, cancelled: true };
};

module.exports = {
  key: "cancel_post",
  noun: "Post",
  display: {
    label: "Cancel a Post",
    description: "Cancels a pending scheduled post before it publishes. Fails if the post is already publishing or already went live.",
  },
  operation: {
    perform,
    inputFields: [
      {
        key: "postId",
        label: "Post ID",
        type: "string",
        required: true,
        helpText: "The scheduled post's id (from Schedule Post's output, or another trigger).",
      },
    ],
    sample: {
      id: "b6f3c2a0-1e2d-4b3a-9c1a-0f8e2d3c4b5a",
      cancelled: true,
    },
  },
};
