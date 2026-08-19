import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { supabase } from "../supabase.js";

export interface AuthedRequest extends Request {
  accountId?: string;
  authMethod?: "jwt" | "apiKey";
  isAdmin?: boolean;
  adminKeyId?: string;
  /** Set only for customer (non-admin) API key requests — lets a route
   *  check that specific key's own permissions (e.g. can_share_proof)
   *  without re-hashing the bearer token again. */
  apiKeyCanShareProof?: boolean;
  /** Set only on the JWT (browser dashboard) auth path — see
   *  resolveAccountForUser(). API keys and admin keys act as the account
   *  itself and never carry a role; requireRole() treats their absence of
   *  a role as "fully trusted", unchanged from pre-team-accounts behavior. */
  role?: "owner" | "member";
  /** Set only by requireJwtUser — see its own doc comment. */
  jwtUser?: { id: string; email: string };
}

export const API_KEY_PREFIX = "lzr_live_";
export const ADMIN_API_KEY_PREFIX = "lzr_admin_";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** API keys are looked up by their SHA-256 hash — the raw key is only ever
 *  shown once at creation (see api-keys.ts) and never stored. A key that
 *  doesn't start with API_KEY_PREFIX is never a real key, so that check
 *  lets a Supabase JWT (which never has this prefix) fall straight through
 *  to the JWT path below without wasting a DB round-trip. */
async function resolveApiKey(key: string): Promise<{ accountId: string; canShareProof: boolean } | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const keyHash = hashApiKey(key);
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, account_id, can_share_proof")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;
  // Best-effort — a failed timestamp update must never block the request
  // that's already been authenticated.
  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(({ error: updateError }) => {
      if (updateError) console.error("Failed to update api_keys.last_used_at:", updateError.message);
    });
  return { accountId: data.account_id, canShareProof: data.can_share_proof };
}

/** Admin keys are looked up from their own table, entirely separate from
 *  customer api_keys — a bug can never accidentally treat one as the
 *  other, since they're never queried from the same place. Returns the
 *  key's own id (for audit logging), not an account_id — an admin key
 *  isn't scoped to one account. */
async function resolveAdminKeyId(key: string): Promise<string | null> {
  if (!key.startsWith(ADMIN_API_KEY_PREFIX)) return null;
  const keyHash = hashApiKey(key);
  const { data, error } = await supabase
    .from("admin_api_keys")
    .select("id")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;
  supabase
    .from("admin_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(({ error: updateError }) => {
      if (updateError) console.error("Failed to update admin_api_keys.last_used_at:", updateError.message);
    });
  return data.id;
}

/** Best-effort audit trail for every admin-key request — never blocks or
 *  fails the real request, same fire-and-forget pattern as the
 *  last_used_at updates above. A key this powerful needs a real record of
 *  what it touched, which is the whole justification for it existing. */
function logAdminAction(adminKeyId: string, method: string, path: string, targetAccountId: string | null) {
  supabase
    .from("admin_audit_log")
    .insert({ admin_key_id: adminKeyId, method, path, target_account_id: targetAccountId })
    .then(({ error }) => {
      if (error) console.error("Failed to write admin_audit_log:", error.message);
    });
}

/** Header a pre-registered recurring job sends to identify itself, e.g.
 *  "lazyrelay-billing-ops-daily" — see admin_key_registered_jobs. */
const ADMIN_JOB_HEADER = "x-admin-job";

/** A valid, non-revoked admin key is no longer sufficient on its own to
 *  DO anything — see migration 0037_admin_key_guard.sql for the full
 *  reasoning. Two ways a request gets authorized:
 *    1. It names a pre-registered recurring job via the X-Admin-Job
 *       header (admin_key_registered_jobs) — allowed on its own schedule.
 *    2. There's an open, unconsumed "intent" window, opened by a real
 *       human Supabase session via POST /admin/announce (never by the
 *       admin key itself — a leaked key alone can never open its own
 *       window). The oldest open window is consumed by this request.
 *  Anything matching neither returns false — the caller must then revoke
 *  the key immediately.
 *
 *  *** If you're changing a scheduled task's name or adding a new one
 *  that needs the admin key, add/update its row in
 *  admin_key_registered_jobs FIRST, in the same change — otherwise its
 *  calls start failing with no obvious cause. *** */
async function authorizeAdminRequest(adminKeyId: string, jobHeader: unknown): Promise<boolean> {
  if (typeof jobHeader === "string" && jobHeader) {
    const { data } = await supabase
      .from("admin_key_registered_jobs")
      .select("job_name")
      .eq("job_name", jobHeader)
      .maybeSingle();
    if (data) return true;
  }

  const { data: intent } = await supabase
    .from("admin_key_intents")
    .select("id")
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("announced_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!intent) return false;

  const { error } = await supabase
    .from("admin_key_intents")
    .update({ consumed_at: new Date().toISOString(), admin_key_id: adminKeyId })
    .eq("id", intent.id)
    .is("consumed_at", null); // race guard: if two requests hit the same open window at once, only one wins it
  return !error;
}

/** Revokes an admin key immediately and records why — this is a hard
 *  await, not fire-and-forget, because the caller must not let the
 *  request through until the key is actually dead. */
async function revokeAdminKey(adminKeyId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from("admin_api_keys")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("id", adminKeyId);
  if (error) console.error("Failed to auto-revoke admin key:", error.message);
}

/** Agency tier v1 (see account_members, migration 0053): a person can be an
 *  accepted member of at most one account beyond their own — no
 *  account-switcher UI in v1. If they were invited into someone else's
 *  account, that membership wins over their own (auto-created, likely
 *  unused) self-owned account; solo customers who were never invited
 *  anywhere just resolve to themselves, identical to pre-v1 behavior.
 *  Returns null only if the user has literally no membership row, which
 *  should not happen post-migration (every account/signup gets one) but is
 *  handled as a hard failure rather than silently guessed at. */
async function resolveAccountForUser(userId: string): Promise<{ accountId: string; role: "owner" | "member" } | null> {
  const { data, error } = await supabase
    .from("account_members")
    .select("account_id, role")
    .eq("user_id", userId)
    .not("accepted_at", "is", null);
  if (error || !data || data.length === 0) return null;
  const preferred = data.find((m) => m.role === "member") ?? data[0];
  return { accountId: preferred.account_id, role: preferred.role as "owner" | "member" };
}

/** Verifies the caller's Supabase JWT (browser dashboard), a LazyRelay API
 *  key (bring-your-own-agent, headless), OR an admin key (Claude/internal
 *  ops, acts across every account) and attaches the account id to the
 *  request. Every route that touches customer data must use this — there
 *  is no "trust the request body" path for identifying who's calling,
 *  since that's exactly the kind of gap that turns into a real security
 *  incident (per the OAuth-token-storage research this whole schema is
 *  already built around). */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const token = authHeader.slice("Bearer ".length);

  const adminKeyId = await resolveAdminKeyId(token);
  if (adminKeyId) {
    const authorized = await authorizeAdminRequest(adminKeyId, req.headers[ADMIN_JOB_HEADER]);
    if (!authorized) {
      await revokeAdminKey(
        adminKeyId,
        "auto-revoked: used with no registered job header and no open human-approved intent window (possible key leak)"
      );
      res.status(403).json({
        error: "This admin key use was not authorized (no registered job, no approved window) and the key has been revoked.",
      });
      return;
    }

    req.isAdmin = true;
    req.adminKeyId = adminKeyId;
    req.authMethod = "apiKey";

    const targetAccountId = req.headers["x-account-id"];
    if (typeof targetAccountId === "string" && targetAccountId) {
      const { data: account } = await supabase.from("accounts").select("id").eq("id", targetAccountId).maybeSingle();
      if (!account) {
        res.status(400).json({ error: "X-Account-Id does not match a real account" });
        return;
      }
      req.accountId = targetAccountId;
    } else if (!req.path.startsWith("/admin")) {
      // Every non-admin-only route expects req.accountId to identify whose
      // data it's touching — an admin key must say explicitly which
      // account it's acting as, never silently default to one.
      res.status(400).json({ error: "This route requires an X-Account-Id header when using an admin key" });
      return;
    }

    logAdminAction(adminKeyId, req.method, req.path, req.accountId ?? null);
    next();
    return;
  }

  const apiKey = await resolveApiKey(token);
  if (apiKey) {
    req.accountId = apiKey.accountId;
    req.authMethod = "apiKey";
    req.apiKeyCanShareProof = apiKey.canShareProof;
    next();
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Rejects any Supabase JWT that isn't a real dashboard-login session —
  // most importantly, the MCP OAuth access tokens minted for the hosted
  // MCP server (see mcpAuth.ts), which carry aud=<the MCP resource URL>
  // instead of Supabase's default "authenticated". Those tokens are a
  // valid, signature-checked Supabase JWT for the real customer, so
  // without this check they'd resolve here exactly like a real login and
  // reach every requireAuth route — including ones requireHumanAuth alone
  // doesn't stop, since requireHumanAuth only blocks authMethod==="apiKey",
  // not a JWT of the wrong kind. mcpAuth.ts already enforces the mirror
  // image of this check (rejecting aud="authenticated" on the MCP side);
  // this is what makes it symmetric.
  if (data.user.aud !== "authenticated") {
    res.status(401).json({ error: "This token isn't a valid dashboard session." });
    return;
  }

  const membership = await resolveAccountForUser(data.user.id);
  if (!membership) {
    res.status(403).json({ error: "This account has no active membership. Contact support." });
    return;
  }

  req.accountId = membership.accountId;
  req.role = membership.role;
  req.authMethod = "jwt";
  next();
}

/** Mount AFTER requireAuth on any route restricted to admin keys — the
 *  cross-account routes (list every account, etc.) that no per-tenant JWT
 *  or customer API key should ever be able to reach. */
export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.isAdmin) {
    res.status(403).json({ error: "This endpoint requires an admin key" });
    return;
  }
  next();
}

/** Narrower than requireAuth on purpose: the AI support widget must keep
 *  working for signed-out marketing-site visitors, so a missing/invalid
 *  token here is a normal case, not an error worth a 401. Only ever
 *  resolves a real Supabase JWT (a logged-in dashboard session) -- no API
 *  key or admin key path, since a customer's own browser session is the
 *  only case a chat widget should ever act on. Returns the verified
 *  account id, or null for anonymous. Never throws. */
export async function resolveOptionalAccountId(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

/** Used only by POST /team/accept-invite. That route can't use requireAuth's
 *  normal resolution: a person accepting their FIRST invite has no
 *  account_members row for it yet, and accepting is the very act that
 *  creates one — resolveAccountForUser would either 404 (no membership at
 *  all is impossible post-migration, but illustrates the chicken-and-egg
 *  problem) or, worse, silently resolve to an unrelated existing
 *  membership. This bypasses account resolution entirely and returns the
 *  raw Supabase auth identity, which is what "who is accepting" actually
 *  means here. Human/browser session only, same as resolveOptionalAccountId,
 *  and for the same reason (no API key or admin key should ever accept a
 *  team invite on someone's behalf). */
export async function requireJwtUser(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const token = authHeader.slice("Bearer ".length);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user || !data.user.email) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  req.jwtUser = { id: data.user.id, email: data.user.email };
  next();
}

/** Mount AFTER requireAuth on routes that only the account owner should
 *  reach — billing, webhook secrets, API key minting, team management
 *  itself. API keys and admin keys never carry req.role (they act as the
 *  account itself, same as before agency accounts existed) so they pass
 *  through unchanged; only a JWT-authed team member without the owner
 *  role is actually blocked here. Mount AFTER requireAuth. */
export function requireOwner(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.authMethod === "jwt" && req.role !== "owner") {
    res.status(403).json({ error: "Only the account owner can do this." });
    return;
  }
  next();
}

/** Mount AFTER requireAuth on any route that must never be reachable with
 *  an API key — right now that's just managing API keys themselves, so a
 *  leaked/compromised key can never be used to mint new keys or revoke the
 *  legitimate ones and lock the real owner out. */
export function requireHumanAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.authMethod === "apiKey") {
    res.status(403).json({ error: "This endpoint requires signing in with your account, not an API key" });
    return;
  }
  next();
}
