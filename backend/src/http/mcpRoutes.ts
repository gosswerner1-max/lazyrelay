// Mounts LazyRelay's hosted (remote) MCP endpoint and the OAuth discovery
// documents an MCP client needs to find its way to Supabase.
//
// Three things get mounted:
//   1. RFC 9728 protected resource metadata — the spec's one hard MUST for
//      a resource server ("MCP servers MUST implement OAuth 2.0 Protected
//      Resource Metadata"). Points clients at Supabase as the auth server.
//   2. POST /mcp — the Streamable HTTP transport, behind bearer auth.
//   3. A 401 with WWW-Authenticate on any unauthenticated call, which is
//      what actually kicks an MCP client into the OAuth flow.
import express, { type Express } from "express";
import cors from "cors";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SupabaseMcpTokenVerifier, MCP_RESOURCE_URL } from "./mcpAuth.js";
import { buildMcpServer } from "./mcpServer.js";
import { mcpRateLimit } from "./rateLimit.js";

export function mountMcp(app: Express, oauthMetadata: OAuthMetadata) {
  // An MCP client is not a browser on lazyrelay.com, so the dashboard's
  // origin allow-list must not apply. Origin is reflected rather than
  // wildcarded, and the two headers a browser-based MCP client genuinely
  // needs to read are exposed: WWW-Authenticate carries the discovery
  // pointer that starts the OAuth flow, and Mcp-Session-Id is how the
  // transport correlates a session.
  const mcpCors = cors({
    origin: true,
    exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    allowedHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  // Serves /.well-known/oauth-protected-resource (and mirrors the
  // authorization-server metadata), so a client that got a 401 can discover
  // Supabase without anything hardcoded on its side.
  //
  // mcpCors is gated to /.well-known paths by hand rather than passed
  // straight to app.use() -- found live 2026-08-17: app.use(mcpCors, router)
  // with no path argument makes Express run mcpCors on EVERY request, not
  // just the well-known ones, and mcpCors's own methods list has no PATCH.
  // For a browser CORS preflight (OPTIONS) to any other route -- e.g. the
  // dashboard's own PATCH /account -- the cors package answers the
  // preflight itself and never calls next(), so it silently ate PATCH
  // support for the whole API. mcpAuthMetadataRouter's routes are registered
  // as full /.well-known/... paths (expects to be mounted at root), so the
  // fix is gating mcpCors itself, not adding a mount-path prefix that would
  // double up the segment and break the router's own matching.
  app.use((req, res, next) => {
    if (req.path.startsWith("/.well-known")) {
      mcpCors(req, res, next);
      return;
    }
    next();
  });
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: MCP_RESOURCE_URL,
      resourceName: "LazyRelay",
      serviceDocumentationUrl: new URL("https://lazyrelay.com/docs"),
    }),
  );

  const requireMcpAuth = requireBearerAuth({
    verifier: new SupabaseMcpTokenVerifier(),
    // Deliberately no requiredScopes. Supabase issues OIDC-style scopes
    // (openid/profile/email/offline_access) and LazyRelay does not define
    // per-tool scopes yet, so demanding one here would reject every real
    // token for no security gain — the audience check in mcpAuth.ts is what
    // actually binds a token to this server. Revisit if per-tool scopes are
    // ever introduced; the spec's step-up flow expects a 403 then, not a 401.
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_RESOURCE_URL),
  });

  app.all(
    "/mcp",
    mcpCors,
    express.json(),
    requireMcpAuth,
    // Rate limiting sits AFTER auth so it keys on the verified account
    // rather than an IP shared by every customer behind one agent host.
    mcpRateLimit,
    async (req, res) => {
      // Stateless: a fresh server + transport per request, so two customers'
      // concurrent calls can never share state. sessionIdGenerator undefined
      // is what puts the transport in stateless mode.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
      });
      // TEMP DIAGNOSTIC 2026-09-04 — hunting the "MCP tool invoked without a
      // verified access token" bug (extra.authInfo undefined in tool
      // handlers despite requireMcpAuth passing). Logs whether req.auth was
      // actually set by the auth middleware at the exact point this file
      // hands the request to the transport. Remove once root-caused.
      console.log(
        `[mcp][diag] method=${req.method} hasReqAuth=${!!req.auth} accountId=${req.auth?.extra?.accountId ?? "none"} authInfoKeys=${req.auth ? Object.keys(req.auth).join(",") : "none"}`
      );
      try {
        const server = buildMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("[mcp] request failed:", err);
        if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
      }
    },
  );

  console.log(`[mcp] Hosted MCP server mounted at ${MCP_RESOURCE_URL.href}`);
}
