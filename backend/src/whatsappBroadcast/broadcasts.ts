// Broadcasts: create (with a dry-run preview), list, read and cancel. NOTHING here sends a message; the sender loop (sender.ts)
// does, later, at the scheduled time.
//
// A broadcast is one approved template, sent to the opted-in contacts of ONE connection, at a scheduled time, with the customer's
// own stored login. Creating one is refused unless every gate passes, and each refusal has a stable code:
//   plan / no_own_credentials / connection_unavailable / connection_paused   (byok.ts: paid plan AND the customer's own login)
//   controls_unavailable / sending_stopped                                    (controls.ts: DB kill switch, fail closed)
//   template_not_found / template_unusable / params_mismatch / name_invalid / schedule_invalid
//   empty_audience / cap_recipients / cap_broadcasts                          (caps from the database)
//
// "posted" means HANDED OFF to Meta, not delivered. Delivery is shown only from Meta's own receipts, as "N delivered of M". Cost is
// an ESTIMATE: delivered messages times the price the customer typed into their own rate card. Meta never tells us the money.

import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { cleanDisplayName } from "../whatsappContacts.js";
import { checkSendEligibility } from "./byok.js";
import { countBroadcastsSince, loadControls } from "./controls.js";
import { MAX_TEMPLATE_PARAM_CHARS, sanitizeTemplateParam } from "./cloudApi.js";
import type { TemplateCategory } from "./templates.js";

export type BroadcastStatus = "scheduled" | "sending" | "completed" | "cancelled" | "paused" | "failed";

export interface CreateContext {
  accountId: string;
  /** The signed-in user's id, for the record of who scheduled it. */
  createdBy: string | null;
}

export interface CreateInput {
  socialAccountId: string;
  templateId: string;
  name: string;
  params: string[];
  scheduledFor: Date;
}

export interface CostEstimate {
  amount: number;
  currency: string;
  isEstimate: true;
}

export interface BroadcastCounts {
  total: number;
  queued: number;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
}

export interface BroadcastView {
  id: string;
  socialAccountId: string;
  name: string;
  status: BroadcastStatus;
  pauseReason: string | null;
  templateName: string;
  templateLanguage: string;
  templateCategory: TemplateCategory;
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  audienceEstimate: number;
  counts: BroadcastCounts;
  /** "N delivered of M, confirmed by Meta": delivered includes read; ofAccepted is how many Meta accepted. */
  delivery: { delivered: number; ofAccepted: number };
  costEstimate: CostEstimate | null;
}

export interface Preview {
  audience: number;
  excludedUs: number;
  estimatedCost: CostEstimate | null;
}

export type CreateRefusal = { ok: false; code: string; message: string; limit?: number };
export type CreateOutcome = { ok: true; dryRun: boolean; preview: Preview; broadcast?: BroadcastView } | CreateRefusal;

const refuse = (code: string, message: string, limit?: number): CreateRefusal => ({ ok: false, code, message, ...(limit !== undefined ? { limit } : {}) });

const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 30 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

const ELIGIBILITY_MESSAGES: Record<string, string> = {
  plan: "WhatsApp broadcasts are available on the Business plan and above.",
  no_own_credentials: "This WhatsApp connection does not hold your own Meta credentials. Reconnect it with your own Meta credentials in Social Platforms.",
  connection_unavailable: "That WhatsApp connection is not available. Check it in Social Platforms.",
  connection_paused: "Sending from this WhatsApp number is paused because of a problem Meta reported. Check your number in Meta Business Manager, then resume it here.",
};

// ---------------------------------------------------------------------------------------------------------------------
// Rate card and cost
// ---------------------------------------------------------------------------------------------------------------------

export interface RateCardRow {
  currency: string;
  marketing_per_message: number | string;
  utility_per_message: number | string;
  authentication_per_message: number | string;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** An ESTIMATE: delivered messages times the customer's own price for the template's category. Null without a rate card. */
export function estimateCost(category: TemplateCategory, deliveredCount: number, card: RateCardRow | null): CostEstimate | null {
  if (!card) return null;
  const rate = Number(category === "marketing" ? card.marketing_per_message : category === "utility" ? card.utility_per_message : card.authentication_per_message);
  if (!Number.isFinite(rate)) return null;
  return { amount: round6(rate * deliveredCount), currency: card.currency, isEstimate: true };
}

async function loadRateCards(accountId: string, socialAccountIds: string[]): Promise<Map<string, RateCardRow>> {
  const out = new Map<string, RateCardRow>();
  if (socialAccountIds.length === 0) return out;
  const { data, error } = await supabase
    .from("whatsapp_rate_cards")
    .select("social_account_id, currency, marketing_per_message, utility_per_message, authentication_per_message")
    .eq("account_id", accountId)
    .in("social_account_id", socialAccountIds);
  if (error) throw new Error(`rate card lookup failed: ${error.message}`);
  for (const r of (data ?? []) as Array<RateCardRow & { social_account_id: string }>) out.set(r.social_account_id, r);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------------------------------------------------

async function countContacts(accountId: string, socialAccountId: string, onlyUs: boolean): Promise<number> {
  let q = supabase.from("whatsapp_contacts").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("social_account_id", socialAccountId).eq("consent_status", "opted_in");
  if (onlyUs) q = q.eq("country_calling_code", "1");
  const { count, error } = await q;
  if (error) throw new Error(`contact count failed: ${error.message}`);
  return count ?? 0;
}

/** Opted-in contacts of the connection. A MARKETING template never goes to a US (+1) number (Meta does not deliver it), so those
 *  are counted out and reported separately. */
export async function countAudience(accountId: string, socialAccountId: string, category: TemplateCategory): Promise<{ audience: number; excludedUs: number }> {
  const total = await countContacts(accountId, socialAccountId, false);
  if (category !== "marketing") return { audience: total, excludedUs: 0 };
  const us = await countContacts(accountId, socialAccountId, true);
  return { audience: total - us, excludedUs: us };
}

// ---------------------------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------------------------

interface TemplateLookup {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: string;
  supported: boolean;
  variable_count: number;
}

export async function createBroadcast(ctx: CreateContext, input: CreateInput, opts: { dryRun: boolean; now?: Date }): Promise<CreateOutcome> {
  const now = opts.now ?? new Date();

  const name = cleanDisplayName(input.name);
  if (!name.ok || name.value === null) return refuse("name_invalid", "Give the broadcast a short name (up to 80 characters) that is not a phone number.");

  const at = input.scheduledFor.getTime();
  if (Number.isNaN(at) || at < now.getTime() + MIN_LEAD_MS || at > now.getTime() + MAX_LEAD_MS) {
    return refuse("schedule_invalid", "Pick a time between 1 minute and 30 days from now.");
  }

  const eligible = await checkSendEligibility(ctx.accountId, input.socialAccountId);
  if (!eligible.ok) return refuse(eligible.reason, ELIGIBILITY_MESSAGES[eligible.reason] ?? "Sending is not available for this connection.");

  const controls = await loadControls(ctx.accountId);
  if (!controls) return refuse("controls_unavailable", "Broadcast sending is not set up yet.");
  if (controls.killed) return refuse("sending_stopped", "Broadcast sending is switched off right now.");

  const { data: tdata, error: terr } = await supabase
    .from("whatsapp_message_templates")
    .select("id, name, language, category, status, supported, variable_count")
    .eq("id", input.templateId)
    .eq("account_id", ctx.accountId)
    .eq("social_account_id", input.socialAccountId)
    .maybeSingle();
  if (terr) throw new Error(`template lookup failed: ${terr.message}`);
  const template = tdata as TemplateLookup | null;
  if (!template) return refuse("template_not_found", "That template was not found for this WhatsApp number. Sync your templates and pick one again.");
  if (template.status !== "approved" || template.supported !== true) return refuse("template_unusable", "Only approved templates that this version supports can be sent.");

  const params = input.params.map((p) => (typeof p === "string" ? sanitizeTemplateParam(p) : ""));
  if (params.length !== template.variable_count || params.some((p) => p === "" || p.length > MAX_TEMPLATE_PARAM_CHARS)) {
    return refuse("params_mismatch", `This template needs exactly ${template.variable_count} filled-in value${template.variable_count === 1 ? "" : "s"}.`);
  }

  const { audience, excludedUs } = await countAudience(ctx.accountId, input.socialAccountId, template.category);
  if (audience === 0) return refuse("empty_audience", "There is nobody to send this to. Add opted-in contacts first.");
  if (audience > controls.maxRecipientsPerBroadcast) return refuse("cap_recipients", `A broadcast can reach at most ${controls.maxRecipientsPerBroadcast} people right now.`, controls.maxRecipientsPerBroadcast);
  const recent = await countBroadcastsSince(ctx.accountId, new Date(now.getTime() - DAY_MS));
  if (recent >= controls.maxBroadcastsPerDay) return refuse("cap_broadcasts", `You can schedule at most ${controls.maxBroadcastsPerDay} broadcasts in 24 hours right now.`, controls.maxBroadcastsPerDay);

  const cards = await loadRateCards(ctx.accountId, [input.socialAccountId]);
  const preview: Preview = { audience, excludedUs, estimatedCost: estimateCost(template.category, audience, cards.get(input.socialAccountId) ?? null) };
  if (opts.dryRun) return { ok: true, dryRun: true, preview };

  const id = randomUUID();
  const stamp = now.toISOString();
  const row = {
    id,
    account_id: ctx.accountId,
    social_account_id: input.socialAccountId,
    template_id: template.id,
    template_name: template.name,
    template_language: template.language,
    template_category: template.category,
    template_params: params,
    name: name.value,
    status: "scheduled",
    scheduled_for: input.scheduledFor.toISOString(),
    audience_estimate: audience,
    created_by: ctx.createdBy,
    created_at: stamp,
    updated_at: stamp,
  };
  const { error } = await supabase.from("whatsapp_broadcasts").insert(row);
  if (error) throw new Error(`broadcast save failed: ${error.message}`);
  const view = await getBroadcast(ctx.accountId, id);
  return { ok: true, dryRun: false, preview, broadcast: view ?? undefined };
}

// ---------------------------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------------------------

export const BROADCAST_COLUMNS =
  "id, social_account_id, name, status, pause_reason, template_name, template_language, template_category, scheduled_for, started_at, completed_at, cancelled_at, created_at, audience_estimate, count_total, count_queued, count_accepted, count_sent, count_delivered, count_read, count_failed, count_skipped";

function toView(r: Record<string, unknown>, card: RateCardRow | null): BroadcastView {
  const n = (k: string) => Number(r[k] ?? 0);
  const category = r.template_category as TemplateCategory;
  const delivered = n("count_delivered");
  const read = n("count_read");
  return {
    id: r.id as string,
    socialAccountId: r.social_account_id as string,
    name: r.name as string,
    status: r.status as BroadcastStatus,
    pauseReason: (r.pause_reason as string | null) ?? null,
    templateName: r.template_name as string,
    templateLanguage: r.template_language as string,
    templateCategory: category,
    scheduledFor: r.scheduled_for as string,
    startedAt: (r.started_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    cancelledAt: (r.cancelled_at as string | null) ?? null,
    createdAt: r.created_at as string,
    audienceEstimate: n("audience_estimate"),
    counts: { total: n("count_total"), queued: n("count_queued"), accepted: n("count_accepted"), sent: n("count_sent"), delivered, read, failed: n("count_failed"), skipped: n("count_skipped") },
    delivery: { delivered: delivered + read, ofAccepted: n("count_accepted") },
    costEstimate: estimateCost(category, delivered + read, card),
  };
}

export async function getBroadcast(accountId: string, id: string): Promise<BroadcastView | null> {
  const { data, error } = await supabase.from("whatsapp_broadcasts").select(BROADCAST_COLUMNS).eq("id", id).eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(`broadcast lookup failed: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const cards = await loadRateCards(accountId, [row.social_account_id as string]);
  return toView(row, cards.get(row.social_account_id as string) ?? null);
}

export async function listBroadcasts(accountId: string, opts: { socialAccountId?: string; limit: number; before?: string }): Promise<{ broadcasts: BroadcastView[]; nextBefore: string | null }> {
  let q = supabase.from("whatsapp_broadcasts").select(BROADCAST_COLUMNS).eq("account_id", accountId);
  if (opts.socialAccountId) q = q.eq("social_account_id", opts.socialAccountId);
  if (opts.before) q = q.lt("created_at", opts.before);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(opts.limit);
  if (error) throw new Error(`broadcast list failed: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const cards = await loadRateCards(accountId, [...new Set(rows.map((r) => r.social_account_id as string))]);
  return {
    broadcasts: rows.map((r) => toView(r, cards.get(r.social_account_id as string) ?? null)),
    nextBefore: rows.length === opts.limit ? (rows[rows.length - 1].created_at as string) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------------------------------

export type CancelOutcome = { ok: true; status: "cancelled" } | { ok: false; code: "not_found" | "not_cancellable" };

/** Cancels a scheduled, sending or paused broadcast. A sending one stops handing out recipients at once (the claim only serves
 *  a 'sending' broadcast) and everything still queued is skipped. Messages already handed to Meta cannot be recalled. */
export async function cancelBroadcast(accountId: string, id: string, now: Date = new Date()): Promise<CancelOutcome> {
  const { data: found, error: findError } = await supabase.from("whatsapp_broadcasts").select("id, status").eq("id", id).eq("account_id", accountId).maybeSingle();
  if (findError) throw new Error(`broadcast lookup failed: ${findError.message}`);
  if (!found) return { ok: false, code: "not_found" };
  const at = now.toISOString();
  const { data: changed, error } = await supabase
    .from("whatsapp_broadcasts")
    .update({ status: "cancelled", cancelled_at: at, updated_at: at })
    .eq("id", id)
    .eq("account_id", accountId)
    .in("status", ["scheduled", "sending", "paused"])
    .select("id");
  if (error) throw new Error(`broadcast cancel failed: ${error.message}`);
  if (((changed as unknown[] | null) ?? []).length === 0) return { ok: false, code: "not_cancellable" };
  const skip = await supabase.from("whatsapp_broadcast_recipients").update({ status: "skipped", skip_reason: "broadcast_cancelled", updated_at: at }).eq("broadcast_id", id).eq("status", "queued");
  if (skip.error) throw new Error(`recipient skip failed: ${skip.error.message}`);
  await refreshCounts(id);
  return { ok: true, status: "cancelled" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------------------------------

async function countRecipients(broadcastId: string, filter: (q: any) => any): Promise<number> {
  const { count, error } = await filter(supabase.from("whatsapp_broadcast_recipients").select("id", { count: "exact", head: true }).eq("broadcast_id", broadcastId));
  if (error) throw new Error(`recipient count failed: ${error.message}`);
  return count ?? 0;
}

/** Recounts a broadcast's recipients from the source rows and stores the totals on the broadcast. Recomputed from scratch every
 *  time, so a lost or repeated update can never leave a wrong number behind for long. */
export async function refreshCounts(broadcastId: string): Promise<void> {
  const status = (s: string[]) => (q: any) => q.in("status", s);
  const [total, queued, accepted, sent, delivered, read, failed, skipped] = await Promise.all([
    countRecipients(broadcastId, (q) => q),
    countRecipients(broadcastId, status(["queued", "claimed"])),
    countRecipients(broadcastId, (q) => q.not("handed_off_at", "is", null)),
    countRecipients(broadcastId, status(["sent"])),
    countRecipients(broadcastId, status(["delivered"])),
    countRecipients(broadcastId, status(["read"])),
    countRecipients(broadcastId, status(["failed"])),
    countRecipients(broadcastId, status(["skipped"])),
  ]);
  const { error } = await supabase
    .from("whatsapp_broadcasts")
    .update({ count_total: total, count_queued: queued, count_accepted: accepted, count_sent: sent, count_delivered: delivered, count_read: read, count_failed: failed, count_skipped: skipped, updated_at: new Date().toISOString() })
    .eq("id", broadcastId);
  if (error) throw new Error(`counter save failed: ${error.message}`);
}
