// LazyRelay's hosted (remote) MCP server: the tool registration.
//
// The tools themselves are defined ONCE in ../mcp/lazyrelayTools.ts and shared with the local stdio
// package (mcp-server/), so an agent sees the same names, descriptions and behaviour either way.
// This file only supplies the one thing that differs by server: how a call reaches LazyRelay's REST API.
//
// The hosted difference is auth. The stdio server carries the customer's own lzr_live_ API key from an
// env var. Hosted, the caller arrives with an OAuth access token that mcpAuth.ts has already verified
// and bound to an account, so tools act as that account and never see an API key at all.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { accountIdFromAuth } from "./mcpAuth.js";
import { LazyRelayApiError, registerLazyRelayTools } from "../mcp/lazyrelayTools.js";

/** *** THE SEAM ***
 *
 *  Every tool reaches LazyRelay's real logic through this one function, so how that happens is a single
 *  decision in a single place.
 *
 *  Current approach ("pass the caller's token through"): call LazyRelay's own REST API with the customer's
 *  OAuth token as the bearer. http/auth.ts's requireAuth already ends by resolving a Supabase JWT via
 *  supabase.auth.getUser(), and a Supabase-issued OAuth access token is a Supabase JWT, so this reuses every
 *  quota check, tier limit, media validation and business rule with ZERO duplication and zero changes to
 *  the existing auth path.
 *
 *  *** NOT YET PROVEN AGAINST A LIVE OAUTH TOKEN. *** Supabase's OAuth server is still disabled on the
 *  project, so this could not be tested at build time. If getUser() turns out to reject a token whose
 *  audience is the MCP resource URI rather than "authenticated", replace the body of this function, and only
 *  this function, with a direct in-process call to extracted route handlers.
 *
 *  accountId is passed in and currently unused for exactly that reason: it is what the fallback needs. */
const API_BASE = process.env.MCP_API_BASE ?? "http://127.0.0.1:" + (process.env.PORT ?? "3000") + "/api";

export async function callLazyRelayApi(auth: AuthInfo, _accountId: string, path: string, options: RequestInit = {}): Promise<unknown> {
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
      typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `LazyRelay API error (HTTP ${res.status})`;
    throw new LazyRelayApiError(res.status, message);
  }
  return body;
}

/** Pulls the verified auth off the request the SDK threads into every tool handler. Throws if it is missing:
 *  a tool must never run unauthenticated, and failing loudly is the only safe behaviour if the middleware
 *  order is ever changed by mistake. */
function requireAuthInfo(extra: { authInfo?: AuthInfo }): { auth: AuthInfo; accountId: string } {
  const auth = extra.authInfo;
  if (!auth) throw new Error("MCP tool invoked without a verified access token");
  return { auth, accountId: accountIdFromAuth(auth) };
}

/** A fresh McpServer per request keeps the hosted transport stateless, so two customers' concurrent calls can
 *  never share server state. */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "lazyrelay", version: "0.3.0" });
  registerLazyRelayTools(server, async (path, options, extra) => {
    const { auth, accountId } = requireAuthInfo(extra as { authInfo?: AuthInfo });
    return callLazyRelayApi(auth, accountId, path, {
      ...(options?.method ? { method: options.method } : {}),
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  });
  return server;
}
