import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { supabase } from "./supabase.js";
import { isSafeMediaUrl } from "./urlSafety.js";

// Webhooks v2 (2026-09-30). See migration 0098 for the tables.
//
// A customer can register several endpoints, each choosing which events it
// wants and (optionally) which connected channels it cares about. Every event
// becomes a webhook_deliveries row per matching endpoint. The row is the queue
// AND the log: it is attempted straight away, and if the customer's endpoint is
// down it is retried on a schedule instead of being lost (the old sender made
// one fire-and-forget attempt). Nothing here may ever throw back into the
// scheduler: a webhook problem must never affect posting.

export const WEBHOOK_EVENTS = ["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];
/** Sent only by the Send test button; never subscribed to. */
export type AnyWebhookEvent = WebhookEventName | "webhook.test";

export const MAX_WEBHOOK_ENDPOINTS = 5;

/** Wait before retry N (after attempt N fails). 6 attempts in total, over about 9 hours. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

const REQUEST_TIMEOUT_MS = 10_000;
const STUCK_SENDING_MS = 5 * 60_000;
const DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60_000;
const CYCLE_BATCH = 25;

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/** HMAC-SHA256 of the raw JSON body, hex. Unchanged from v1 so anything already
 *  verifying signatures keeps working. */
export function signWebhookBody(secret: string, json: string): string {
  return createHmac("sha256", secret).update(json).digest("hex");
}

export type ResponseVerdict = "delivered" | "retry" | "permanent";

/** 2xx delivered. 408, 429 and 5xx are the receiver's temporary trouble: retry.
 *  Everything else (a redirect we refuse to follow, 4xx such as 404 or 410) will
 *  not fix itself: stop, and show it in the delivery log. */
export function classifyResponse(status: number): ResponseVerdict {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "permanent";
}

/** Delay before the next attempt after `attemptsMade` attempts have failed, or
 *  null once every attempt has been used. */
export function nextRetryDelayMs(attemptsMade: number): number | null {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? null;
}

export interface EndpointFilter {
  events: string[] | null;
  social_account_ids: string[] | null;
}

/** Pure. An endpoint wants an event when it subscribed to it (an empty list
 *  means every event) and, if it is limited to certain channels, the event is
 *  about one of them. Events that are not about a channel go to everyone. */
export function endpointMatches(endpoint: EndpointFilter, event: string, socialAccountId?: string | null): boolean {
  if (endpoint.events && endpoint.events.length > 0 && !endpoint.events.includes(event)) return false;
  if (endpoint.social_account_ids && endpoint.social_account_ids.length > 0 && socialAccountId) {
    return endpoint.social_account_ids.includes(socialAccountId);
  }
  return true;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event: string;
  event_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface AttemptResult {
  status: "delivered" | "retry" | "failed";
  statusCode: number | null;
  error: string | null;
}

const trimError = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}...` : s);

/** Makes ONE attempt for a delivery and records the outcome. Claims the row
 *  first (pending to sending) so two workers, or the immediate attempt and the
 *  retry worker, can never send the same delivery twice. Returns null when
 *  someone else already holds it. */
export async function attemptDelivery(deliveryId: string): Promise<AttemptResult | null> {
  const now = new Date().toISOString();
  const { data: claimed } = await supabase
    .from("webhook_deliveries")
    .update({ status: "sending", updated_at: now })
    .eq("id", deliveryId)
    .eq("status", "pending")
    .select("id, endpoint_id, event, event_id, payload, attempts")
    .maybeSingle();
  if (!claimed) return null;
  const delivery = claimed as DeliveryRow;

  const finish = async (result: AttemptResult): Promise<AttemptResult> => {
    const attempts = delivery.attempts + 1;
    const patch: Record<string, unknown> = {
      attempts,
      last_status_code: result.statusCode,
      last_error: result.error,
      updated_at: new Date().toISOString(),
    };
    if (result.status === "delivered") {
      patch.status = "delivered";
      patch.delivered_at = new Date().toISOString();
    } else if (result.status === "retry" && delivery.event === "webhook.test") {
      // The Send test button: the customer is watching the answer, so one
      // attempt, no retries.
      patch.status = "failed";
    } else if (result.status === "retry") {
      const delay = nextRetryDelayMs(attempts);
      if (delay === null) {
        patch.status = "failed";
        patch.last_error = trimError(`Gave up after ${attempts} attempts. ${result.error ?? ""}`.trim());
      } else {
        patch.status = "pending";
        patch.next_attempt_at = new Date(Date.now() + delay).toISOString();
      }
    } else {
      patch.status = "failed";
    }
    await supabase.from("webhook_deliveries").update(patch).eq("id", delivery.id);
    return result;
  };

  const { data: endpoint } = await supabase
    .from("webhook_endpoints")
    .select("url, secret, enabled")
    .eq("id", delivery.endpoint_id)
    .maybeSingle();
  if (!endpoint || !endpoint.enabled) {
    return finish({ status: "failed", statusCode: null, error: "The endpoint was removed or turned off." });
  }

  // Checked again at send time, not only when it was saved: a hostname can be
  // repointed at an internal address afterwards.
  const safety = await isSafeMediaUrl(endpoint.url as string);
  if (!safety.safe) {
    return finish({ status: "failed", statusCode: null, error: `The URL is no longer allowed: ${safety.reason}.` });
  }

  const json = JSON.stringify(delivery.payload);
  try {
    const res = await fetch(endpoint.url as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "LazyRelay-Webhooks/1.0",
        "X-LazyRelay-Event": delivery.event,
        "X-LazyRelay-Signature": signWebhookBody(endpoint.secret as string, json),
        // Stable across retries: receivers can use it to ignore a repeat.
        "X-LazyRelay-Delivery": delivery.event_id,
        "X-LazyRelay-Attempt": String(delivery.attempts + 1),
      },
      body: json,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Never follow a redirect: it could lead somewhere the safety check above
      // never saw (an internal address).
      redirect: "manual",
    });
    const verdict = classifyResponse(res.status);
    if (verdict === "delivered") {
      // Logged on purpose (see the history in git): a delivery that only logs
      // failures is impossible to prove ever worked. No payload, signature or secret.
      console.log(`[webhook] delivered ${delivery.event} (${delivery.event_id}) to endpoint ${delivery.endpoint_id} (${res.status})`);
      return finish({ status: "delivered", statusCode: res.status, error: null });
    }
    const error =
      res.status >= 300 && res.status < 400
        ? `The endpoint answered with a redirect (${res.status}). Redirects are not followed.`
        : `The endpoint answered ${res.status}.`;
    console.error(`[webhook] ${delivery.event} to endpoint ${delivery.endpoint_id}: ${error}`);
    return finish({ status: verdict === "retry" ? "retry" : "failed", statusCode: res.status, error });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] ${delivery.event} to endpoint ${delivery.endpoint_id} failed: ${message}`);
    return finish({ status: "retry", statusCode: null, error: trimError(`Could not reach the endpoint: ${message}`) });
  }
}

/** Queues an event for every matching endpoint and starts the first attempt
 *  without waiting for it. Never throws. */
export async function dispatchWebhookEvent(input: {
  accountId: string;
  event: AnyWebhookEvent;
  socialAccountId?: string | null;
  data: Record<string, unknown>;
}): Promise<void> {
  try {
    const { data: endpoints } = await supabase
      .from("webhook_endpoints")
      .select("id, events, social_account_ids")
      .eq("account_id", input.accountId)
      .eq("enabled", true);
    const targets = ((endpoints ?? []) as Array<{ id: string } & EndpointFilter>).filter((ep) =>
      endpointMatches(ep, input.event, input.socialAccountId),
    );
    if (targets.length === 0) return;

    const eventId = randomUUID();
    const payload = { event: input.event, eventId, createdAt: new Date().toISOString(), ...input.data };
    const { data: rows } = await supabase
      .from("webhook_deliveries")
      .insert(
        targets.map((ep) => ({
          endpoint_id: ep.id,
          account_id: input.accountId,
          event: input.event,
          event_id: eventId,
          payload,
          // Explicit, not left to column defaults: the claim below depends on them.
          status: "pending",
          attempts: 0,
          next_attempt_at: new Date().toISOString(),
        })),
      )
      .select("id");
    for (const row of (rows ?? []) as Array<{ id: string }>) {
      void attemptDelivery(row.id).catch((err) => console.error("[webhook] attempt threw:", err instanceof Error ? err.message : err));
    }
  } catch (err) {
    console.error("[webhook] dispatch failed:", err instanceof Error ? err.message : err);
  }
}

/** The retry worker (index.ts runs it every 30 seconds): picks up deliveries
 *  whose next attempt is due, frees ones stranded in "sending" by a restart, and
 *  deletes old finished rows. */
export async function runWebhookDeliveryCycle(now: number = Date.now()): Promise<{ attempted: number; reclaimed: number; purged: number }> {
  const stuckBefore = new Date(now - STUCK_SENDING_MS).toISOString();
  const { data: reclaimedRows } = await supabase
    .from("webhook_deliveries")
    .update({ status: "pending", next_attempt_at: new Date(now).toISOString() })
    .eq("status", "sending")
    .lt("updated_at", stuckBefore)
    .select("id");

  const { data: due } = await supabase
    .from("webhook_deliveries")
    .select("id")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date(now).toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(CYCLE_BATCH);
  const ids = ((due ?? []) as Array<{ id: string }>).map((r) => r.id);
  await Promise.all(ids.map((id) => attemptDelivery(id).catch((err) => console.error("[webhook] attempt threw:", err instanceof Error ? err.message : err))));

  const { data: purgedRows } = await supabase
    .from("webhook_deliveries")
    .delete()
    .in("status", ["delivered", "failed"])
    .lt("created_at", new Date(now - DELIVERY_RETENTION_MS).toISOString())
    .select("id");

  return { attempted: ids.length, reclaimed: (reclaimedRows ?? []).length, purged: (purgedRows ?? []).length };
}
