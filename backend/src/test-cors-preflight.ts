// Real regression test for a live bug found 2026-08-17 while checking the
// dashboard's Settings tab: mounting the hosted MCP server's own CORS
// policy via app.use(mcpCors, router) with no path argument made Express
// run it on EVERY request, not just /.well-known -- and mcpCors's methods
// list has no PATCH, so it silently answered every CORS preflight (to
// ANY route) with a methods list missing PATCH, breaking every PATCH
// endpoint in the API for real browser clients (POST /account -- business
// name, failure alerts, webhook -- among others).
//
// Run: npx tsx src/test-cors-preflight.ts
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

// The bug only fires when MCP is actually mounted -- must pass real
// metadata, not the no-mcp path test-mcp-http.ts and test-team-invite.ts use.
const app = buildApp(new StubMorAdapter(), new Map() as PlatformAdapterRegistry, stubMetadata);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;

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

const dashboardOrigin = process.env.FRONTEND_URL ?? "http://localhost:5173";

// 1. The actual bug: a real browser CORS preflight for PATCH /api/account
//    from the dashboard's own origin must allow PATCH.
{
  const res = await fetch(`${base}/api/account`, {
    method: "OPTIONS",
    headers: {
      Origin: dashboardOrigin,
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
  check(
    "PATCH /api/account preflight allows PATCH",
    res.status < 400 && /PATCH/i.test(allowMethods),
    `HTTP ${res.status}, Access-Control-Allow-Methods: "${allowMethods}"`
  );
}

// 2. Same check on another real PATCH endpoint, to confirm this isn't
//    somehow specific to /account.
{
  const res = await fetch(`${base}/api/social-accounts/00000000-0000-0000-0000-000000000000`, {
    method: "OPTIONS",
    headers: {
      Origin: dashboardOrigin,
      "Access-Control-Request-Method": "PATCH",
    },
  });
  const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
  check(
    "PATCH /api/social-accounts/:id preflight allows PATCH",
    res.status < 400 && /PATCH/i.test(allowMethods),
    `HTTP ${res.status}, Access-Control-Allow-Methods: "${allowMethods}"`
  );
}

// 3. Regression check: the MCP well-known endpoint's own CORS must still
//    work exactly as before -- this fix must not have broken the same-day
//    hosted MCP server launch to fix this bug.
{
  const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
    headers: { Origin: "https://claude.ai" },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  check(
    "MCP well-known metadata still serves correctly with CORS",
    res.status === 200 && !!body.resource,
    `HTTP ${res.status}`
  );
}

// 4. A disallowed origin must still be rejected for the dashboard API --
//    the fix must not have accidentally widened the origin allow-list.
{
  const res = await fetch(`${base}/api/account`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example.com",
      "Access-Control-Request-Method": "PATCH",
    },
  });
  const allowOrigin = res.headers.get("access-control-allow-origin");
  check("an untrusted origin is still not granted CORS access to the dashboard API", !allowOrigin, `Access-Control-Allow-Origin: ${allowOrigin}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
server.close();
process.exit(failed === 0 ? 0 : 1);
