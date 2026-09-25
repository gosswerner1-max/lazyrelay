// account routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { supabase } from "../../supabase.js";
import { requireAuth, requireHumanAuth, requireOwner, type AuthedRequest, API_KEY_PREFIX, hashApiKey } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { generateWebhookSecret } from "../../webhook.js";
import { isSafeMediaUrl } from "../../urlSafety.js";
import { dbError, MAX_VOICE_PROFILE_LENGTH, isReservedBusinessName } from "./shared.js";
import { validateBody, nonEmptyString, optionalNullableString, optionalBoolean, unvalidated } from "../validation.js";

export function buildAccountRouter(): Router {
  const router = Router();

  // The dashboard's "Welcome, {name}" header and the business-name field
  // shown at signup — set once at signup via Supabase auth metadata (see
  // migration 0024), editable afterward here.
  router.get("/account", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("accounts")
      .select("email, business_name, email_failure_alerts_enabled, webhook_url, webhook_secret, voice_profile")
      .eq("id", req.accountId)
      .single();
    if (error || !data) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json({
      email: data.email,
      businessName: data.business_name,
      emailFailureAlertsEnabled: data.email_failure_alerts_enabled,
      webhookUrl: data.webhook_url,
      // Never the raw secret here — only whether one exists, so it isn't
      // repeated in every account fetch. Revealed once on the request that
      // sets/creates it, or via POST /account/webhook/regenerate-secret.
      webhookConfigured: !!data.webhook_secret,
      // Default AI-caption/hashtag voice (migration 0061) — overridden per
      // brand when the account being posted from belongs to one with its
      // own voice_profile set; see resolveVoiceProfile in the /ai/* routes.
      voiceProfile: data.voice_profile,
    });
  });

  // Split in two because the business-name rules (line breaks, reserved
  // names) sit between these groups in the check order and have to keep
  // running at that exact point — see the header of http/validation.ts.
  const accountProfileBodySchema = z.object({
    businessName: z
      .string({ error: "businessName must be a string or null" })
      .max(80, "businessName must be 80 characters or fewer")
      .nullish(),
    voiceProfile: z
      .string({ error: "voiceProfile must be a string or null" })
      .max(MAX_VOICE_PROFILE_LENGTH, `voiceProfile must be ${MAX_VOICE_PROFILE_LENGTH} characters or fewer`)
      .nullish(),
  });
  const accountSettingsBodySchema = z.object({
    emailFailureAlertsEnabled: optionalBoolean("emailFailureAlertsEnabled must be a boolean"),
    webhookUrl: optionalNullableString("webhookUrl must be a string or null"),
  });
  router.patch("/account", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const profile = validateBody(accountProfileBodySchema, req.body);
    if (!profile.ok) {
      res.status(400).json({ error: profile.error });
      return;
    }
    const { businessName, voiceProfile } = profile.data;
    // businessName becomes the inviter label in a team-invite email subject
    // (email.ts's sendTeamInviteEmail) — stripping newlines here is cheap
    // defense-in-depth against header injection if the Resend API ever
    // passes a subject through to a raw SMTP header without folding it,
    // rather than depending entirely on a third party's own sanitization.
    if (typeof businessName === "string" && /[\r\n]/.test(businessName)) {
      res.status(400).json({ error: "businessName can't contain line breaks" });
      return;
    }
    // Reserved-prefix check (2026-08-30, see the signup-time check above
    // for the reasoning) — exempts Werner's own accounts (same
    // OPERATOR_ACCOUNT_IDS allowlist as POST /admin/announce below), since
    // LazyRelay's own dogfooding account is literally named "LazyRelay"
    // and needs to be able to use that name. Previously this compared
    // against the account's current DB value instead (a no-op-only
    // exemption), which meant the moment that account's name changed away
    // from "LazyRelay" — even to test the Save button — there was no way
    // back through this endpoint, since "LazyRelay" was then just another
    // blocked name (2026-09-15 incident: exactly this happened during a
    // Settings-page test pass). Keying off the account id instead means
    // the exemption survives any temporary rename.
    const reservedNameExemptAccountIds = new Set(
      (process.env.OPERATOR_ACCOUNT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    );
    if (
      typeof businessName === "string" &&
      businessName.trim() &&
      isReservedBusinessName(businessName.trim()) &&
      !(req.accountId && reservedNameExemptAccountIds.has(req.accountId))
    ) {
      res.status(400).json({ error: "That name isn't available — try a different one." });
      return;
    }
    const settings = validateBody(accountSettingsBodySchema, req.body);
    if (!settings.ok) {
      res.status(400).json({ error: settings.error });
      return;
    }
    const { emailFailureAlertsEnabled, webhookUrl } = settings.data;
    // A leaked/compromised API key silently repointing the webhook would be
    // a persistent, ongoing exfiltration channel for every future verified
    // post — same escalation-risk shape as API key creation itself, so this
    // is human-dashboard-only, not something an agent can do headlessly.
    if (webhookUrl !== undefined && req.authMethod === "apiKey" && !req.isAdmin) {
      res.status(403).json({ error: "Webhook settings can only be changed from a logged-in dashboard session, not an API key." });
      return;
    }
    if (webhookUrl !== undefined && req.authMethod === "jwt" && req.role !== "owner") {
      res.status(403).json({ error: "Only the account owner can change webhook settings." });
      return;
    }
    let newWebhookSecret: string | null = null;
    let normalizedWebhookUrl: string | null | undefined = undefined;
    if (typeof webhookUrl === "string") {
      const trimmed = webhookUrl.trim();
      if (trimmed.length === 0) {
        res.status(400).json({ error: "webhookUrl can't be empty, pass null to remove it" });
        return;
      }
      // scheduler.ts fetches this URL server-side every time a post is
      // confirmed live — same class of SSRF as mediaUrl/coverImageUrl
      // (routes.ts's validatePostFields), so it gets the same guard. This
      // was the one place that class of check had been missed.
      const safety = await isSafeMediaUrl(trimmed);
      if (!safety.safe) {
        res.status(400).json({ error: `webhookUrl ${safety.reason}` });
        return;
      }
      normalizedWebhookUrl = trimmed;
      const { data: existing } = await req.db!.from("accounts").select("webhook_secret").eq("id", req.accountId).maybeSingle();
      if (!existing?.webhook_secret) newWebhookSecret = generateWebhookSecret();
    } else if (webhookUrl === null) {
      normalizedWebhookUrl = null;
    }

    const update: Record<string, unknown> = {};
    if (businessName !== undefined) update.business_name = businessName?.trim() || null;
    if (emailFailureAlertsEnabled !== undefined) update.email_failure_alerts_enabled = emailFailureAlertsEnabled;
    if (voiceProfile !== undefined) update.voice_profile = voiceProfile?.trim() || null;
    if (normalizedWebhookUrl !== undefined) {
      update.webhook_url = normalizedWebhookUrl;
      if (normalizedWebhookUrl === null) update.webhook_secret = null;
      else if (newWebhookSecret) update.webhook_secret = newWebhookSecret;
    }
    // Stays on supabase, not req.db: UPDATE on accounts is revoked from
    // authenticated entirely (0069_lock_down_accounts_update_rls.sql --
    // "the backend already writes to accounts exclusively via its
    // service-role key"), so req.db would fail with a permissions error.
    const { data, error } = await supabase
      .from("accounts")
      .update(update)
      .eq("id", req.accountId)
      .select("email, business_name, email_failure_alerts_enabled, webhook_url, webhook_secret, voice_profile")
      .single();
    if (error) {
      // 23505 = the case-insensitive unique index on lower(business_name)
      // (migration 0074) — same pattern as POST/PATCH /brands.
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "That business name is already taken — try a different one." });
        return;
      }
      dbError(res, error, "PATCH /account");
      return;
    }
    if (!data) {
      dbError(res, { message: "update returned no row" }, "PATCH /account");
      return;
    }
    res.json({
      email: data.email,
      businessName: data.business_name,
      emailFailureAlertsEnabled: data.email_failure_alerts_enabled,
      webhookUrl: data.webhook_url,
      webhookConfigured: !!data.webhook_secret,
      voiceProfile: data.voice_profile,
      // Only present the one time a secret is newly generated — same
      // "shown once, save it now" pattern as API key creation.
      ...(newWebhookSecret ? { webhookSecret: newWebhookSecret } : {}),
    });
  });

  // Lets a customer rotate a compromised/leaked webhook secret without
  // having to also change (and re-register with their own systems) the
  // webhook URL itself. Human-dashboard-only, same reasoning as the
  // webhookUrl check in PATCH /account above.
  router.post("/account/webhook/regenerate-secret", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing } = await req.db!.from("accounts").select("webhook_url").eq("id", req.accountId).maybeSingle();
    if (!existing?.webhook_url) {
      res.status(400).json({ error: "Set a webhook URL first before generating a secret." });
      return;
    }
    const newSecret = generateWebhookSecret();
    // Stays on supabase: accounts UPDATE is revoked from authenticated, see
    // the comment on PATCH /account above (0069_lock_down_accounts_update_rls.sql).
    const { error } = await supabase.from("accounts").update({ webhook_secret: newSecret }).eq("id", req.accountId);
    if (error) {
      dbError(res, error, "POST /account/webhook/regenerate-secret");
      return;
    }
    res.json({ webhookSecret: newSecret });
  });

  // API keys let a customer's own AI agent call this API directly and
  // headlessly (bring-your-own-agent — see tier.ts/pricing copy) instead of
  // needing a Supabase browser session, which by definition requires a
  // human to log in. Only requireAuth's Supabase-JWT path may create or
  // list keys — an agent authenticating WITH an API key can't mint more of
  // them, so a leaked key can't be used to self-escalate into permanent
  // access if the original key is later revoked.
  const apiKeyBodySchema = z.object({
    name: nonEmptyString("name is required").max(60, "name must be 60 characters or fewer"),
    canShareProof: unvalidated(),
  });
  router.post("/api-keys", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    // AI-agent / MCP access opened to every tier including Free 2026-09-02
    // (Werner's call, after a competitor audit found 3 of 5 competitors
    // with a real free plan already give this away free). The paid-tier
    // block that used to live here is gone on purpose, not a missed spot --
    // the hosted (OAuth) MCP path already had no equivalent check at all
    // (mcpAuth.ts verifies the token, not the tier), so this was the one
    // remaining place Free was actually blocked; removing it makes both
    // paths consistent instead of adding a new gate to the other one.
    // Free-tier usage is still bounded by the same real limits everyone
    // else has: tieredRateLimit's 60 req/min ceiling and the free-tier
    // post-count cap enforced in scheduleOnePost/checkFreeTierPostLimit --
    // an API key doesn't bypass either.
    const body = validateBody(apiKeyBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { name, canShareProof } = body.data;
    const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
    const { data, error } = await req.db!
      .from("api_keys")
      .insert({
        account_id: req.accountId,
        name: name.trim(),
        key_prefix: rawKey.slice(0, API_KEY_PREFIX.length + 6),
        key_hash: hashApiKey(rawKey),
        // Off by default — a newly created (or later leaked) key can't
        // generate public proof-sharing links unless the customer
        // explicitly opted in at creation. See migration
        // 0038_proof_link_sharing.sql for the full reasoning.
        can_share_proof: canShareProof === true,
      })
      .select("id, name, key_prefix, can_share_proof, created_at")
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /api-keys");
      return;
    }
    // The only time the raw key is ever returned — it's not retrievable
    // again after this response, only key_prefix is kept for display.
    res.status(201).json({ ...data, key: rawKey });
  });

  router.get("/api-keys", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("api_keys")
      .select("id, name, key_prefix, can_share_proof, created_at, last_used_at, revoked_at")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /api-keys");
      return;
    }
    res.json(data);
  });

  router.delete("/api-keys/:id", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: key } = await req.db!.from("api_keys").select("account_id").eq("id", req.params.id).maybeSingle();
    if (!key || key.account_id !== req.accountId) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    // Stays on supabase, not req.db: api_keys' RLS policies (0081/0082
    // migrations) only cover SELECT (api_keys_select_members) and hard
    // DELETE (api_keys_delete_owner) -- there's no UPDATE policy, and this
    // revoke is a soft-delete via UPDATE, not a real DELETE. Under req.db
    // this would silently affect 0 rows (no error, key stays live) instead
    // of actually revoking it.
    const { error } = await supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /api-keys/:id");
      return;
    }
    res.status(204).end();
  });

  return router;
}
