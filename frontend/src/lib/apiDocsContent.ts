// Single source of truth for the API/MCP documentation content, shared by
// the public marketing page (frontend/src/pages/ApiDocs.tsx, for
// developers evaluating LazyRelay before they have an account) and the
// embedded copy inside the dashboard's API Keys tab (for existing
// customers, who shouldn't need to leave the app or lose their session to
// see this). Keeping one shared source means the two can never drift out
// of sync with each other.

export interface ApiEndpointDoc {
  method: "GET" | "POST" | "DELETE";
  path: string;
  summary: string;
  body: string | null;
}

export const API_BASE_URL = "https://lazyrelaylazyrelay-backend.onrender.com/api";

export const API_ENDPOINTS: ApiEndpointDoc[] = [
  {
    method: "GET",
    path: "/social-accounts",
    summary: "List your connected social accounts",
    body: null,
  },
  {
    method: "POST",
    path: "/scheduled-posts",
    summary: "Schedule a post to one connected account",
    body: `{
  "socialAccountId": "…",
  "content": "Your post text",
  "scheduledFor": "2026-08-10T09:00:00Z",
  "mediaUrl": "https://example.com/image.jpg",
  "mediaUrls": ["https://example.com/second.jpg"],
  "tags": ["launch"],
  "selfReplyText": "Thank you all!",
  "selfReplyAtLikes": 50
}`,
  },
  {
    method: "GET",
    path: "/posting-slots/next?socialAccountId=…",
    summary:
      "The next free time from the posting times saved in Settings for one account, as an ISO timestamp to use as scheduledFor. Optional post fields: mediaUrls adds extra images after mediaUrl (Instagram and Threads 10 in total, videos allowed; Facebook and Tumblr 10, LinkedIn 9, Bluesky, Mastodon and X 4, images only); tags are up to 5 labels you can filter analytics by; selfReplyText is a comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram, added at the next engagement check).",
    body: null,
  },
  {
    method: "GET",
    path: "/scheduled-posts",
    summary: "List upcoming and recent posts, with status and Proof-of-Publish verification",
    body: null,
  },
  {
    method: "DELETE",
    path: "/scheduled-posts/:id",
    summary: "Cancel a pending post",
    body: null,
  },
  {
    method: "GET",
    path: "/analytics/summary?days=30",
    summary: "Post counts, verified-live rate, per-platform breakdown, engagement totals. Add &tag=launch to count only posts with that tag; availableTags lists the tags you have used.",
    body: null,
  },
  {
    method: "GET",
    path: "/mentions",
    summary: "Recent comments on your posts, where the platform supports reading them",
    body: null,
  },
  {
    method: "POST",
    path: "/mentions/reply",
    summary: "Reply to a comment surfaced by GET /mentions",
    body: `{
  "postId": "…",
  "commentId": "…",
  "text": "Thanks so much!"
}`,
  },
];

export const MCP_CONFIG_EXAMPLE = `{
  "mcpServers": {
    "lazyrelay": {
      "command": "npx",
      "args": ["-y", "@lazyrelay/mcp-server"],
      "env": { "LAZYRELAY_API_KEY": "lzr_live_your_key_here" }
    }
  }
}`;

/** URL of the hosted MCP server (Streamable HTTP transport). Must match
 *  MCP_RESOURCE_URL in backend/src/http/mcpAuth.ts exactly — that's the
 *  token audience the server validates against, so drift here would
 *  produce a working-looking connector that always fails to authenticate. */
export const HOSTED_MCP_URL = "https://lazyrelaylazyrelay-backend.onrender.com/mcp";

/** Config for MCP clients that connect via a config file (Claude Code,
 *  Cursor, etc.) rather than a UI-driven "add connector" flow. A "url"
 *  field, not "command"/"args" — the client handles the OAuth flow itself
 *  the first time it connects, same as clicking through it in claude.ai. */
export const HOSTED_MCP_REMOTE_CONFIG_EXAMPLE = `{
  "mcpServers": {
    "lazyrelay": {
      "url": "${HOSTED_MCP_URL}"
    }
  }
}`;

/** The same tools as the local/stdio server (defined once in backend/src/mcp/lazyrelayTools.ts; a backend test fails if this list drifts), kept as its own hand-maintained
 *  list rather than importing from the backend (this is frontend-only
 *  code) — same pattern already used for API_ENDPOINTS above. Descriptions
 *  copied verbatim from backend/src/http/mcpServer.ts; update both places
 *  together if a tool changes. */
export interface McpToolDoc {
  name: string;
  summary: string;
}

export const MCP_TOOLS: McpToolDoc[] = [
  { name: "list_connected_accounts", summary: "List your connected social accounts and their ids" },
  { name: "list_workspaces", summary: "List your brands (workspaces)" },
  { name: "get_platform_rules", summary: "Look up what a platform accepts before posting: text limit, media rules, required fields, features and options" },
  { name: "get_tiktok_creator_info", summary: "See which privacy levels and settings a TikTok account allows (needed before posting to TikTok)" },
  { name: "list_pinterest_boards", summary: "List a Pinterest account's boards (a Pinterest post needs a board)" },
  { name: "get_next_free_slot", summary: "Find the next free posting time from the times saved in Settings" },
  { name: "list_posting_slots", summary: "List the saved posting times" },
  { name: "list_snippets", summary: "List saved text snippets and the signature" },
  { name: "schedule_post", summary: "Schedule a post to one account, with images, tags, TikTok settings, platform options and optional approval" },
  { name: "publish_post_now", summary: "Publish to one account right away" },
  { name: "create_draft", summary: "Save a draft without an account or a time" },
  { name: "schedule_draft", summary: "Turn a saved draft into a scheduled post" },
  { name: "update_post", summary: "Edit a draft, a post waiting for approval, or a pending post" },
  { name: "list_scheduled_posts", summary: "See posts with status and whether each is confirmed live, filtered and summarised" },
  { name: "delete_scheduled_post", summary: "Cancel a pending or waiting post" },
  { name: "get_proof_link", summary: "Get a public proof-of-publish link for a post confirmed live" },
  { name: "approve_post", summary: "Approve a post that is waiting for approval" },
  { name: "create_review_link", summary: "Create a link a client opens, with no account, to approve posts and comment" },
  { name: "list_review_links", summary: "List client review links and their status" },
  { name: "revoke_review_link", summary: "Stop a client review link" },
  { name: "get_post_feedback", summary: "Read the client's feedback on a post" },
  { name: "reply_to_post_feedback", summary: "Reply to the client's feedback" },
  { name: "get_analytics_summary", summary: "Post counts, verified-live rate, per-platform and per-tag results, engagement" },
  { name: "get_mentions", summary: "Recent comments on your posts, where the platform allows reading them" },
];
