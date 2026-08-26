import { Router, type Response } from "express";
import { randomInt } from "node:crypto";
import { supabase } from "../supabase.js";
import { requireAuth, requireHumanAuth, requireJwtUser, hashApiKey, type AuthedRequest } from "./auth.js";
import { tieredRateLimit, mfaRecoveryRedeemRateLimit } from "./rateLimit.js";
import { recordSecurityEvent } from "./securityAlerts.js";

// MFA recovery codes (2026-08-26) -- the missing piece under tonight's
// earlier optional-TOTP-MFA ship (commit f9118f4). Supabase's own MFA has no
// backup-code mechanism, so without this, losing the authenticator app is a
// permanent lockout at MfaChallenge.tsx. Kept as its own file rather than
// folded into routes.ts's already-4700-line buildRouter(): this is a
// distinct concern (account-recovery, not a CRUD resource) and its own
// router keeps the one deliberately-weaker-auth endpoint in the whole API
// (the redeem route below) easy to find and audit in isolation.

// Same logging discipline as routes.ts's own dbError -- a Postgres error's
// raw message can name internal detail (constraint/column names) that
// shouldn't reach the client; log the real thing, return a generic one.
function dbError(res: Response, err: { message: string }, context: string): void {
  console.error(`[mfaRecovery] ${context}:`, err.message);
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
}

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_COUNT = 10;

/** "XXXX-XXXX", uppercase alphanumeric, crypto-random (randomInt avoids the
 *  modulo bias Math.random()/naive `% alphabet.length` would introduce). */
function generateRecoveryCode(): string {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Forgiving of how the customer types it back in (stray spaces, missing or
 *  misplaced dash, lowercase) -- strips everything but letters/digits,
 *  uppercases, and re-inserts the dash at the position generateRecoveryCode()
 *  always puts it, so the hash comparison below matches what was stored.
 *  Returns null for anything that can't possibly be one of these codes. */
function normalizeCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

export function buildMfaRecoveryRouter(): Router {
  const router = Router();

  // Generates a fresh set of 10 codes, deleting any existing ones first --
  // regenerating invalidates the old set (standard practice, and prevents
  // unbounded accumulation from someone hitting "regenerate" repeatedly).
  // requireHumanAuth: never reachable with an API key, same reasoning as
  // API-key management itself -- a leaked key must never be able to mint a
  // way to strip its own owner's second factor. requireJwtUser (mounted
  // after requireAuth/requireHumanAuth, so the API-key/admin-key paths are
  // already rejected) is what actually resolves the real auth.users id these
  // codes are stored against -- req.accountId from requireAuth is the
  // LazyRelay account, which can be shared by multiple team members each
  // with their own independent MFA factor, so it's the wrong id to key on
  // here.
  router.post(
    "/mfa/recovery-codes/generate",
    requireAuth,
    requireHumanAuth,
    requireJwtUser,
    tieredRateLimit,
    async (req: AuthedRequest, res) => {
      const userId = req.jwtUser!.id;

      const codes = Array.from({ length: CODE_COUNT }, generateRecoveryCode);
      const rows = codes.map((code) => ({ user_id: userId, code_hash: hashApiKey(code) }));

      const { error: deleteError } = await supabase.from("mfa_recovery_codes").delete().eq("user_id", userId);
      if (deleteError) {
        dbError(res, deleteError, "POST /mfa/recovery-codes/generate (delete existing)");
        return;
      }
      const { error: insertError } = await supabase.from("mfa_recovery_codes").insert(rows);
      if (insertError) {
        dbError(res, insertError, "POST /mfa/recovery-codes/generate (insert)");
        return;
      }

      // The only time these are ever returned in plaintext -- never stored,
      // never retrievable again, same one-time-reveal principle as a fresh
      // API key (see POST /api-keys in routes.ts).
      res.json({ codes });
    },
  );

  // Reached from MfaChallenge.tsx by someone who is signed in (has a valid
  // Supabase session/JWT) but stuck below aal2 because they've lost their
  // authenticator -- exactly the state requireAuth's normal JWT path can't
  // help with, since resolveAccountForUser doesn't care about AAL but every
  // *other* route gated by the App.tsx Root() AAL check is unreachable from
  // here regardless. So this deliberately does its own bearer-token
  // verification (supabase.auth.getUser(token), any AAL) instead of using
  // requireAuth, and never trusts a userId from the request body/query --
  // only ever from the verified token below. Heavily rate-limited
  // (mfaRecoveryRedeemRateLimit, IP-keyed, 10/15min) since this is the one
  // endpoint in the API where a valid session token plus a guessed code is
  // enough to remove someone's second factor.
  router.post("/mfa/recovery-codes/redeem", mfaRecoveryRedeemRateLimit, async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }
    const token = authHeader.slice("Bearer ".length);
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    const userId = userData.user.id;

    const { code } = req.body ?? {};
    const normalized = typeof code === "string" ? normalizeCode(code) : null;
    if (!normalized) {
      res.status(400).json({ error: "Invalid or already-used code" });
      return;
    }
    const codeHash = hashApiKey(normalized);

    // Single-use, high-entropy codes, not passwords -- a plain hash-equality
    // lookup (same as api_keys' own key_hash lookup in auth.ts) is the right
    // amount of engineering here, not a constant-time comparison.
    const { data: matches, error: lookupError } = await supabase
      .from("mfa_recovery_codes")
      .select("id")
      .eq("user_id", userId)
      .eq("code_hash", codeHash)
      .is("used_at", null)
      .limit(1);
    if (lookupError) {
      dbError(res, lookupError, "POST /mfa/recovery-codes/redeem (lookup)");
      return;
    }
    const match = matches?.[0];
    if (!match) {
      // Generic on purpose -- no distinction between "wrong code",
      // "already used", or "never existed" that could leak information to
      // whoever's guessing.
      res.status(400).json({ error: "Invalid or already-used code" });
      return;
    }

    const { error: markUsedError } = await supabase
      .from("mfa_recovery_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", match.id);
    if (markUsedError) {
      dbError(res, markUsedError, "POST /mfa/recovery-codes/redeem (mark used)");
      return;
    }

    const { data: factorsData, error: factorsError } = await supabase.auth.admin.mfa.listFactors({ userId });
    if (factorsError) {
      dbError(res, factorsError, "POST /mfa/recovery-codes/redeem (listFactors)");
      return;
    }
    const totpFactor = factorsData.factors.find((f) => f.factor_type === "totp" && f.status === "verified");
    if (totpFactor) {
      // Per its own doc comment, this logs the user out of every active
      // session if the deleted factor was verified -- which it is here, so
      // the frontend's redeem flow must show a "please sign in again"
      // message and route back to login rather than trying to seamlessly
      // continue, exactly like a normal password-change-invalidates-sessions
      // flow.
      const { error: deleteFactorError } = await supabase.auth.admin.mfa.deleteFactor({ id: totpFactor.id, userId });
      if (deleteFactorError) {
        dbError(res, deleteFactorError, "POST /mfa/recovery-codes/redeem (deleteFactor)");
        return;
      }
    }

    // The factor is gone (or already was) -- any codes left over are dead
    // weight, not a lingering way back in for whoever still has them.
    const { error: cleanupError } = await supabase.from("mfa_recovery_codes").delete().eq("user_id", userId);
    if (cleanupError) console.error("[mfaRecovery] POST /mfa/recovery-codes/redeem (cleanup):", cleanupError.message);

    recordSecurityEvent("mfa_recovery_used", `user ${userId} redeemed an MFA recovery code`);

    res.json({ recovered: true });
  });

  return router;
}
