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
  "mediaUrl": "https://example.com/image.jpg"
}`,
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
    summary: "Post counts, verified-live rate, per-platform breakdown, engagement totals",
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
