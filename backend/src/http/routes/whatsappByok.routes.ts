// Connecting WhatsApp with the customer's OWN Meta WhatsApp Business credentials ("bring your own key"). Mounted by
// socialAccounts.routes.ts. There is no sign-in redirect: the customer pastes their WhatsApp Business Account id, the
// phone number id and a long-lived system user token; this route proves them with Meta, encrypts the token into Supabase
// Vault through store_social_token and saves a connection row. Meta then bills the customer directly.
//
// Same care as the X "own keys" route (xByok.routes.ts), because the token gives full control of the customer's
// WhatsApp Business number:
//   - Signed-in HUMAN only (an API key is refused), on a plan that includes it (Business and above, checkWhatsappPlan,
//     answered with HTTP 400), and only while the feature is switched on for this account. Flag first, so a switched-off
//     feature looks exactly like it does everywhere else.
//   - Its own 4 KB JSON parser and a parse-error handler that never logs or echoes the body.
//   - Strict rate limits (a stolen-token checking oracle is the main abuse): 5 tries per 15 minutes per account and per
//     IP, plus a daily cap on credentials Meta rejected.
//   - Vault through the service-role client ONLY. Never req.db (its role cannot, and must not, read Vault).
//   - Fixed error strings. No submitted value, no Meta response body and no thrown error text ever reaches a response
//     or a log line.
//   - Response is { ok, displayName, keyHint } and nothing else. The token is never returned, never stored in a column
//     and never selected back.
//   - The optional App Secret (the customer's own Meta app, which signs inbound webhook deliveries) is handled exactly like
//     the token: it travels inside the same Vault string, is never echoed, logged, put in an error or stored in a column,
//     and is wiped with the token on disconnect. Saving a new one overwrites the old. Re-saving the login WITHOUT one keeps
//     the secret already stored for that same connection, so rotating the token never silently switches inbound off.
//     The one way to remove a stored secret is an explicit `clearAppSecret: true` on the save request (refused together
//     with an appSecret); the response is unchanged and says nothing about the secret.

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { supabase } from "../../supabase.js";
import { checkAccountLimit, checkNewDistinctAccountLimit, checkWhatsappPlan, isWhatsappPlanGateError, WHATSAPP_PLAN_MESSAGE } from "../../accountLimits.js";
import { WHATSAPP_BYOK_REQUIRED_PLAN_NAME } from "../../tier.js";
import { wipeVaultSecrets } from "../../tokenWipe.js";
import { validateBody } from "../validation.js";
import type { PlatformAdapterRegistry } from "../../platforms/connect.js";
import { WhatsAppAdapter } from "../../platforms/whatsapp/adapter.js";
import {
  META_ID_PATTERN,
  parseWhatsAppBundle,
  serializeWhatsAppBundle,
  whatsappKeyHint,
  WHATSAPP_APP_SECRET_PATTERN,
  WHATSAPP_TOKEN_MAX_LENGTH,
  WHATSAPP_TOKEN_MIN_LENGTH,
  WHATSAPP_TOKEN_PATTERN,
  type WhatsAppBundle,
} from "../../platforms/whatsapp/credentials.js";

const NOT_AVAILABLE = "whatsapp isn't available to connect yet.";
const SAVE_FAILED = "Could not save your WhatsApp credentials. Please try again.";

export const WHATSAPP_BYOK_FAILED_VALIDATIONS_PER_DAY = 15;
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX = 5;

/** Max 4 KB, with an error handler that answers a fixed line: body-parser's own error carries the raw body, which here
 *  holds a token, and app.ts's catch-all would log it. */
export const whatsappByokJsonParser = [
  express.json({ limit: "4kb" }),
  (_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: "That request could not be read. Check the three WhatsApp values and try again." });
  },
];

const idField = (label: string) =>
  z.string({ error: `${label} is required` }).trim().regex(META_ID_PATTERN, `${label} should be the numeric ID from Meta (digits only, no spaces)`);

// OPTIONAL: the App Secret of the customer's own Meta app, used to verify the signature on inbound webhook deliveries.
// A blank field counts as not given. The message never repeats what was typed.
const appSecretField = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || WHATSAPP_APP_SECRET_PATTERN.test(v), "App Secret should be the letters and numbers Meta shows for your app (16 to 64 characters, no spaces)");

const credentialsShape = {
  wabaId: idField("WhatsApp Business Account ID"),
  phoneNumberId: idField("Phone number ID"),
  systemUserToken: z
    .string({ error: "System user token is required" })
    .trim()
    .min(WHATSAPP_TOKEN_MIN_LENGTH, "System user token looks too short")
    .max(WHATSAPP_TOKEN_MAX_LENGTH, "System user token looks too long")
    .regex(WHATSAPP_TOKEN_PATTERN, "System user token should only contain letters, numbers, dots, dashes and underscores (no spaces)"),
  appSecret: appSecretField,
};
const checkSchema = z.object(credentialsShape);
const connectSchema = z
  .object({
    ...credentialsShape,
    acceptedTerms: z.literal(true, { error: "You need to tick the box to accept the terms before connecting" }),
    // OPTIONAL, save only: true removes the App Secret already stored for this connection (inbound goes off). Anything
    // but the boolean true is refused, so it can never be set by accident.
    clearAppSecret: z.literal(true, { error: "clearAppSecret can only be true" }).optional(),
  })
  .refine((v) => !(v.clearAppSecret && v.appSecret), { message: "Send either a new App Secret or clearAppSecret, not both", path: ["clearAppSecret"] });

const REASON_RESPONSE: Record<string, { status: number; error: string }> = {
  invalid: { status: 400, error: "Meta did not accept this token. Check you copied the whole system user token, and that it has not expired or been revoked." },
  forbidden: { status: 400, error: "Meta accepted the token but refused the request. Check the system user has access to this WhatsApp Business Account and the whatsapp_business_management and whatsapp_business_messaging permissions." },
  not_found: { status: 400, error: "Meta could not find that phone number in that WhatsApp Business Account. Check both IDs and that the number belongs to this account." },
  rate_limited: { status: 429, error: "Meta is limiting requests right now. Wait a few minutes and try again." },
  unreachable: { status: 502, error: "Could not reach Meta. Try again in a moment." },
};

export function registerWhatsAppByokRoutes(
  router: Router,
  registry: PlatformAdapterRegistry,
  canSee: (platform: string, accountId: string | undefined) => boolean,
  /** Tests only: raise the per-window limit to reach the daily cap. */
  opts: { rateMax?: number } = {},
): void {
  const tooMany = (_req: Request, res: Response) => {
    res.status(429).json({ error: "Too many attempts. Wait a few minutes before trying your credentials again." });
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

  // Credentials Meta rejected, per account per UTC day. In memory like the other abuse limiters: a deploy resetting it
  // early is a small, accepted gap behind the two limits above.
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

  /** Flag, then plan, then the adapter. Answers and returns null when the caller may not proceed. */
  async function gate(req: AuthedRequest, res: Response): Promise<WhatsAppAdapter | null> {
    const adapter = registry.get("whatsapp");
    if (!(adapter instanceof WhatsAppAdapter) || !canSee("whatsapp", req.accountId)) {
      res.status(400).json({ error: NOT_AVAILABLE });
      return null;
    }
    const planError = await checkWhatsappPlan(req.accountId!);
    if (planError) {
      // HTTP 400, as specified for this feature (the X route answers 403; the body shape is the same).
      res.status(400).json({ error: planError, requiresPlan: WHATSAPP_BYOK_REQUIRED_PLAN_NAME });
      return null;
    }
    return adapter;
  }

  /** Proves the three values with Meta. Answers and returns null on any refusal. */
  async function prove(adapter: WhatsAppAdapter, bundle: WhatsAppBundle, req: AuthedRequest, res: Response) {
    if (failedCount(req.accountId!) >= WHATSAPP_BYOK_FAILED_VALIDATIONS_PER_DAY) {
      res.status(429).json({ error: "Too many credentials were rejected today. Try again tomorrow." });
      return null;
    }
    const check = await adapter.verifyCredentials(bundle);
    if (!check.ok) {
      if (check.reason !== "unreachable" && check.reason !== "rate_limited") recordFailed(req.accountId!);
      const r = REASON_RESPONSE[check.reason] ?? REASON_RESPONSE.invalid;
      res.status(r.status).json({ error: r.error });
      return null;
    }
    return check;
  }

  const chain = [requireAuth, humanOnly, tieredRateLimit, perIp, perAccount, ...whatsappByokJsonParser];

  // "Check my credentials": proves them and shows the verified name, stores NOTHING (no Vault write, no row).
  router.post("/social-accounts/whatsapp/byok/check", ...chain, async (req: AuthedRequest, res: Response) => {
    const adapter = await gate(req, res);
    if (!adapter) return;
    const body = validateBody(checkSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const check = await prove(adapter, body.data, req, res);
    if (!check) return;
    res.json({ ok: true, displayName: check.verifiedName ?? check.displayPhoneNumber, keyHint: whatsappKeyHint(body.data.phoneNumberId) });
  });

  // "Save and connect": the same proof, then the Vault write and the connection row.
  router.post("/social-accounts/whatsapp/byok", ...chain, async (req: AuthedRequest, res: Response) => {
    const adapter = await gate(req, res);
    if (!adapter) return;
    const body = validateBody(connectSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { acceptedTerms: _accepted, clearAppSecret, ...bundle } = body.data;
    const check = await prove(adapter, bundle, req, res);
    if (!check) return;

    const accountId = req.accountId!;
    const keyHint = whatsappKeyHint(bundle.phoneNumberId);
    const displayName = check.verifiedName ?? check.displayPhoneNumber ?? `WhatsApp ${keyHint}`;
    let newVaultId: string | null = null;
    let blockedByDatabase = false;
    try {
      // Rotating the token of a connection we already have (same phone number) updates its Vault secret in place; a new
      // number is checked against the plan's limits first, exactly like every other connect.
      const { data: existing, error: lookupError } = await supabase
        .from("social_accounts")
        .select("id, access_token_vault_id, disconnected_at")
        .eq("account_id", accountId)
        .eq("platform", "whatsapp")
        .eq("platform_account_id", bundle.phoneNumberId)
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

      // The ONLY place the token is written: into Vault, encrypted at rest, as part of the stored login. The returned
      // value is an opaque uuid that the row keeps; no token column exists.
      let toStore: WhatsAppBundle = bundle;
      if (existing && !bundle.appSecret && !clearAppSecret && existing.access_token_vault_id && !existing.disconnected_at) {
        // Keep the secret already on file for this same connection when the customer only rotates the token.
        const { data: previous } = await supabase.rpc("read_social_token", { p_vault_id: existing.access_token_vault_id });
        const kept = parseWhatsAppBundle(typeof previous === "string" ? previous : null)?.appSecret;
        if (kept) toStore = { ...bundle, appSecret: kept };
      }
      const login = serializeWhatsAppBundle(toStore);
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
          platform: "whatsapp",
          platform_account_id: bundle.phoneNumberId,
          display_name: displayName,
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
          whatsapp_business_account_id: bundle.wabaId,
          whatsapp_phone_number_id: bundle.phoneNumberId,
        },
        { onConflict: "account_id,platform,platform_account_id" },
      );
      if (upsertError) {
        // The database plan gate (migration 0125) is the backstop behind checkWhatsappPlan: if it refuses the row,
        // answer the same fixed plan message as the route's own gate (HTTP 400), not a 500.
        blockedByDatabase = isWhatsappPlanGateError(upsertError);
        throw new Error("save");
      }
    } catch {
      // A secret stored for a row that was never saved would sit in Vault for good: overwrite it.
      if (newVaultId) await wipeVaultSecrets(supabase, [newVaultId]);
      if (blockedByDatabase) {
        res.status(400).json({ error: WHATSAPP_PLAN_MESSAGE, requiresPlan: WHATSAPP_BYOK_REQUIRED_PLAN_NAME });
        return;
      }
      console.error("[whatsapp-byok] saving a connection failed (details withheld: they can hold credential material)");
      res.status(500).json({ error: SAVE_FAILED });
      return;
    }
    res.json({ ok: true, displayName, keyHint });
  });
}
