// WhatsApp broadcasts (Phase 2): the customer's templates (copied from THEIR Meta account), their own rate card (for a cost ESTIMATE),
// and broadcasts: preview, schedule, list, cancel, plus lifting a pause on a number.
//
//   GET  /whatsapp/send-capabilities          { sending } a boolean only; false (never an error) while anything is off
//   GET  /whatsapp/templates                  the connection's stored templates; only approved, supported ones are "usable"
//   POST /whatsapp/templates/sync             read the templates from the customer's own Meta account (their stored token)
//   GET  /whatsapp/rate-card, PUT             the customer's own per-message prices (an estimate only, never Meta's figure)
//   GET  /whatsapp/broadcasts, POST           list; schedule (dry_run: true previews the audience and cost and stores nothing)
//   GET  /whatsapp/broadcasts/:id
//   POST /whatsapp/broadcasts/:id/cancel
//   POST /whatsapp/connections/:id/resume-sending   lift a pause Meta caused (the customer's own choice)
//
// Every route but the first is behind the gate in whatsappRouteGate.ts: three flags exactly "true", platform visible, a signed-in
// HUMAN (an API key is refused: no API key, MCP, Zapier, bulk or duplicate path can send), a paid plan. All sends use the customer's
// OWN stored login (byok.ts). This router is the ONLY place a broadcast is created.

import express, { type Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { supabase } from "../../supabase.js";
import { checkWhatsappPlan } from "../../accountLimits.js";
import { contactStorageReady } from "../../whatsappContacts.js";
import { dbError } from "./shared.js";
import { canSeePlatform } from "./socialAccounts.routes.js";
import { sendEnabled } from "../../whatsappBroadcast/flags.js";
import { fetchHttpClient, type HttpClient } from "../../whatsappBroadcast/cloudApi.js";
import { resumeConnection } from "../../whatsappBroadcast/connectionPause.js";
import { cancelBroadcast, createBroadcast, getBroadcast, listBroadcasts } from "../../whatsappBroadcast/broadcasts.js";
import { listStoredTemplates, syncTemplates } from "../../whatsappBroadcast/templates.js";
import { UUID, firstIssue, humanRoute, ownsConnection, statusForRefusal, userIdFromToken } from "./whatsappRouteGate.js";

const SYNC_STATUS: Record<string, number> = { plan: 400, connection_unavailable: 409, no_own_credentials: 409, credentials: 400, unreachable: 502, rejected: 502 };
const SYNC_MESSAGE: Record<string, string> = {
  plan: "WhatsApp is available on the Business plan and above.",
  connection_unavailable: "That WhatsApp connection is not available. Check it in Social Platforms.",
  no_own_credentials: "This WhatsApp connection does not hold your own Meta credentials. Reconnect it with your own Meta credentials in Social Platforms.",
  credentials: "Meta did not accept your access token. Check it in Social Platforms and make sure it can read your message templates.",
  unreachable: "Meta could not be reached. Try again in a moment.",
  rejected: "Meta did not return your templates. Check your WhatsApp Business account in Meta.",
};

const connectionQuery = z.object({ social_account_id: UUID });
const rateCardSchema = z.object({
  social_account_id: UUID,
  currency: z.string().regex(/^[A-Z]{3}$/),
  marketing: z.number().min(0).max(1000),
  utility: z.number().min(0).max(1000),
  authentication: z.number().min(0).max(1000),
});
const createSchema = z.object({
  social_account_id: UUID,
  template_id: UUID,
  name: z.string().max(200),
  params: z.array(z.string().max(2000)).max(20),
  scheduled_for: z.string().datetime({ offset: true }),
  dry_run: z.boolean().optional(),
});
const listSchema = z.object({
  social_account_id: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().datetime({ offset: true }).optional(),
});

export function buildWhatsAppBroadcastsRouter(deps: { http?: HttpClient } = {}): Router {
  const http = deps.http ?? fetchHttpClient;
  const router = express.Router();

  // A boolean only. True when the rollout flags are on, the platform is visible for the account, the contact keys exist AND the plan
  // gate passes. That is all: there is no cap or kill switch behind it.
  router.get("/whatsapp/send-capabilities", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    let sending = false;
    try {
      sending = sendEnabled() && canSeePlatform("whatsapp", req.accountId) && contactStorageReady() && (await checkWhatsappPlan(req.accountId!)) === null;
    } catch {
      sending = false;
    }
    res.json({ sending });
  });

  router.get("/whatsapp/templates", ...humanRoute, async (req: AuthedRequest, res) => {
    const q = connectionQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "social_account_id must be a connection id" });
      return;
    }
    try {
      if (!(await ownsConnection(req.accountId!, q.data.social_account_id))) {
        res.status(404).json({ error: "That WhatsApp connection was not found." });
        return;
      }
      res.json({ templates: await listStoredTemplates(req.accountId!, q.data.social_account_id) });
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "GET /whatsapp/templates");
    }
  });

  router.post("/whatsapp/templates/sync", ...humanRoute, async (req: AuthedRequest, res) => {
    const b = connectionQuery.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: "social_account_id must be a connection id" });
      return;
    }
    try {
      if (!(await ownsConnection(req.accountId!, b.data.social_account_id))) {
        res.status(404).json({ error: "That WhatsApp connection was not found." });
        return;
      }
      const out = await syncTemplates(http, req.accountId!, b.data.social_account_id);
      if (!out.ok) {
        res.status(SYNC_STATUS[out.reason] ?? 502).json({ error: SYNC_MESSAGE[out.reason], code: out.reason });
        return;
      }
      res.json({ synced: out.synced, approved: out.approved, unsupported: out.unsupported, disabled: out.disabled });
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "POST /whatsapp/templates/sync");
    }
  });

  router.get("/whatsapp/rate-card", ...humanRoute, async (req: AuthedRequest, res) => {
    const q = connectionQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "social_account_id must be a connection id" });
      return;
    }
    const { data, error } = await supabase.from("whatsapp_rate_cards").select("currency, marketing_per_message, utility_per_message, authentication_per_message").eq("account_id", req.accountId!).eq("social_account_id", q.data.social_account_id).maybeSingle();
    if (error) {
      dbError(res, error, "GET /whatsapp/rate-card");
      return;
    }
    const r = data as { currency: string; marketing_per_message: number | string; utility_per_message: number | string; authentication_per_message: number | string } | null;
    res.json({ rateCard: r ? { currency: r.currency, marketing: Number(r.marketing_per_message), utility: Number(r.utility_per_message), authentication: Number(r.authentication_per_message) } : null });
  });

  router.put("/whatsapp/rate-card", ...humanRoute, async (req: AuthedRequest, res) => {
    const b = rateCardSchema.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      if (!(await ownsConnection(req.accountId!, b.data.social_account_id))) {
        res.status(404).json({ error: "That WhatsApp connection was not found." });
        return;
      }
      const at = new Date().toISOString();
      const { error } = await supabase.from("whatsapp_rate_cards").upsert(
        { account_id: req.accountId!, social_account_id: b.data.social_account_id, currency: b.data.currency, marketing_per_message: b.data.marketing, utility_per_message: b.data.utility, authentication_per_message: b.data.authentication, updated_at: at },
        { onConflict: "social_account_id" },
      );
      if (error) {
        dbError(res, error, "PUT /whatsapp/rate-card");
        return;
      }
      res.json({ rateCard: { currency: b.data.currency, marketing: b.data.marketing, utility: b.data.utility, authentication: b.data.authentication } });
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "PUT /whatsapp/rate-card");
    }
  });

  router.get("/whatsapp/broadcasts", ...humanRoute, async (req: AuthedRequest, res) => {
    const q = listSchema.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "social_account_id must be a connection id; limit 1 to 100; before an ISO time" });
      return;
    }
    try {
      res.json(await listBroadcasts(req.accountId!, { socialAccountId: q.data.social_account_id, limit: q.data.limit, before: q.data.before ? new Date(q.data.before).toISOString() : undefined }));
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "GET /whatsapp/broadcasts");
    }
  });

  router.post("/whatsapp/broadcasts", ...humanRoute, async (req: AuthedRequest, res) => {
    const b = createSchema.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      const out = await createBroadcast(
        { accountId: req.accountId!, createdBy: userIdFromToken(req.rawToken) },
        { socialAccountId: b.data.social_account_id, templateId: b.data.template_id, name: b.data.name, params: b.data.params, scheduledFor: new Date(b.data.scheduled_for) },
        { dryRun: b.data.dry_run === true },
      );
      if (!out.ok) {
        res.status(statusForRefusal(out.code)).json({ error: out.message, code: out.code });
        return;
      }
      res.status(out.dryRun ? 200 : 201).json({ dryRun: out.dryRun, preview: out.preview, ...(out.broadcast ? { broadcast: out.broadcast } : {}) });
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "POST /whatsapp/broadcasts");
    }
  });

  router.get("/whatsapp/broadcasts/:id", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = UUID.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "id must be a broadcast id" });
      return;
    }
    try {
      const view = await getBroadcast(req.accountId!, id.data);
      if (!view) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ broadcast: view });
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "GET /whatsapp/broadcasts/:id");
    }
  });

  router.post("/whatsapp/broadcasts/:id/cancel", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = UUID.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "id must be a broadcast id" });
      return;
    }
    try {
      const out = await cancelBroadcast(req.accountId!, id.data);
      if (!out.ok) {
        res.status(statusForRefusal(out.code)).json({ error: out.code === "not_found" ? "Not found" : "That broadcast can no longer be cancelled.", code: out.code });
        return;
      }
      res.json({ status: out.status });
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "POST /whatsapp/broadcasts/:id/cancel");
    }
  });

  router.post("/whatsapp/connections/:id/resume-sending", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = UUID.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "id must be a connection id" });
      return;
    }
    try {
      if (!(await resumeConnection(req.accountId!, id.data))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, "POST /whatsapp/connections/:id/resume-sending");
    }
  });

  return router;
}
