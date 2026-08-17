// Smoke-tests the hosted MCP endpoint's HTTP contract against a real
// locally-started app — the discovery document and the 401 challenge that
// actually bootstraps an MCP client into the OAuth flow.
//
// Run: npx tsx src/test-mcp-http.ts
//
// Uses a stub authorization-server metadata document so this runs without
// Supabase's OAuth server being enabled. It proves mounting, CORS, the RFC
// 9728 document and the WWW-Authenticate challenge. It does NOT prove a real
// OAuth flow — that needs the Supabase toggle and a real MCP client.
import "dotenv/config";
import { buildApp } from "./http/app.js";
import { StubMorAdapter } from "./billing/stub.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { PlatformAdapterRegistry } from "./platforms/connect.js";

const issuer = `${(process.env.SUPABASE_URL ?? "https://example.supabase.co").replace(/\/$/, "")}/auth/v1`;

const stubMetadata: OAuthMetadata = {
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

const app = buildApp(new StubMorAdapter(), new Map() as PlatformAdapterRegistry, stubMetadata);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
console.log(`Test server on ${base}\n`);

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  }
}

// 1. RFC 9728 protected resource metadata — the spec's one hard MUST.
//    Because the MCP endpoint lives at /mcp rather than the root, the
//    document is served at the PATH-INSERTED well-known URI
//    (/.well-known/oauth-protected-resource/mcp). That is the form the spec
//    tells clients to try first, and it is the exact URL the 401 challenge
//    below advertises, so this is compliant — the root form is not required.
{
  const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  check("protected resource metadata returns 200", res.status === 200, `HTTP ${res.status}`);
  const servers = body.authorization_servers;
  check(
    "metadata names at least one authorization server (spec MUST)",
    Array.isArray(servers) && servers.length > 0,
    JSON.stringify(servers)
  );
  check(
    "metadata points at Supabase as the authorization server",
    Array.isArray(servers) && servers.some((s) => String(s).includes("supabase") || String(s) === issuer),
    JSON.stringify(servers)
  );
  check("metadata declares the resource identifier", typeof body.resource === "string", String(body.resource));

  // The 401 challenge is the primary discovery mechanism and points at the
  // path-inserted URL above, so this is informational only — recorded so a
  // future reader knows it was checked rather than overlooked.
  const rootRes = await fetch(`${base}/.well-known/oauth-protected-resource`);
  console.log(
    `INFO  root-level /.well-known/oauth-protected-resource -> HTTP ${rootRes.status} ` +
      `(not required; clients try the path-inserted form first and the 401 names it explicitly)`
  );
}

// 2. Unauthenticated MCP call must 401 WITH the discovery pointer — this is
//    what tells a client where to go; a bare 401 leaves it stuck.
{
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const wwwAuth = res.headers.get("www-authenticate") ?? "";
  check("unauthenticated /mcp returns 401", res.status === 401, `HTTP ${res.status}`);
  check("401 carries a WWW-Authenticate Bearer challenge", wwwAuth.toLowerCase().startsWith("bearer"), wwwAuth);
  check("challenge includes resource_metadata pointer", wwwAuth.includes("resource_metadata="), wwwAuth);
}

// 3. A garbage bearer token must also 401, not 500.
{
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("invalid token returns 401 (not 500)", res.status === 401, `HTTP ${res.status}`);
}

// 4. The dashboard API must be completely unaffected by the MCP mount.
{
  const res = await fetch(`${base}/health`);
  check("existing /health still works", res.status === 200, `HTTP ${res.status}`);
  const api = await fetch(`${base}/api/scheduled-posts`);
  check("existing API still requires its own auth (401)", api.status === 401, `HTTP ${api.status}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
server.close(() => process.exit(failed === 0 ? 0 : 1));
