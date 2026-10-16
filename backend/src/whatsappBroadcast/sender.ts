// The broadcast sender loop. A separate loop from the post scheduler on purpose: the scheduler's stuck-post sweep and its 3-retry
// rule cannot cover a send that takes minutes to hours and must never repeat a message. Runs every cycle (index.ts) and does
// nothing unless WHATSAPP_SEND_ENABLED (and the feature flags) are exactly "true".
//
//   1. sweep      a recipient claimed more than 10 minutes ago and never answered (a crash mid-send) is failed as UNCONFIRMED,
//                 never sent again: the message may have gone out.
//   2. hand-off   a due 'scheduled' broadcast becomes 'sending' (one loop wins the conditional update) and gets one recipient row
//                 per opted-in contact. Resumable: a crash part-way leaves recipients_materialised_at empty and the next cycle
//                 finishes the job (the insert ignores rows that already exist).
//   3. send       per 'sending' broadcast: re-check the gates (paid plan AND the customer's own login, the connection not paused
//                 by Meta, template still approved), then claim small batches, one after the other until none are left, with
//                 claim_whatsapp_broadcast_recipients (consent and opt-outs decided in that same SQL step), then, for EACH
//                 recipient, check consent and opt-outs again immediately before the call (the second layer), decrypt the number in
//                 memory, and send the approved template with the customer's own token. Fail closed at every step.
//
// "handed off" means Meta accepted the message and returned a message id. It is NOT delivered; only Meta's receipts say that
// (statusWebhook.ts). Retries: only transient errors, at most 3 (metaErrors.ts). A restriction, quality or credential error pauses
// the connection and the rest of the batch goes back untouched. Nothing here logs a number, a token, or Meta's error text.
//
// There is NO volume cap, no per-day limit and no kill switch of ours: the customer pays Meta directly with their own token. How much
// is sent is bounded only by the audience, the plan gate, the rollout flags and Meta's own answers (a restriction pauses the number).

import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { contactStorageReady } from "../whatsappContacts.js";
import { decryptPhone, PhoneVaultError } from "../platforms/whatsapp/phoneVault.js";
import { messageKeyFor } from "../platforms/whatsapp/contactPrivacy.js";
import { sendEnabled } from "./flags.js";
import { sendTemplate, type HttpClient } from "./cloudApi.js";
import { checkSendEligibility } from "./byok.js";
import { pauseConnection } from "./connectionPause.js";
import { classifyMetaFailure, MAX_TRANSIENT_RETRIES, retryDelayMs } from "./metaErrors.js";
import { isSuppressed, recordOptOutForContact } from "./optOuts.js";
import { refreshCounts } from "./broadcasts.js";
import type { TemplateCategory } from "./templates.js";

export const STUCK_CLAIM_MS = 10 * 60_000;
export const DEFAULT_BATCH_SIZE = 20;
// Page sizes of the queries (how many broadcasts or contacts one read returns), not limits on what can be sent: the next cycle or the
// next page picks up the rest.
const HAND_OFF_LIMIT = 10;
const SENDING_LIMIT = 20;
const MATERIALISE_PAGE = 500;

export interface SenderDeps {
  http: HttpClient;
  now?: () => Date;
  batchSize?: number;
}

export interface CycleSummary {
  ran: boolean;
  handedOff: number;
  failed: number;
  skipped: number;
  retried: number;
}

interface BroadcastRow {
  id: string;
  account_id: string;
  social_account_id: string;
  template_id: string | null;
  template_name: string;
  template_language: string;
  template_category: TemplateCategory;
  template_params: string[];
  status: string;
  scheduled_for: string;
  recipients_materialised_at: string | null;
}

interface ClaimedRow {
  recipient_id: string;
  contact_id: string;
  contact_key: string;
  phone_ciphertext: string;
  country_calling_code: string | null;
  attempt_count: number;
}

const BROADCAST_COLUMNS = "id, account_id, social_account_id, template_id, template_name, template_language, template_category, template_params, status, scheduled_for, recipients_materialised_at";

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`${what}: ${error.message}`);
};
const logError = (what: string, e: unknown) => console.error(`[whatsapp-broadcast] ${what}: ${e instanceof Error ? e.message : "unknown error"}`);

export async function runBroadcastCycle(deps: SenderDeps): Promise<CycleSummary> {
  const summary: CycleSummary = { ran: false, handedOff: 0, failed: 0, skipped: 0, retried: 0 };
  if (!sendEnabled()) return summary;
  // Without both contact keys a number cannot be decrypted and a receipt cannot be matched: do nothing (fail closed).
  if (!contactStorageReady()) return summary;
  summary.ran = true;
  const now = deps.now ?? (() => new Date());

  try {
    await sweepStuckClaims(now());
  } catch (e) {
    logError("stuck-claim sweep failed", e);
  }
  try {
    await handOffDueBroadcasts(now());
  } catch (e) {
    logError("hand-off failed", e);
  }

  const { data, error } = await supabase.from("whatsapp_broadcasts").select(BROADCAST_COLUMNS).eq("status", "sending").order("scheduled_for", { ascending: true }).limit(SENDING_LIMIT);
  if (error) {
    logError("could not list sending broadcasts", error);
    return summary;
  }
  for (const b of (data ?? []) as BroadcastRow[]) {
    try {
      await processSending(b, deps, summary);
    } catch (e) {
      // One broadcast failing never stops the others, and nothing is marked sent that was not.
      logError("broadcast processing stopped", e);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Sweep
// ---------------------------------------------------------------------------------------------------------------------

async function sweepStuckClaims(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STUCK_CLAIM_MS).toISOString();
  const { data, error } = await supabase.from("whatsapp_broadcast_recipients").select("id, broadcast_id").eq("status", "claimed").lt("claimed_at", cutoff).limit(200);
  if (error) fail("stuck claim lookup failed", error);
  const rows = (data ?? []) as Array<{ id: string; broadcast_id: string }>;
  if (rows.length === 0) return;
  const at = now.toISOString();
  const upd = await supabase
    .from("whatsapp_broadcast_recipients")
    .update({ status: "failed", failure_reason: "unconfirmed_after_crash", failed_at: at, updated_at: at })
    .in("id", rows.map((r) => r.id))
    .eq("status", "claimed");
  if (upd.error) fail("stuck claim update failed", upd.error);
  for (const id of new Set(rows.map((r) => r.broadcast_id))) await refreshCounts(id);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Hand-off
// ---------------------------------------------------------------------------------------------------------------------

async function handOffDueBroadcasts(now: Date): Promise<void> {
  const { data, error } = await supabase
    .from("whatsapp_broadcasts")
    .select(BROADCAST_COLUMNS)
    .eq("status", "scheduled")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(HAND_OFF_LIMIT);
  if (error) fail("due broadcast lookup failed", error);
  for (const b of (data ?? []) as BroadcastRow[]) {
    const at = now.toISOString();
    // Only one loop wins this conditional update.
    const won = await supabase.from("whatsapp_broadcasts").update({ status: "sending", started_at: at, updated_at: at }).eq("id", b.id).eq("status", "scheduled").select("id");
    if (won.error) fail("hand-off failed", won.error);
    if (((won.data as unknown[] | null) ?? []).length === 0) continue;
  }
}

async function pauseBroadcast(id: string, reason: string, now: Date): Promise<void> {
  const at = now.toISOString();
  const { error } = await supabase.from("whatsapp_broadcasts").update({ status: "paused", pause_reason: reason, updated_at: at }).eq("id", id).eq("status", "sending");
  if (error) fail("broadcast pause failed", error);
}

/** One recipient per opted-in contact. A marketing broadcast marks US (+1) contacts skipped. Idempotent. */
async function materialise(b: BroadcastRow, now: Date): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    let q = supabase
      .from("whatsapp_contacts")
      .select("id, country_calling_code")
      .eq("account_id", b.account_id)
      .eq("social_account_id", b.social_account_id)
      .eq("consent_status", "opted_in");
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q.order("id", { ascending: true }).limit(MATERIALISE_PAGE);
    if (error) fail("contact page failed", error);
    const contacts = (data ?? []) as Array<{ id: string; country_calling_code: string | null }>;
    if (contacts.length === 0) break;
    const at = now.toISOString();
    const rows = contacts.map((c) => {
      const usMarketing = b.template_category === "marketing" && c.country_calling_code === "1";
      return {
        id: randomUUID(),
        account_id: b.account_id,
        broadcast_id: b.id,
        contact_id: c.id,
        status: usMarketing ? "skipped" : "queued",
        skip_reason: usMarketing ? "us_marketing_blocked" : null,
        attempt_count: 0,
        created_at: at,
        updated_at: at,
      };
    });
    const ins = await supabase.from("whatsapp_broadcast_recipients").upsert(rows, { onConflict: "broadcast_id,contact_id", ignoreDuplicates: true });
    if (ins.error) fail("recipient insert failed", ins.error);
    cursor = contacts[contacts.length - 1].id;
    if (contacts.length < MATERIALISE_PAGE) break;
  }
  const done = await supabase.from("whatsapp_broadcasts").update({ recipients_materialised_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", b.id);
  if (done.error) fail("materialise mark failed", done.error);
  await refreshCounts(b.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Send
// ---------------------------------------------------------------------------------------------------------------------

async function processSending(b: BroadcastRow, deps: SenderDeps, summary: CycleSummary): Promise<void> {
  const now = deps.now ?? (() => new Date());
  if (!b.recipients_materialised_at) await materialise(b, now());

  const eligible = await checkSendEligibility(b.account_id, b.social_account_id);
  if (!eligible.ok) {
    if (eligible.reason === "connection_paused") return; // waits for the customer to resume the number
    await pauseBroadcast(b.id, eligible.reason === "plan" ? "plan" : "connection_unavailable", now());
    return;
  }

  const { data: tdata, error: terr } = await supabase.from("whatsapp_message_templates").select("status, supported").eq("id", b.template_id ?? "").maybeSingle();
  if (terr) fail("template lookup failed", terr);
  const template = tdata as { status: string; supported: boolean } | null;
  if (!template || template.status !== "approved" || template.supported !== true) {
    await pauseBroadcast(b.id, "template_unusable", now());
    return;
  }

  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  // One small batch after another until none is left: no ceiling per cycle. A Meta restriction (sendBatch answers "stop") ends it.
  for (;;) {
    const token = randomUUID();
    const claimed = await supabase.rpc("claim_whatsapp_broadcast_recipients", { p_broadcast_id: b.id, p_limit: Math.min(batchSize, 200), p_claim_token: token });
    if (claimed.error) fail("claim failed", claimed.error);
    const rows = (claimed.data ?? []) as ClaimedRow[];
    if (rows.length === 0) {
      await finishIfDone(b.id, now());
      return;
    }
    const verdict = await sendBatch(b, eligible.bundle, rows, token, deps, summary);
    await refreshCounts(b.id);
    if (verdict === "stop") return;
  }
}

async function finishIfDone(broadcastId: string, now: Date): Promise<void> {
  const { count, error } = await supabase.from("whatsapp_broadcast_recipients").select("id", { count: "exact", head: true }).eq("broadcast_id", broadcastId).in("status", ["queued", "claimed"]);
  if (error) fail("completion check failed", error);
  if ((count ?? 0) > 0) return;
  const at = now.toISOString();
  const upd = await supabase.from("whatsapp_broadcasts").update({ status: "completed", completed_at: at, updated_at: at }).eq("id", broadcastId).eq("status", "sending");
  if (upd.error) fail("completion save failed", upd.error);
  await refreshCounts(broadcastId);
}

type Verdict = "go" | "stop";

async function sendBatch(b: BroadcastRow, bundle: Parameters<typeof sendTemplate>[1], rows: ClaimedRow[], token: string, deps: SenderDeps, summary: CycleSummary): Promise<Verdict> {
  const now = deps.now ?? (() => new Date());
  for (let i = 0; i < rows.length; i++) {
    let verdict: Verdict;
    try {
      verdict = await sendOne(b, bundle, rows[i], token, deps, summary);
    } catch (e) {
      // Anything unexpected before the call (a lookup failed, a key is missing): this recipient and the rest go back untouched,
      // nothing is sent, and the next cycle tries again.
      logError("send stopped before the call", e);
      await releaseClaimed(rows.slice(i), token, now());
      return "stop";
    }
    if (verdict === "stop") {
      await releaseClaimed(rows.slice(i + 1), token, now());
      return "stop";
    }
  }
  return "go";
}

/** Puts claimed-but-unsent recipients back to queued with the attempt they never made taken back. */
async function releaseClaimed(rows: ClaimedRow[], token: string, now: Date): Promise<void> {
  for (const r of rows) {
    const upd = await supabase
      .from("whatsapp_broadcast_recipients")
      .update({ status: "queued", claim_token: null, claimed_at: null, attempt_count: Math.max(0, r.attempt_count - 1), updated_at: now.toISOString() })
      .eq("id", r.recipient_id)
      .eq("claim_token", token)
      .eq("status", "claimed");
    if (upd.error) logError("could not release a recipient", upd.error);
  }
}

/** Updates one claimed recipient; only while this loop still holds the claim. */
async function settle(row: ClaimedRow, token: string, patch: Record<string, unknown>): Promise<void> {
  const upd = await supabase.from("whatsapp_broadcast_recipients").update(patch).eq("id", row.recipient_id).eq("claim_token", token).eq("status", "claimed");
  if (upd.error) fail("recipient update failed", upd.error);
}

async function sendOne(b: BroadcastRow, bundle: Parameters<typeof sendTemplate>[1], row: ClaimedRow, token: string, deps: SenderDeps, summary: CycleSummary): Promise<Verdict> {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const skip = async (reason: string): Promise<Verdict> => {
    await settle(row, token, { status: "skipped", skip_reason: reason, updated_at: at });
    summary.skipped += 1;
    return "go";
  };

  // Still sending? (a cancel or a pause that landed after the claim stops the rest.)
  const live = await supabase.from("whatsapp_broadcasts").select("status").eq("id", b.id).maybeSingle();
  if (live.error) fail("broadcast status lookup failed", live.error);
  if ((live.data as { status: string } | null)?.status !== "sending") {
    await releaseClaimed([row], token, now);
    return "stop";
  }

  // Second layer of the opt-out rule: the live contact and the suppression list, right before the call. Fail closed.
  const found = await supabase.from("whatsapp_contacts").select("id, account_id, contact_key, wa_contact_key, consent_status, country_calling_code").eq("id", row.contact_id).eq("account_id", b.account_id).maybeSingle();
  if (found.error) fail("contact lookup failed", found.error);
  const contact = found.data as { contact_key: string; wa_contact_key: string | null; consent_status: string; country_calling_code: string | null } | null;
  if (!contact || contact.consent_status !== "opted_in" || (await isSuppressed(b.account_id, contact))) return skip("opted_out_at_send");
  if (b.template_category === "marketing" && contact.country_calling_code === "1") return skip("us_marketing_blocked");

  let digits: string;
  try {
    digits = decryptPhone(b.account_id, row.contact_key, row.phone_ciphertext).replace(/\D/g, "");
  } catch (e) {
    if (e instanceof PhoneVaultError && e.code === "key_missing") throw e;
    await settle(row, token, { status: "failed", failure_reason: "contact_unreadable", failed_at: at, updated_at: at });
    summary.failed += 1;
    return "go";
  }

  let outcome;
  try {
    outcome = await sendTemplate(deps.http, bundle, { toDigits: digits, templateName: b.template_name, language: b.template_language, params: b.template_params });
  } catch (e) {
    // A request malformed on OUR side. Shown, not swallowed (the message never carries a number or token).
    logError("a send was refused before it was made", e);
    await settle(row, token, { status: "failed", failure_reason: "internal_error", failed_at: at, updated_at: at });
    summary.failed += 1;
    return "go";
  }

  if (outcome.ok) {
    const messageKey = messageKeyFor(b.account_id, outcome.wamid);
    await settle(row, token, { status: "handed_off", handed_off_at: at, message_key: messageKey, claim_token: null, error_code: null, failure_reason: null, next_attempt_at: null, updated_at: at });
    summary.handedOff += 1;
    return "go";
  }

  const action = classifyMetaFailure("noResponse" in outcome ? { noResponse: true } : { httpStatus: outcome.httpStatus, code: outcome.code });
  const code = "noResponse" in outcome ? null : outcome.code;

  switch (action.kind) {
    case "opt_out":
      await recordOptOutForContact(b.account_id, row.contact_id, { scope: "marketing", source: "meta_131050" }, now);
      await settle(row, token, { status: "failed", failure_reason: action.reason, error_code: code, failed_at: at, updated_at: at });
      summary.failed += 1;
      return "go";
    case "pause_connection":
      await pauseConnection(b.account_id, b.social_account_id, action.pause, code, now);
      await releaseClaimed([row], token, now);
      return "stop";
    case "pause_broadcast":
      await pauseBroadcast(b.id, action.reason, now);
      await releaseClaimed([row], token, now);
      return "stop";
    case "retry":
      if (row.attempt_count - 1 >= MAX_TRANSIENT_RETRIES) {
        await settle(row, token, { status: "failed", failure_reason: "retries_exhausted", error_code: code, failed_at: at, updated_at: at });
        summary.failed += 1;
      } else {
        await settle(row, token, { status: "queued", claim_token: null, claimed_at: null, error_code: code, next_attempt_at: new Date(now.getTime() + retryDelayMs(row.attempt_count)).toISOString(), updated_at: at });
        summary.retried += 1;
      }
      return "go";
    case "recipient_failed":
      await settle(row, token, { status: "failed", failure_reason: action.reason, error_code: code, failed_at: at, updated_at: at });
      summary.failed += 1;
      return "go";
  }
}
