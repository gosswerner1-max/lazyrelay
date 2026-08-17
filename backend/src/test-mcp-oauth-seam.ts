// Verifies the ONE unproven assumption in the hosted MCP build: that
// LazyRelay's existing REST API accepts a Supabase OAuth access token.
//
// Why this matters: mcpServer.ts's callLazyRelayApi passes the caller's
// OAuth token straight through to LazyRelay's own /api routes. http/auth.ts
// ends by calling supabase.auth.getUser(token). If that call rejects a token
// whose audience is the MCP resource URI rather than "authenticated", the
// pass-through approach is dead and callLazyRelayApi has to be rewritten to
// call extracted route handlers instead. Nothing else changes either way.
//
// Requires Supabase's OAuth server to be ENABLED (Authentication -> OAuth
// Server). Until then step 1 fails with a clear message and nothing else runs.
//
// Usage:
//   Step A:  npx tsx src/test-mcp-oauth-seam.ts
//              -> checks the toggle, registers a client, prints a URL to open
//   Step B:  npx tsx src/test-mcp-oauth-seam.ts <code> <client_id> <verifier>
//              -> exchanges the code and runs the real assertions
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";

const supabaseUrl = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
if (!supabaseUrl) throw new Error("SUPABASE_URL is not set");

const ISSUER = `${supabaseUrl}/auth/v1`;
const RESOURCE = process.env.MCP_RESOURCE_URL ?? "https://lazyrelaylazyrelay-backend.onrender.com/mcp";
const API_BASE = process.env.MCP_SEAM_API_BASE ?? "https://lazyrelaylazyrelay-backend.onrender.com/api";
// Supabase requires an exact redirect URI match. localhost is fine here:
// nothing listens on it, the browser just lands on a dead page and we read
// the ?code= straight out of the address bar.
const REDIRECT_URI = "http://localhost:54545/callback";

const b64url = (b: Buffer) => b.toString("base64url");

async function discovery(): Promise<Record<string, string>> {
  const res = await fetch(`${supabaseUrl}/.well-known/oauth-authorization-server/auth/v1`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Supabase OAuth server is not reachable (HTTP ${res.status}). ${body}\n` +
        `If this says "feature_disabled", the toggle is still off: Supabase dashboard -> Authentication -> OAuth Server -> enable.`
    );
  }
  return (await res.json()) as Record<string, string>;
}

const [code, clientIdArg, verifierArg] = process.argv.slice(2);

if (!code) {
  // ---------- Step A: prove the toggle is on, register a client, print the URL ----------
  const meta = await discovery();
  console.log("STEP 1 PASS  Supabase OAuth server is ENABLED");
  console.log(`             authorization_endpoint: ${meta.authorization_endpoint}`);
  console.log(`             token_endpoint:         ${meta.token_endpoint}`);
  console.log(`             registration_endpoint:  ${meta.registration_endpoint ?? "(none advertised)"}\n`);

  const registrationEndpoint = meta.registration_endpoint ?? `${ISSUER}/oauth/clients/register`;
  const regRes = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "LazyRelay MCP seam test",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const reg = (await regRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!regRes.ok || !reg.client_id) {
    console.error(`STEP 2 FAIL  Dynamic client registration returned HTTP ${regRes.status}`);
    console.error(JSON.stringify(reg, null, 2));
    process.exit(1);
  }
  console.log(`STEP 2 PASS  Registered client ${reg.client_id}\n`);

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("client_id", String(reg.client_id));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "openid profile email");
  // RFC 8707 — this is what makes Supabase stamp our MCP URI into the token's
  // audience, which is the whole thing mcpAuth.ts checks for.
  authUrl.searchParams.set("resource", RESOURCE);

  console.log("STEP 3  Open this URL while signed in to LazyRelay, approve, then copy the ?code= from the address bar:\n");
  console.log(authUrl.href);
  console.log(`\nThen run:\n  npx tsx src/test-mcp-oauth-seam.ts <code> ${reg.client_id} ${verifier}`);
  process.exit(0);
}

// ---------- Step B: exchange the code and run the real assertions ----------
const meta = await discovery();
const tokenRes = await fetch(meta.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientIdArg,
    code_verifier: verifierArg,
    resource: RESOURCE,
  }).toString(),
});
const tokens = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
if (!tokenRes.ok || !tokens.access_token) {
  console.error(`FAIL  Token exchange returned HTTP ${tokenRes.status}`);
  console.error(JSON.stringify(tokens, null, 2));
  process.exit(1);
}
const accessToken = String(tokens.access_token);
console.log("PASS  Got a real OAuth access token\n");

// What Supabase actually put in the token. This decides everything below.
const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString()) as Record<string, unknown>;
console.log("Token claims that matter:");
console.log(`  iss = ${claims.iss}`);
console.log(`  aud = ${JSON.stringify(claims.aud)}`);
console.log(`  sub = ${claims.sub}`);
console.log(`  resource = ${JSON.stringify(claims.resource)}`);
console.log(`  scope = ${JSON.stringify(claims.scope)}\n`);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  if (!ok) failed++;
};

// 1. Does our own verifier accept a genuine token? This is the real-token
//    counterpart to test-mcp-auth.ts, which only ever used minted tokens.
const { SupabaseMcpTokenVerifier } = await import("./http/mcpAuth.js");
try {
  const info = await new SupabaseMcpTokenVerifier().verifyAccessToken(accessToken);
  check("mcpAuth.ts accepts a real Supabase OAuth token", true, `accountId ${info.extra?.accountId}`);
} catch (err) {
  check("mcpAuth.ts accepts a real Supabase OAuth token", false, (err as Error).message);
  console.log(
    "        NOTE: if this failed on audience, compare the aud/resource claims printed above\n" +
      "        against MCP_RESOURCE_URL. Supabase may place the resource somewhere else."
  );
}

// 2. *** THE SEAM. *** Does LazyRelay's existing REST API accept this token?
const apiRes = await fetch(`${API_BASE}/social-accounts`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const seamOk = apiRes.status === 200;
check(
  "SEAM: LazyRelay's REST API accepts the OAuth token (pass-through works)",
  seamOk,
  `GET /social-accounts -> HTTP ${apiRes.status}`
);
if (!seamOk) {
  console.log(
    "\n  >>> Pass-through does NOT work. supabase.auth.getUser() rejected the OAuth token.\n" +
      "      Fix is confined to callLazyRelayApi() in backend/src/http/mcpServer.ts:\n" +
      "      replace the fetch with direct calls to extracted route handlers.\n" +
      "      Do NOT loosen http/auth.ts to make this pass."
  );
}

console.log(`\n${failed === 0 ? "Seam verified." : `${failed} check(s) failed.`}`);
process.exit(failed === 0 ? 0 : 1);
