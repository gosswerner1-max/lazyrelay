// Webhook endpoints (2026-09-30): several per account, each with its own secret,
// event choices and optional channel filter, plus a delivery log and a test
// button. See src/webhook.ts for delivery and retries, migration 0098 for the
// tables. Owner-only and human-dashboard-only, like the single webhook was: a
// leaked API key repointing a webhook would be a quiet, ongoing exfiltration
// channel for every future post.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, requireHumanAuth, requireOwner, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { isSafeMediaUrl } from "../../urlSafety.js";
import { dbError } from "./shared.js";
import { validateBody } from "../validation.js";
import { attemptDelivery, generateWebhookSecret, MAX_ATTEMPTS, MAX_WEBHOOK_ENDPOINTS, WEBHOOK_EVENTS } from "../../webhook.js";
import { randomUUID } from "node:crypto";

const eventsSchema = z
  .array(z.string({ error: "events must be a list of event names" }), { error: "events must be a list of event names" })
  .refine((list) => list.every((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e)), {
    message: `events can only include: ${WEBHOOK_EVENTS.join(", ")}`,
  });
const channelsSchema = z.array(z.string({ error: "socialAccountIds must be a list of ids" }), { error: "socialAccountIds must be a list of ids" }).nullable();
const labelSchema = z.string({ error: "label must be a string" }).max(60, "label must be 60 characters or fewer").nullish();

const createBodySchema = z.object({
  url: z.string({ error: "url is required" }).trim().min(1, "url is required"),
  label: labelSchema,
  events: eventsSchema.optional(),
  socialAccountIds: channelsSchema.optional(),
});
const updateBodySchema = z.object({
  url: z.string({ error: "url must be a string" }).trim().min(1, "url can't be empty").optional(),
  label: labelSchema,
  events: eventsSchema.optional(),
  socialAccountIds: channelsSchema.optional(),
  enabled: z.boolean({ error: "enabled must be true or false" }).optional(),
});

const guard = [requireAuth, requireHumanAuth, requireOwner, tieredRateLimit] as const;

interface EndpointRow {
  id: string;
  label: string | null;
  url: string;
  events: string[];
  social_account_ids: string[] | null;
  enabled: boolean;
  created_at: string;
}

const toPublic = (e: EndpointRow) => ({
  id: e.id,
  label: e.label,
  url: e.url,
  events: e.events ?? [],
  socialAccountIds: e.social_account_ids,
  enabled: e.enabled,
  createdAt: e.created_at,
});

/** Every id must be a connected channel of THIS account, so one customer can
 *  never point a filter at another's channels. */
async function channelsBelongToAccount(accountId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const { data } = await supabase.from("social_accounts").select("id").eq("account_id", accountId).in("id", ids);
  return (data ?? []).length === new Set(ids).size;
}

export function buildWebhooksRouter(): Router {
  const router = Router();

  router.get("/webhooks", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .select("id, label, url, events, social_account_ids, enabled, created_at")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /webhooks");
      return;
    }
    const endpoints = (data ?? []) as EndpointRow[];
    // Health at a glance: the latest delivery for each endpoint.
    const latest = new Map<string, { status: string; createdAt: string; statusCode: number | null; error: string | null }>();
    if (endpoints.length > 0) {
      const { data: recent } = await supabase
        .from("webhook_deliveries")
        .select("endpoint_id, status, created_at, last_status_code, last_error")
        .in("endpoint_id", endpoints.map((e) => e.id))
        .order("created_at", { ascending: false })
        .limit(200);
      for (const d of (recent ?? []) as Array<{ endpoint_id: string; status: string; created_at: string; last_status_code: number | null; last_error: string | null }>) {
        if (!latest.has(d.endpoint_id)) latest.set(d.endpoint_id, { status: d.status, createdAt: d.created_at, statusCode: d.last_status_code, error: d.last_error });
      }
    }
    res.json({
      maxEndpoints: MAX_WEBHOOK_ENDPOINTS,
      availableEvents: WEBHOOK_EVENTS,
      endpoints: endpoints.map((e) => ({ ...toPublic(e), lastDelivery: latest.get(e.id) ?? null })),
    });
  });

  router.post("/webhooks", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(createBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { url, label, events, socialAccountIds } = body.data;
    const safety = await isSafeMediaUrl(url);
    if (!safety.safe) {
      res.status(400).json({ error: `url ${safety.reason}` });
      return;
    }
    const { count } = await supabase.from("webhook_endpoints").select("id", { count: "exact", head: true }).eq("account_id", req.accountId);
    if ((count ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
      res.status(400).json({ error: `You can have up to ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints. Remove one first.` });
      return;
    }
    if (socialAccountIds && !(await channelsBelongToAccount(req.accountId as string, socialAccountIds))) {
      res.status(400).json({ error: "socialAccountIds must all be channels connected to this account" });
      return;
    }
    const secret = generateWebhookSecret();
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .insert({
        account_id: req.accountId,
        label: label?.trim() || null,
        url,
        secret,
        events: events ?? [],
        social_account_ids: socialAccountIds && socialAccountIds.length > 0 ? socialAccountIds : null,
        enabled: true,
      })
      .select("id, label, url, events, social_account_ids, enabled, created_at")
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /webhooks");
      return;
    }
    // The secret is shown ONCE, here, like an API key.
    res.status(201).json({ ...toPublic(data as EndpointRow), secret });
  });

  router.patch("/webhooks/:id", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(updateBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { url, label, events, socialAccountIds, enabled } = body.data;
    const update: Record<string, unknown> = {};
    if (url !== undefined) {
      const safety = await isSafeMediaUrl(url);
      if (!safety.safe) {
        res.status(400).json({ error: `url ${safety.reason}` });
        return;
      }
      update.url = url;
    }
    if (label !== undefined) update.label = label?.trim() || null;
    if (events !== undefined) update.events = events;
    if (enabled !== undefined) update.enabled = enabled;
    if (socialAccountIds !== undefined) {
      if (socialAccountIds && !(await channelsBelongToAccount(req.accountId as string, socialAccountIds))) {
        res.status(400).json({ error: "socialAccountIds must all be channels connected to this account" });
        return;
      }
      update.social_account_ids = socialAccountIds && socialAccountIds.length > 0 ? socialAccountIds : null;
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .update(update)
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id, label, url, events, social_account_ids, enabled, created_at")
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /webhooks/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Webhook endpoint not found" });
      return;
    }
    res.json(toPublic(data as EndpointRow));
  });

  router.delete("/webhooks/:id", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .delete()
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id");
    if (error) {
      dbError(res, error, "DELETE /webhooks/:id");
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Webhook endpoint not found" });
      return;
    }
    res.json({ deleted: true });
  });

  router.post("/webhooks/:id/regenerate-secret", ...guard, async (req: AuthedRequest, res) => {
    const secret = generateWebhookSecret();
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .update({ secret })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id");
    if (error) {
      dbError(res, error, "POST /webhooks/:id/regenerate-secret");
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Webhook endpoint not found" });
      return;
    }
    res.json({ secret });
  });

  // Sends a real signed "webhook.test" delivery to this one endpoint and reports
  // what came back, so a customer can check their receiver without waiting for
  // a real post. One attempt; a failure is not retried.
  router.post("/webhooks/:id/test", ...guard, async (req: AuthedRequest, res) => {
    const { data: endpoint } = await supabase
      .from("webhook_endpoints")
      .select("id")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (!endpoint) {
      res.status(404).json({ error: "Webhook endpoint not found" });
      return;
    }
    const eventId = randomUUID();
    const { data: row, error } = await supabase
      .from("webhook_deliveries")
      .insert({
        endpoint_id: req.params.id,
        account_id: req.accountId,
        event: "webhook.test",
        event_id: eventId,
        payload: { event: "webhook.test", eventId, createdAt: new Date().toISOString(), message: "This is a test event from LazyRelay." },
        status: "pending",
        next_attempt_at: new Date().toISOString(),
        // Not retried: the customer is watching the answer, so this counts as
        // the last-but-one attempt and a failure ends it.
        attempts: MAX_ATTEMPTS - 1,
      })
      .select("id")
      .single();
    if (error || !row) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /webhooks/:id/test");
      return;
    }
    const result = await attemptDelivery((row as { id: string }).id);
    res.json({ delivered: result?.status === "delivered", statusCode: result?.statusCode ?? null, error: result?.error ?? null });
  });

  router.get("/webhooks/:id/deliveries", ...guard, async (req: AuthedRequest, res) => {
    const { data: endpoint } = await supabase
      .from("webhook_endpoints")
      .select("id")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (!endpoint) {
      res.status(404).json({ error: "Webhook endpoint not found" });
      return;
    }
    const { data, error } = await supabase
      .from("webhook_deliveries")
      .select("id, event, status, attempts, last_status_code, last_error, created_at, delivered_at")
      .eq("endpoint_id", req.params.id)
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) {
      dbError(res, error, "GET /webhooks/:id/deliveries");
      return;
    }
    res.json({
      deliveries: (data ?? []).map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        statusCode: d.last_status_code,
        error: d.last_error,
        createdAt: d.created_at,
        deliveredAt: d.delivered_at,
      })),
    });
  });

  return router;
}
