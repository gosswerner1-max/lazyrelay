// Connecting X with the customer's OWN developer keys (OAuth 1.0a, "bring your own key"). Mounted by
// socialAccounts.routes.ts. There is no sign-in redirect: the customer pastes four values, this route proves them with
// one signed GET /2/users/me, and stores them as ONE JSON string in Vault through store_social_token.
//
// What this route is careful about (the four values give full control of the customer's X handle):
//   - Signed-in HUMAN only (an API key is refused), on a plan that includes it (canUseXByok), and only while the
//     feature is switched on for this account. Checked in that order of cheapness, flag first so a switched-off
//     feature looks exactly like it does everywhere else.
//   - Its own 4 KB JSON parser and a parse-error handler that never logs or echoes the body.
//   - Strict rate limits (a stolen-key checking oracle is the main abuse): 5 tries per 15 minutes per account and per
//     IP, plus a daily cap on keys X rejected.
//   - Vault through the service-role client ONLY. Never req.db (its role cannot, and must not, read Vault).
//   - Fixed error strings. No submitted value, no X response body and no thrown error text ever reaches a response
//     or a log line.
//   - Response is { ok, handle, keyHint } and nothing else.

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { supabase } from "../../supabase.js";
import { checkAccountLimit, checkNewDistinctAccountLimit, isXByokPlanGateError } from "../../accountLimits.js";
import { resolveTier, canUseXByok, X_BYOK_REQUIRED_PLAN_NAME } from "../../tier.js";
import { wipeVaultSecrets } from "../../tokenWipe.js";
import { validateBody } from "../validation.js";
import type { PlatformAdapterRegistry } from "../../platforms/connect.js";
import { XAdapter } from "../../platforms/x.js";
import { serializeXBundle, xKeyHint, X_KEY_MAX_LENGTH, X_KEY_MIN_LENGTH, X_KEY_PATTERN, type XByokBundle } from "../../platforms/xByok.js";

export const X_BYOK_PLAN_MESSAGE = `Connecting X with your own developer keys is available on the ${X_BYOK_REQUIRED_PLAN_NAME} plan and above.`;
const NOT_AVAILABLE = "x isn't available to connect yet.";
const SAVE_FAILED = "Could not save your keys. Please try again.";

export const X_BYOK_FAILED_VALIDATIONS_PER_DAY = 15;
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX = 5;

/** Max 4 KB, with an error handler that answers a fixed line: body-parser's own error carries the raw body, which
 *  here is four secrets, and app.ts's catch-all would log it. */
export const xByokJsonParser = [
  express.json({ limit: "4kb" }),
  (_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: "That request could not be read. Check the four keys and try again." });
  },
];

const keyField = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(X_KEY_MIN_LENGTH, `${label} looks too short`)
    .max(X_KEY_MAX_LENGTH, `${label} looks too long`)
    .regex(X_KEY_PATTERN, `${label} should only contain letters, numbers, dashes and underscores (no spaces)`);

const keysShape = {
  apiKey: keyField("API Key"),
  apiSecret: keyField("API Secret"),
  accessToken: keyField("Access Token"),
  accessTokenSecret: keyField("Access Token Secret"),
};
const checkSchema = z.object(keysShape);
const connectSchema = z.object({
  ...keysShape,
  acceptedTerms: z.literal(true, { error: "You need to tick the box to accept the terms before connecting" }),
});

const REASON_RESPONSE: Record<string, { status: number; error: string }> = {
  invalid: { status: 400, error: "X did not accept these keys. Check you copied the API Key/Secret and the Access Token/Secret." },
  forbidden: { status: 400, error: "X accepted the request but refused it. Check the app has Read and Write permission, then regenerate the Access Token and paste it again." },
  out_of_credit: { status: 400, error: "X says your developer account has no credits or hit its spending limit. Add credits in the X Developer Console and try again." },
  rate_limited: { status: 429, error: "X is limiting requests right now. Wait a few minutes and try again." },
  unreachable: { status: 502, error: "Could not reach X. Try again in a moment." },
};

export function registerXByokRoutes(
  router: Router,
  registry: PlatformAdapterRegistry,
  canSee: (platform: string, accountId: string | undefined) => boolean,
  /** Tests only: raise the per-window limit to reach the daily cap. */
  opts: { rateMax?: number } = {},
): void {
  const tooMany = (_req: Request, res: Response) => {
    res.status(429).json({ error: "Too many attempts. Wait a few minutes before trying your keys again." });
  };
  // Per account and per IP, created per router so each has its own counters.
  const perAccount = rateLimit({
    windowMs: RATE_WINDOW_MS,
    max: opts.rateMax ?? RATE_MAX,
    keyGenerator: (req: Request) => (req as AuthedRequest).accountId ?? "unknown",
    standardHeaders: false,
    legacyHeaders: false,
    handler: tooMany,
    validate: false,
  });
  const perIp = rateLimit({ windowMs: RATE_WINDOW_MS, max: opts.rateMax ?? RATE_MAX, standardHeaders: false, legacyHeaders: false, handler: tooMany, validate: false });

  // Keys X rejected, per account per UTC day. In memory like the other abuse limiters: a deploy resetting it early is
  // a small, accepted gap behind the two limits above.
  const failedToday = new Map<string, { day: string; count: number }>();
  const today = () => new Date().toISOString().slice(0, 10);
  const failedCount = (accountId: string): number => {
    const e = failedToday.get(accountId);
    return e && e.day === today() ? e.count : 0;
  };
  const recordFailed = (accountId: string): void => {
    failedToday.set(accountId, { day: today(), count: failedCount(accountId) + 1 });
  };

  // lazy, so a test double of auth.js that only offers requireAuth still lets the router be built
  const humanOnly = (req: AuthedRequest, res: Response, next: NextFunction) => requireHumanAuth(req, res, next);

  /** Flag, plan, then the adapter. Answers and returns null when the caller may not proceed. */
  async function gate(req: AuthedRequest, res: Response): Promise<XAdapter | null> {
    const adapter = registry.get("x");
    if (!(adapter instanceof XAdapter) || !canSee("x", req.accountId)) {
      res.status(400).json({ error: NOT_AVAILABLE });
      return null;
    }
    let allowed = false;
    try {
      allowed = canUseXByok(await resolveTier(req.accountId!));
    } catch {
      allowed = false;
    }
    if (!allowed) {
      res.status(403).json({ error: X_BYOK_PLAN_MESSAGE, requiresPlan: X_BYOK_REQUIRED_PLAN_NAME });
      return null;
    }
    return adapter;
  }

  /** Proves the four values with X. Answers and returns null on any refusal. */
  async function prove(adapter: XAdapter, bundle: XByokBundle, req: AuthedRequest, res: Response) {
    if (failedCount(req.accountId!) >= X_BYOK_FAILED_VALIDATIONS_PER_DAY) {
      res.status(429).json({ error: "Too many keys were rejected today. Try again tomorrow." });
      return null;
    }
    const check = await adapter.verifyKeys(bundle);
    if (!check.ok) {
      if (check.reason !== "unreachable" && check.reason !== "rate_limited") recordFailed(req.accountId!);
      const r = REASON_RESPONSE[check.reason] ?? REASON_RESPONSE.invalid;
      res.status(r.status).json({ error: r.error });
      return null;
    }
    return check;
  }

  const chain = [requireAuth, humanOnly, tieredRateLimit, perIp, perAccount, ...xByokJsonParser];

  // "Check my keys": proves the keys and shows the handle, stores NOTHING (no Vault write, no row).
  router.post("/social-accounts/x/byok/check", ...chain, async (req: AuthedRequest, res: Response) => {
    const adapter = await gate(req, res);
    if (!adapter) return;
    const body = validateBody(checkSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const check = await prove(adapter, body.data, req, res);
    if (!check) return;
    res.json({ ok: true, handle: check.username, keyHint: xKeyHint(body.data.apiKey) });
  });

  // "Save and connect": the same proof, then the Vault write and the connection row.
  router.post("/social-accounts/x/byok", ...chain, async (req: AuthedRequest, res: Response) => {
    const adapter = await gate(req, res);
    if (!adapter) return;
    const body = validateBody(connectSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { acceptedTerms: _accepted, ...bundle } = body.data;
    const check = await prove(adapter, bundle, req, res);
    if (!check) return;

    const accountId = req.accountId!;
    const keyHint = xKeyHint(bundle.apiKey);
    let newVaultId: string | null = null;
    let blockedByDatabase = false;
    try {
      // Rotating the keys of a connection we already have (same X account) updates its Vault secret in place; a new
      // account is checked against the plan's limits first, exactly like every other connect.
      const { data: existing, error: lookupError } = await supabase
        .from("social_accounts")
        .select("id, access_token_vault_id, disconnected_at")
        .eq("account_id", accountId)
        .eq("platform", "x")
        .eq("platform_account_id", check.id)
        .maybeSingle();
      if (lookupError) throw new Error("lookup");

      if (!existing || existing.disconnected_at) {
        const limitError = await checkAccountLimit(accountId);
        if (limitError) {
          res.status(403).json({ error: limitError });
          return;
        }
      }
      if (!existing) {
        const distinctError = await checkNewDistinctAccountLimit(accountId);
        if (distinctError) {
          res.status(403).json({ error: distinctError });
          return;
        }
      }

      const login = serializeXBundle(bundle);
      let vaultId: string;
      if (existing) {
        const { error } = await supabase.rpc("update_social_token", { p_vault_id: existing.access_token_vault_id, p_new_token: login });
        if (error) throw new Error("vault");
        vaultId = existing.access_token_vault_id as string;
      } else {
        const { data, error } = await supabase.rpc("store_social_token", { p_token: login });
        if (error || !data) throw new Error("vault");
        vaultId = data as string;
        newVaultId = vaultId;
      }

      const { error: upsertError } = await supabase.from("social_accounts").upsert(
        {
          account_id: accountId,
          platform: "x",
          platform_account_id: check.id,
          display_name: check.username,
          access_token_vault_id: vaultId,
          refresh_token_vault_id: null,
          token_expires_at: null,
          disconnected_at: null,
          tokens_wiped_at: null,
          needs_reconnect_at: null,
          needs_reconnect_reason: null,
          reconnect_notified_at: null,
          credential_mode: "byok",
          byok_status: "valid",
          byok_validated_at: new Date().toISOString(),
          byok_key_hint: keyHint,
        },
        { onConflict: "account_id,platform,platform_account_id" },
      );
      if (upsertError) {
        // The database plan gate (migration 0126) is the backstop behind canUseXByok: if it refuses the row, answer the
        // same fixed plan message and status as the route's own gate (403), not a 500.
        blockedByDatabase = isXByokPlanGateError(upsertError);
        throw new Error("save");
      }
    } catch {
      // A secret stored for a row that was never saved would sit in Vault for good: overwrite it.
      if (newVaultId) await wipeVaultSecrets(supabase, [newVaultId]);
      if (blockedByDatabase) {
        res.status(403).json({ error: X_BYOK_PLAN_MESSAGE, requiresPlan: X_BYOK_REQUIRED_PLAN_NAME });
        return;
      }
      console.error("[x-byok] saving a connection failed (details withheld: they can hold key material)");
      res.status(500).json({ error: SAVE_FAILED });
      return;
    }
    res.json({ ok: true, handle: check.username, keyHint });
  });
}
