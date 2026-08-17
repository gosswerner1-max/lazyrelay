// Tests the hosted MCP server's token verifier — the security boundary.
//
// Run: npx tsx src/test-mcp-auth.ts
//
// The MCP spec's hardest requirement on a resource server is that it MUST
// only accept tokens minted for itself. The SDK's requireBearerAuth does
// NOT check that, so mcpAuth.ts is the only thing standing between LazyRelay
// and a replayed token. A happy-path check would prove nothing about that,
// so every case below is a rejection case except the first.
import "dotenv/config";
import { SignJWT, generateKeyPair, type JWTPayload } from "jose";
import { SupabaseMcpTokenVerifier, SUPABASE_ISSUER, MCP_RESOURCE_URL } from "./http/mcpAuth.js";

const RESOURCE = MCP_RESOURCE_URL.href;
const SUBJECT = "11111111-2222-3333-4444-555555555555";

const { privateKey, publicKey } = await generateKeyPair("ES256");
const { privateKey: otherPrivateKey } = await generateKeyPair("ES256");

// Stands in for Supabase's JWKS. Returns our test public key for any token,
// so a token signed by a DIFFERENT key fails on signature exactly as it
// would in production.
const keys = async () => publicKey;
const verifier = new SupabaseMcpTokenVerifier(keys);

async function mint(
  payload: JWTPayload,
  opts: { alg?: string; key?: unknown; expiresIn?: string } = {}
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: opts.alg ?? "ES256" })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "10m")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .sign((opts.key ?? privateKey) as any);
}

type Case = { name: string; token: () => Promise<string>; shouldPass: boolean; expectContains?: string };

const cases: Case[] = [
  {
    name: "VALID — correct issuer, audience is this MCP server, real signature",
    token: () => mint({ iss: SUPABASE_ISSUER, aud: RESOURCE, sub: SUBJECT, scope: "openid profile" }),
    shouldPass: true,
  },
  {
    name: "REJECT — audience is a DIFFERENT resource server (the replay case)",
    token: () => mint({ iss: SUPABASE_ISSUER, aud: "https://someone-elses-mcp.example.com/mcp", sub: SUBJECT }),
    shouldPass: false,
    expectContains: "not issued for this MCP server",
  },
  {
    name: 'REJECT — ordinary Supabase dashboard session (aud "authenticated")',
    token: () => mint({ iss: SUPABASE_ISSUER, aud: "authenticated", sub: SUBJECT }),
    shouldPass: false,
    expectContains: "ordinary Supabase session token",
  },
  {
    name: "REJECT — no audience claim at all",
    token: () => mint({ iss: SUPABASE_ISSUER, sub: SUBJECT }),
    shouldPass: false,
    expectContains: "not issued for this MCP server",
  },
  {
    name: "REJECT — correct audience but signed by a different key",
    token: () => mint({ iss: SUPABASE_ISSUER, aud: RESOURCE, sub: SUBJECT }, { key: otherPrivateKey }),
    shouldPass: false,
    expectContains: "signature or format is invalid",
  },
  {
    name: "REJECT — issuer is not Supabase (mix-up attack)",
    token: () => mint({ iss: "https://attacker.example/auth/v1", aud: RESOURCE, sub: SUBJECT }),
    shouldPass: false,
  },
  {
    name: "REJECT — expired token",
    token: () => mint({ iss: SUPABASE_ISSUER, aud: RESOURCE, sub: SUBJECT }, { expiresIn: "-5m" }),
    shouldPass: false,
    expectContains: "expired",
  },
  {
    name: "REJECT — no subject, so it identifies no account",
    token: () => mint({ iss: SUPABASE_ISSUER, aud: RESOURCE }),
    shouldPass: false,
    expectContains: "no subject",
  },
  {
    name: "REJECT — audience array that does not include this server",
    token: () => mint({ iss: SUPABASE_ISSUER, aud: ["https://a.example/mcp", "https://b.example/mcp"], sub: SUBJECT }),
    shouldPass: false,
    expectContains: "not issued for this MCP server",
  },
  {
    name: "ACCEPT — audience array that DOES include this server",
    token: () => mint({ iss: SUPABASE_ISSUER, aud: ["https://a.example/mcp", RESOURCE], sub: SUBJECT }),
    shouldPass: true,
  },
];

console.log(`Resource identifier under test: ${RESOURCE}`);
console.log(`Expected issuer:                ${SUPABASE_ISSUER}\n`);

let passed = 0;
let failed = 0;

for (const c of cases) {
  let outcome: "accepted" | "rejected";
  let detail = "";
  let accountId: string | undefined;
  try {
    const info = await verifier.verifyAccessToken(await c.token());
    outcome = "accepted";
    accountId = info.extra?.accountId as string | undefined;
  } catch (err) {
    outcome = "rejected";
    detail = (err as Error).message;
  }

  const behavedCorrectly = c.shouldPass ? outcome === "accepted" : outcome === "rejected";
  const messageOk =
    !c.expectContains || (outcome === "rejected" && detail.toLowerCase().includes(c.expectContains.toLowerCase()));

  if (behavedCorrectly && messageOk) {
    passed++;
    console.log(`PASS  ${c.name}`);
    if (outcome === "rejected") console.log(`        -> ${detail}`);
    if (outcome === "accepted") console.log(`        -> accountId ${accountId}`);
  } else {
    failed++;
    console.log(`FAIL  ${c.name}`);
    console.log(`        expected ${c.shouldPass ? "accepted" : "rejected"}, got ${outcome}${detail ? ` (${detail})` : ""}`);
    if (!messageOk) console.log(`        expected message to contain: "${c.expectContains}"`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
