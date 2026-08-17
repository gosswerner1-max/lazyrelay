// Token verification for LazyRelay's hosted (remote) MCP server.
//
// LazyRelay is the OAuth 2.1 *resource server* here, not the authorization
// server. Supabase Auth's own OAuth 2.1 server issues the tokens (PKCE,
// consent, client registration, refresh) — see
// https://supabase.com/docs/guides/auth/oauth-server. All this file does is
// prove an incoming token is genuinely one of those, and that it was minted
// for THIS server specifically.
//
// *** The audience check below is the security boundary. ***
// The MCP spec is emphatic: "MCP servers MUST validate that access tokens
// were issued specifically for them as the intended audience" and "MUST NOT
// accept or transit any other tokens". The SDK's own requireBearerAuth
// middleware does NOT do this — it checks scopes and expiry only, and never
// compares AuthInfo.resource to the server's identifier despite its type
// doc saying it MUST match. So if this file doesn't enforce it, nothing
// does, and any Supabase-issued token for any other purpose (including a
// plain logged-in dashboard session) would be replayable against MCP.
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { JWTPayload } from "jose";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) throw new Error("SUPABASE_URL is required for the MCP server");

/** Supabase Auth's issuer, exactly as it appears in its own OIDC discovery
 *  document (verified live: {SUPABASE_URL}/auth/v1). Pinned rather than
 *  derived loosely, because a mismatched issuer is one of the mix-up
 *  attacks the spec's security considerations call out. */
export const SUPABASE_ISSUER = `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;

/** The canonical URI of this MCP server, per RFC 8707 / RFC 9728. This is
 *  the value clients send as the `resource` parameter and the value
 *  Supabase stamps into the token's audience — so it must match the real
 *  public URL exactly, with no trailing slash and no fragment. */
export const MCP_RESOURCE_URL = new URL(
  process.env.MCP_RESOURCE_URL ?? "https://lazyrelaylazyrelay-backend.onrender.com/mcp"
);

/** jose caches the key set and re-fetches on unknown `kid`, so key rotation
 *  is handled without a restart. LazyRelay's project signs with ES256
 *  (verified live against its JWKS) — the algorithm is pinned at verify
 *  time below so a token claiming e.g. HS256 can never be accepted, which
 *  is the classic algorithm-confusion attack. */
const jwks = createRemoteJWKSet(new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`));

/** Supabase's ordinary user sessions (dashboard logins) carry aud
 *  "authenticated". Those are NOT tokens minted for this resource server,
 *  and accepting one here would defeat the whole audience requirement, so
 *  it is rejected explicitly rather than merely failing to match. */
const SUPABASE_DEFAULT_AUDIENCE = "authenticated";

function audienceMatches(aud: JWTPayload["aud"], expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

/** Space-delimited per OAuth; absent for tokens issued without scope. */
function parseScopes(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === "string") return raw.split(" ").filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

/** The key resolver jose verifies against. Defaults to Supabase's live
 *  JWKS; test-mcp-auth.ts injects a locally generated key so the rejection
 *  cases (wrong audience, wrong issuer, algorithm confusion, expiry) can be
 *  exercised for real rather than assumed. Nothing else should override it. */
type KeyResolver = Parameters<typeof jwtVerify>[1];

export class SupabaseMcpTokenVerifier implements OAuthTokenVerifier {
  private readonly keys: KeyResolver;

  constructor(keys: KeyResolver = jwks) {
    this.keys = keys;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      // Signature, issuer, expiry and not-before are all enforced here.
      // `algorithms` is pinned deliberately — see the note above.
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: SUPABASE_ISSUER,
        algorithms: ["ES256"],
      }));
    } catch (err) {
      // Every verification failure is surfaced as InvalidTokenError so the
      // SDK middleware answers 401 with a WWW-Authenticate challenge, which
      // is what tells an MCP client to go and get a real token. A 500 here
      // would leave the client with no way to recover.
      const reason =
        err instanceof joseErrors.JWTExpired
          ? "Access token has expired"
          : err instanceof joseErrors.JWTClaimValidationFailed
            ? `Access token claim rejected: ${err.claim}`
            : "Access token signature or format is invalid";
      throw new InvalidTokenError(reason);
    }

    const expected = MCP_RESOURCE_URL.href;

    if (audienceMatches(payload.aud, SUPABASE_DEFAULT_AUDIENCE)) {
      throw new InvalidTokenError(
        "This is an ordinary Supabase session token, not an access token issued for LazyRelay's MCP server"
      );
    }

    // RFC 8707: the token must name this resource server. Supabase places
    // the client's `resource` parameter in `aud`; the explicit `resource`
    // claim is checked too so a future change in either direction still
    // validates rather than silently passing.
    const resourceClaim = typeof payload.resource === "string" ? payload.resource : undefined;
    const audOk = audienceMatches(payload.aud, expected);
    const resourceOk = resourceClaim === expected;
    if (!audOk && !resourceOk) {
      throw new InvalidTokenError(
        `Access token was not issued for this MCP server (expected audience ${expected})`
      );
    }

    const accountId = payload.sub;
    if (!accountId) {
      throw new InvalidTokenError("Access token has no subject, so it identifies no account");
    }

    return {
      token,
      // `azp`/`client_id` identifies the registered MCP client (e.g. Claude).
      clientId:
        (typeof payload.client_id === "string" && payload.client_id) ||
        (typeof payload.azp === "string" && payload.azp) ||
        "unknown",
      scopes: parseScopes(payload),
      expiresAt: payload.exp,
      resource: MCP_RESOURCE_URL,
      // A Supabase user id IS the LazyRelay account id — the same mapping
      // http/auth.ts already makes for dashboard JWTs (req.accountId =
      // data.user.id). Carried in `extra` so tool handlers never have to
      // re-derive it from the raw token.
      extra: { accountId },
    };
  }
}

/** Fetches Supabase's own OAuth 2.1 authorization-server metadata, which
 *  LazyRelay re-advertises to MCP clients through the RFC 9728 protected
 *  resource metadata document.
 *
 *  Returns null (never throws) when Supabase's OAuth server is switched off
 *  — it answers 404 `feature_disabled` in that state, which is exactly the
 *  project's current state. The caller treats null as "don't mount MCP at
 *  all" and logs loudly, so a disabled toggle produces an obvious startup
 *  message instead of a half-working endpoint that 500s on every call. */
export async function fetchSupabaseOAuthMetadata(): Promise<OAuthMetadata | null> {
  const url = `${SUPABASE_ISSUER}/.well-known/openid-configuration`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(
        `[mcp] Supabase OAuth metadata unavailable (HTTP ${res.status}) at ${url} — ` +
          `hosted MCP will NOT be mounted. Enable it in the Supabase dashboard: Authentication -> OAuth Server.`
      );
      return null;
    }
    const metadata = (await res.json()) as OAuthMetadata;
    // Supabase serves the OIDC document even while the OAuth server itself
    // is disabled, so the presence of the document is not proof the feature
    // is on. The authorization endpoint is what actually has to exist.
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      console.warn(`[mcp] Supabase OAuth metadata at ${url} has no authorization/token endpoint — MCP not mounted.`);
      return null;
    }
    return metadata;
  } catch (err) {
    console.warn(`[mcp] Could not reach Supabase OAuth metadata at ${url}:`, (err as Error).message);
    return null;
  }
}

/** Reads the account id a verified MCP request is acting for. Throws rather
 *  than returning undefined: every MCP tool touches customer data, so a
 *  missing account id must fail loudly, never fall through to "no filter". */
export function accountIdFromAuth(auth: AuthInfo | undefined): string {
  const accountId = auth?.extra?.accountId;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("MCP request reached a tool handler without a verified account id");
  }
  return accountId;
}
