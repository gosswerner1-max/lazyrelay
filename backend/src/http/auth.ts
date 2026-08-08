import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { supabase } from "../supabase.js";

export interface AuthedRequest extends Request {
  accountId?: string;
  authMethod?: "jwt" | "apiKey";
  isAdmin?: boolean;
  adminKeyId?: string;
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
async function resolveApiKeyAccountId(key: string): Promise<string | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const keyHash = hashApiKey(key);
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, account_id")
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
  return data.account_id;
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

  const apiKeyAccountId = await resolveApiKeyAccountId(token);
  if (apiKeyAccountId) {
    req.accountId = apiKeyAccountId;
    req.authMethod = "apiKey";
    next();
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.accountId = data.user.id;
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
