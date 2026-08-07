#!/usr/bin/env node
// LazyRelay's MCP server — local/stdio only for this pass (v1). A hosted,
// remote MCP endpoint (what Ayrshare/Buffer actually offer — point your AI
// client at a URL, no install) is a deliberately separate, bigger
// follow-up: it needs its own always-on hosting, per-customer auth via
// headers, and rate limiting, none of which a stdio process needs. This
// covers the standard, portable form that works with Claude Desktop,
// Claude Code, Cursor, and anything else that speaks MCP over stdio.
//
// Auth is the customer's own lzr_live_ API key (self-serve, generated from
// the LazyRelay dashboard's Settings -> More -> API Keys), passed via the
// LAZYRELAY_API_KEY env var — never hardcoded, never logged.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.LAZYRELAY_API_BASE ?? "https://lazyrelaylazyrelay-backend.onrender.com/api";
const API_KEY = process.env.LAZYRELAY_API_KEY;

if (!API_KEY) {
  console.error(
    "LAZYRELAY_API_KEY is not set. Get one from your LazyRelay dashboard: Settings -> More -> API Keys -> Create key."
  );
  process.exit(1);
}

async function lazyRelayFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `LazyRelay API error (HTTP ${res.status})`;
    throw new Error(message);
  }
  return body;
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "lazyrelay", version: "0.1.0" });

server.tool(
  "list_connected_accounts",
  "List every social media account connected to this LazyRelay account, with platform, display name, and the id needed by schedule_post.",
  {},
  async () => textResult(await lazyRelayFetch("/social-accounts"))
);

server.tool(
  "schedule_post",
  "Schedule a post to one connected social account. Call list_connected_accounts first to get a valid socialAccountId — post to multiple platforms by calling this once per account.",
  {
    socialAccountId: z.string().describe("The connected account id to post to, from list_connected_accounts"),
    content: z.string().describe("The post text/caption"),
    scheduledFor: z
      .string()
      .describe("ISO 8601 timestamp for when to post — use the current time for immediate posting"),
    mediaUrl: z.string().optional().describe("A publicly accessible image or video URL to attach, if any"),
  },
  async ({ socialAccountId, content, scheduledFor, mediaUrl }) =>
    textResult(
      await lazyRelayFetch("/scheduled-posts", {
        method: "POST",
        body: JSON.stringify({ socialAccountId, content, scheduledFor, mediaUrl }),
      })
    )
);

server.tool(
  "list_scheduled_posts",
  "List this account's upcoming and recent posts, with status (pending/posted/failed) and Proof-of-Publish verification.",
  {},
  async () => textResult(await lazyRelayFetch("/scheduled-posts"))
);

server.tool(
  "delete_scheduled_post",
  "Cancel a pending scheduled post before it goes out. Has no effect on a post that's already gone out.",
  { id: z.string().describe("The scheduled post id, from list_scheduled_posts") },
  async ({ id }) => {
    await lazyRelayFetch(`/scheduled-posts/${id}`, { method: "DELETE" });
    return textResult({ success: true });
  }
);

server.tool(
  "get_analytics_summary",
  "Get post counts, verified-live rate, per-platform breakdown, and engagement totals (likes/comments/shares/views, where each platform exposes them) for a recent window.",
  { days: z.number().int().min(1).max(90).optional().describe("How many days back to summarize — default 30") },
  async ({ days }) => textResult(await lazyRelayFetch(`/analytics/summary?days=${days ?? 30}`))
);

server.tool(
  "get_mentions",
  "Get recent comments on this account's posts, on the platforms that support reading comments (Facebook, Instagram, Mastodon, Bluesky, YouTube).",
  {},
  async () => textResult(await lazyRelayFetch("/mentions"))
);

const transport = new StdioServerTransport();
await server.connect(transport);
