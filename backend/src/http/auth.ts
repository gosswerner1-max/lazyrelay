import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { supabase } from "../supabase.js";

export interface AuthedRequest extends Request {
  accountId?: string;
  authMethod?: "jwt" | "apiKey";
}

export const API_KEY_PREFIX = "lzr_live_";

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

/** Verifies the caller's Supabase JWT (browser dashboard) OR a LazyRelay
 *  API key (bring-your-own-agent, headless) and attaches the account id to
 *  the request. Every route that touches customer data must use this —
 *  there is no "trust the request body" path for identifying who's
 *  calling, since that's exactly the kind of gap that turns into a real
 *  security incident (per the OAuth-token-storage research this whole
 *  schema is already built around). */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const token = authHeader.slice("Bearer ".length);

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
