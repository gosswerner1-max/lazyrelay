// LazyRelay's hosted (remote) MCP server — the tool definitions.
//
// These are the same 6 tools the local/stdio server in mcp-server/ exposes,
// deliberately kept identical in name, description and shape so a customer
// gets the same vocabulary whether they run it locally or point their agent
// at the hosted URL. The stdio server is NOT replaced by this; hosted is an
// addition.
//
// The one real difference is auth. The stdio server carries the customer's
// own lzr_live_ API key from an env var. Hosted, the caller arrives with an
// OAuth access token that mcpAuth.ts has already verified and bound to an
// account, so tools act as that account and never see an API key at all.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { accountIdFromAuth } from "./mcpAuth.js";

/** *** THE SEAM ***
 *
 *  Every tool reaches LazyRelay's real logic through this one function, so
 *  how that happens is a single decision in a single place rather than
 *  something smeared across 6 handlers.
 *
 *  Current approach ("pass the caller's token through"): call LazyRelay's
 *  own REST API with the customer's OAuth token as the bearer. http/auth.ts's
 *  requireAuth already ends by resolving a Supabase JWT via
 *  supabase.auth.getUser(), and a Supabase-issued OAuth access token is a
 *  Supabase JWT — so this reuses every quota check, tier limit, media
 *  validation and business rule in routes.ts with ZERO duplication and zero
 *  changes to the existing auth path.
 *
 *  *** NOT YET PROVEN AGAINST A LIVE OAUTH TOKEN. *** Supabase's OAuth
 *  server is still disabled on the project, so this could not be tested at
 *  build time. If getUser() turns out to reject a token whose audience is
 *  the MCP resource URI rather than "authenticated", replace the body of
 *  this function — and only this function — with a direct in-process call
 *  to extracted route handlers. Nothing else in this file changes.
 *
 *  accountId is passed in and currently unused for exactly that reason: it
 *  is what the fallback needs, and threading it now keeps the swap to one
 *  function. */
const API_BASE = process.env.MCP_API_BASE ?? "http://127.0.0.1:" + (process.env.PORT ?? "3000") + "/api";

async function callLazyRelayApi(
  auth: AuthInfo,
  _accountId: string,
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${auth.token}`,
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

/** Pulls the verified auth off the request the SDK threads into every tool
 *  handler. Throws if it's missing — a tool must never run unauthenticated,
 *  and failing loudly is the only safe behaviour if the middleware order is
 *  ever changed by mistake. */
function requireAuthInfo(extra: { authInfo?: AuthInfo }): { auth: AuthInfo; accountId: string } {
  const auth = extra.authInfo;
  if (!auth) throw new Error("MCP tool invoked without a verified access token");
  return { auth, accountId: accountIdFromAuth(auth) };
}

/** A fresh McpServer per request keeps the hosted transport stateless, so
 *  two customers' concurrent calls can never share server state. */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "lazyrelay", version: "0.1.0" });

  server.tool(
    "list_connected_accounts",
    "List every social media account connected to this LazyRelay account, with platform, display name, and the id needed by schedule_post.",
    {},
    async (extra) => {
      const { auth, accountId } = requireAuthInfo(extra);
      return textResult(await callLazyRelayApi(auth, accountId, "/social-accounts"));
    }
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
      firstComment: z
        .string()
        .optional()
        .describe("Optional first comment posted immediately after publishing (Facebook and Instagram only)"),
    },
    async ({ socialAccountId, content, scheduledFor, mediaUrl, firstComment }, extra) => {
      const { auth, accountId } = requireAuthInfo(extra);
      return textResult(
        await callLazyRelayApi(auth, accountId, "/scheduled-posts", {
          method: "POST",
          body: JSON.stringify({ socialAccountId, content, scheduledFor, mediaUrl, firstComment }),
        })
      );
    }
  );

  server.tool(
    "list_scheduled_posts",
    "List this account's upcoming and recent posts, with status (pending/posted/failed) and Proof-of-Publish verification.",
    {},
    async (extra) => {
      const { auth, accountId } = requireAuthInfo(extra);
      return textResult(await callLazyRelayApi(auth, accountId, "/scheduled-posts"));
    }
  );

  server.tool(
    "delete_scheduled_post",
    "Cancel a pending scheduled post before it goes out. Has no effect on a post that's already gone out.",
    { id: z.string().describe("The scheduled post id, from list_scheduled_posts") },
    async ({ id }, extra) => {
      const { auth, accountId } = requireAuthInfo(extra);
      await callLazyRelayApi(auth, accountId, `/scheduled-posts/${id}`, { method: "DELETE" });
      return textResult({ success: true });
    }
  );

  server.tool(
    "get_analytics_summary",
    "Get post counts, verified-live rate, per-platform breakdown, and engagement totals (likes/comments/shares/views, where each platform exposes them) for a recent window.",
    { days: z.number().int().min(1).max(90).optional().describe("How many days back to summarize — default 30") },
    async ({ days }, extra) => {
      const { auth, accountId } = requireAuthInfo(extra);
      return textResult(await callLazyRelayApi(auth, accountId, `/analytics/summary?days=${days ?? 30}`));
    }
  );

  server.tool(
    "get_mentions",
    "Get recent comments on this account's posts, on the platforms that support reading comments (Facebook, Instagram, Mastodon, Bluesky, YouTube).",
    {},
    async (extra) => {
      const { auth, accountId } = requireAuthInfo(extra);
      return textResult(await callLazyRelayApi(auth, accountId, "/mentions"));
    }
  );

  return server;
}
