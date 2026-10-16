// The read side and the helpers of two-way WhatsApp: the inbox, a thread, the approvals list, saved audiences and short update lines
// sent to an audience. Everything is scoped to ONE account (an explicit account_id filter on every query). Nothing returned holds a
// phone number: a person is shown by a mask (and the name they gave WhatsApp). Message bodies and approval titles are decrypted here,
// for the signed-in customer only, and never logged.

import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { cleanDisplayName } from "../whatsappContacts.js";
import { decryptBody, decryptTitle } from "./chatVault.js";
import { serviceWindow, type ServiceWindow } from "./window.js";
import { sendChatTemplate, sendChatText, type ChatSendContext, type ChatSendOutcome } from "./chatSend.js";
import type { ApprovalOption, ApprovalStatus } from "./approvalOptions.js";
import { MAX_TEXT_CHARS, type HttpClient } from "../whatsappBroadcast/cloudApi.js";

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`${what}: ${error.message}`);
};

/** Shown in place of a body that cannot be decrypted (a missing or rotated key). */
export const UNREADABLE = "[This message could not be read]";

// ---------------------------------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------------------------------

export interface ConversationView {
  id: string;
  socialAccountId: string;
  contactDisplay: string;
  displayName: string | null;
  /** True when this person is a saved contact (they can be sent a template); false for someone who messaged first. */
  isContact: boolean;
  unreadCount: number;
  lastMessageAt: string;
  window: ServiceWindow;
}

const CONVERSATION_COLUMNS = "id, social_account_id, contact_display, display_name, contact_id, last_inbound_at, last_message_at, unread_count";

function toConversation(r: Record<string, unknown>, now: Date): ConversationView {
  return {
    id: r.id as string,
    socialAccountId: r.social_account_id as string,
    contactDisplay: r.contact_display as string,
    displayName: (r.display_name as string | null) ?? null,
    isContact: !!r.contact_id,
    unreadCount: Number(r.unread_count ?? 0),
    lastMessageAt: r.last_message_at as string,
    window: serviceWindow((r.last_inbound_at as string | null) ?? null, now),
  };
}

export async function listConversations(accountId: string, opts: { socialAccountId?: string; limit: number; before?: string }, now: Date = new Date()): Promise<{ conversations: ConversationView[]; nextBefore: string | null }> {
  let q = supabase.from("whatsapp_conversations").select(CONVERSATION_COLUMNS).eq("account_id", accountId);
  if (opts.socialAccountId) q = q.eq("social_account_id", opts.socialAccountId);
  if (opts.before) q = q.lt("last_message_at", opts.before);
  const { data, error } = await q.order("last_message_at", { ascending: false }).limit(opts.limit);
  if (error) fail("conversation list failed", error);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return { conversations: rows.map((r) => toConversation(r, now)), nextBefore: rows.length === opts.limit ? (rows[rows.length - 1].last_message_at as string) : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------------------------------------------------

export interface ApprovalView {
  id: string;
  title: string;
  options: ApprovalOption[];
  status: ApprovalStatus;
  responseOptionId: string | null;
  responseTitle: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export interface MessageView {
  id: string;
  direction: "inbound" | "outbound";
  kind: string;
  text: string;
  status: string;
  failureReason: string | null;
  occurredAt: string;
  handedOffAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  templateName: string | null;
  approval: ApprovalView | null;
}

const MESSAGE_COLUMNS = "id, direction, kind, body_ciphertext, status, failure_reason, occurred_at, handed_off_at, sent_at, delivered_at, read_at, template_name";
const APPROVAL_COLUMNS = "id, conversation_id, message_id, title_ciphertext, options, status, response_option_id, response_title, responded_at, created_at";

function readText(accountId: string, conversationId: string, envelope: unknown): string {
  try {
    return decryptBody(accountId, conversationId, String(envelope));
  } catch {
    return UNREADABLE;
  }
}
function readTitle(accountId: string, conversationId: string, envelope: unknown): string {
  try {
    return decryptTitle(accountId, conversationId, String(envelope));
  } catch {
    return UNREADABLE;
  }
}

function toApproval(accountId: string, conversationId: string, r: Record<string, unknown>): ApprovalView {
  return {
    id: r.id as string,
    title: readTitle(accountId, conversationId, r.title_ciphertext),
    options: Array.isArray(r.options) ? (r.options as ApprovalOption[]) : [],
    status: r.status as ApprovalStatus,
    responseOptionId: (r.response_option_id as string | null) ?? null,
    responseTitle: (r.response_title as string | null) ?? null,
    respondedAt: (r.responded_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export async function getThread(accountId: string, conversationId: string, opts: { limit: number; before?: string }, now: Date = new Date()): Promise<{ conversation: ConversationView; messages: MessageView[] } | null> {
  const c = await supabase.from("whatsapp_conversations").select(CONVERSATION_COLUMNS).eq("id", conversationId).eq("account_id", accountId).maybeSingle();
  if (c.error) fail("conversation lookup failed", c.error);
  if (!c.data) return null;

  let q = supabase.from("whatsapp_chat_messages").select(MESSAGE_COLUMNS).eq("account_id", accountId).eq("conversation_id", conversationId);
  if (opts.before) q = q.lt("occurred_at", opts.before);
  const m = await q.order("occurred_at", { ascending: false }).limit(opts.limit);
  if (m.error) fail("message list failed", m.error);
  const rows = [...((m.data ?? []) as Array<Record<string, unknown>>)].reverse();

  const a = await supabase.from("whatsapp_approval_requests").select(APPROVAL_COLUMNS).eq("account_id", accountId).eq("conversation_id", conversationId);
  if (a.error) fail("approval lookup failed", a.error);
  const byMessage = new Map<string, ApprovalView>();
  for (const r of (a.data ?? []) as Array<Record<string, unknown>>) byMessage.set(r.message_id as string, toApproval(accountId, conversationId, r));

  return {
    conversation: toConversation(c.data as Record<string, unknown>, now),
    messages: rows.map((r) => ({
      id: r.id as string,
      direction: r.direction as "inbound" | "outbound",
      kind: r.kind as string,
      text: readText(accountId, conversationId, r.body_ciphertext),
      status: r.status as string,
      failureReason: (r.failure_reason as string | null) ?? null,
      occurredAt: r.occurred_at as string,
      handedOffAt: (r.handed_off_at as string | null) ?? null,
      sentAt: (r.sent_at as string | null) ?? null,
      deliveredAt: (r.delivered_at as string | null) ?? null,
      readAt: (r.read_at as string | null) ?? null,
      templateName: (r.template_name as string | null) ?? null,
      approval: byMessage.get(r.id as string) ?? null,
    })),
  };
}

export async function markRead(accountId: string, conversationId: string): Promise<boolean> {
  const { data, error } = await supabase.from("whatsapp_conversations").update({ unread_count: 0 }).eq("id", conversationId).eq("account_id", accountId).select("id");
  if (error) fail("mark read failed", error);
  return ((data as unknown[] | null) ?? []).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Start a conversation with a saved contact
// ---------------------------------------------------------------------------------------------------------------------

export type StartOutcome = { ok: true; created: boolean; conversationId: string; contactDisplay: string } | { ok: false; code: "not_found" | "opted_out" | "no_number" };

/** Opens (or finds) the conversation of a saved, opted-in contact. The contact's own encrypted number is reused as it is (same
 *  account and contact key, so the same envelope decrypts). The window starts closed: the first message must be a template. */
export async function startConversation(accountId: string, contactId: string, now: Date = new Date()): Promise<StartOutcome> {
  const c = await supabase
    .from("whatsapp_contacts")
    .select("id, social_account_id, contact_key, contact_display, phone_ciphertext, consent_status, display_name")
    .eq("id", contactId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (c.error) fail("contact lookup failed", c.error);
  const contact = c.data as { id: string; social_account_id: string; contact_key: string; contact_display: string; phone_ciphertext: string | null; consent_status: string; display_name: string | null } | null;
  if (!contact) return { ok: false, code: "not_found" };
  if (contact.consent_status !== "opted_in") return { ok: false, code: "opted_out" };
  if (!contact.phone_ciphertext) return { ok: false, code: "no_number" };

  const existing = await supabase.from("whatsapp_conversations").select("id").eq("account_id", accountId).eq("social_account_id", contact.social_account_id).eq("contact_key", contact.contact_key).maybeSingle();
  if (existing.error) fail("conversation lookup failed", existing.error);
  if (existing.data) return { ok: true, created: false, conversationId: (existing.data as { id: string }).id, contactDisplay: contact.contact_display };

  const at = now.toISOString();
  const id = randomUUID();
  const ins = await supabase.from("whatsapp_conversations").insert({
    id,
    account_id: accountId,
    social_account_id: contact.social_account_id,
    contact_key: contact.contact_key,
    contact_display: contact.contact_display,
    contact_id: contact.id,
    phone_ciphertext: contact.phone_ciphertext,
    display_name: contact.display_name,
    last_inbound_at: null,
    last_message_at: at,
    unread_count: 0,
    created_at: at,
    updated_at: at,
  });
  if (ins.error) fail("conversation save failed", ins.error);
  return { ok: true, created: true, conversationId: id, contactDisplay: contact.contact_display };
}

// ---------------------------------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------------------------------

export interface ApprovalListItem extends ApprovalView {
  conversationId: string;
  messageId: string;
  contactDisplay: string;
  displayName: string | null;
}

const STATUSES: ApprovalStatus[] = ["pending", "approved", "changes_requested", "question", "other_reply"];

export async function listApprovals(accountId: string, opts: { status?: ApprovalStatus; socialAccountId?: string; limit: number }): Promise<{ approvals: ApprovalListItem[]; counts: Record<ApprovalStatus, number> }> {
  let q = supabase.from("whatsapp_approval_requests").select(APPROVAL_COLUMNS).eq("account_id", accountId);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(opts.limit);
  if (error) fail("approval list failed", error);
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  const ids = [...new Set(rows.map((r) => r.conversation_id as string))];
  const convs = new Map<string, { contact_display: string; display_name: string | null; social_account_id: string }>();
  if (ids.length > 0) {
    const c = await supabase.from("whatsapp_conversations").select("id, contact_display, display_name, social_account_id").eq("account_id", accountId).in("id", ids);
    if (c.error) fail("conversation lookup failed", c.error);
    for (const r of (c.data ?? []) as Array<{ id: string; contact_display: string; display_name: string | null; social_account_id: string }>) convs.set(r.id, r);
  }
  const approvals = rows.flatMap((r) => {
    const conv = convs.get(r.conversation_id as string);
    if (!conv || (opts.socialAccountId && conv.social_account_id !== opts.socialAccountId)) return [];
    return [{ ...toApproval(accountId, r.conversation_id as string, r), conversationId: r.conversation_id as string, messageId: r.message_id as string, contactDisplay: conv.contact_display, displayName: conv.display_name }];
  });

  const counts = { pending: 0, approved: 0, changes_requested: 0, question: 0, other_reply: 0 } as Record<ApprovalStatus, number>;
  for (const s of STATUSES) {
    const { count, error: cerr } = await supabase.from("whatsapp_approval_requests").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("status", s);
    if (cerr) fail("approval count failed", cerr);
    counts[s] = count ?? 0;
  }
  return { approvals, counts };
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved audiences
// ---------------------------------------------------------------------------------------------------------------------

export type AudienceResult = { ok: true; id: string } | { ok: false; code: "name_invalid" | "name_taken" | "connection_not_found" };

export async function createAudience(accountId: string, userId: string | null, input: { socialAccountId: string; name: string }): Promise<AudienceResult> {
  const name = cleanDisplayName(input.name);
  if (!name.ok || name.value === null) return { ok: false, code: "name_invalid" };
  const sa = await supabase.from("social_accounts").select("id").eq("id", input.socialAccountId).eq("account_id", accountId).eq("platform", "whatsapp").maybeSingle();
  if (sa.error) fail("connection lookup failed", sa.error);
  if (!sa.data) return { ok: false, code: "connection_not_found" };
  const dup = await supabase.from("whatsapp_audiences").select("id").eq("account_id", accountId).eq("social_account_id", input.socialAccountId).eq("name", name.value).maybeSingle();
  if (dup.error) fail("audience lookup failed", dup.error);
  if (dup.data) return { ok: false, code: "name_taken" };
  const id = randomUUID();
  const ins = await supabase.from("whatsapp_audiences").insert({ id, account_id: accountId, social_account_id: input.socialAccountId, name: name.value, created_by: userId, created_at: new Date().toISOString() });
  if (ins.error) fail("audience save failed", ins.error);
  return { ok: true, id };
}

export interface AudienceView {
  id: string;
  socialAccountId: string;
  name: string;
  memberCount: number;
}

export async function listAudiences(accountId: string, socialAccountId?: string): Promise<AudienceView[]> {
  let q = supabase.from("whatsapp_audiences").select("id, social_account_id, name").eq("account_id", accountId);
  if (socialAccountId) q = q.eq("social_account_id", socialAccountId);
  const { data, error } = await q.order("name", { ascending: true });
  if (error) fail("audience list failed", error);
  const rows = (data ?? []) as Array<{ id: string; social_account_id: string; name: string }>;
  if (rows.length === 0) return [];
  const out: AudienceView[] = [];
  for (const r of rows) {
    // A count query per audience, so a big audience is counted in full (a plain select would stop at the API's page size).
    const { count, error: cerr } = await supabase.from("whatsapp_audience_members").select("contact_id", { count: "exact", head: true }).eq("account_id", accountId).eq("audience_id", r.id);
    if (cerr) fail("member count failed", cerr);
    out.push({ id: r.id, socialAccountId: r.social_account_id, name: r.name, memberCount: count ?? 0 });
  }
  return out;
}

const PAGE = 1000;
const ID_CHUNK = 200;

/** Every member of an audience, read page by page: an audience of any size is read in full. */
async function allMemberIds(accountId: string, audienceId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    let q = supabase.from("whatsapp_audience_members").select("contact_id").eq("audience_id", audienceId).eq("account_id", accountId);
    if (cursor) q = q.gt("contact_id", cursor);
    const { data, error } = await q.order("contact_id", { ascending: true }).limit(PAGE);
    if (error) fail("member lookup failed", error);
    const page = ((data ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id);
    ids.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1];
  }
  return ids;
}

export async function deleteAudience(accountId: string, audienceId: string): Promise<boolean> {
  const { data, error } = await supabase.from("whatsapp_audiences").delete().eq("id", audienceId).eq("account_id", accountId).select("id");
  if (error) fail("audience delete failed", error);
  return ((data as unknown[] | null) ?? []).length > 0;
}

async function ownedAudience(accountId: string, audienceId: string): Promise<{ id: string; social_account_id: string } | null> {
  const { data, error } = await supabase.from("whatsapp_audiences").select("id, social_account_id").eq("id", audienceId).eq("account_id", accountId).maybeSingle();
  if (error) fail("audience lookup failed", error);
  return (data as { id: string; social_account_id: string } | null) ?? null;
}

/** Adds saved contacts of this account and connection who are opted in. Anything else is skipped and counted. */
export async function addAudienceMembers(accountId: string, audienceId: string, contactIds: string[]): Promise<{ ok: true; added: number; skipped: number } | { ok: false; code: "not_found" }> {
  const audience = await ownedAudience(accountId, audienceId);
  if (!audience) return { ok: false, code: "not_found" };
  const ids = [...new Set(contactIds)];
  const eligible: string[] = [];
  // Looked up in chunks (a URL cannot carry thousands of ids), so any number of contacts can be added in one call.
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const c = await supabase.from("whatsapp_contacts").select("id, consent_status, social_account_id").eq("account_id", accountId).in("id", ids.slice(i, i + ID_CHUNK));
    if (c.error) fail("contact lookup failed", c.error);
    for (const r of (c.data ?? []) as Array<{ id: string; consent_status: string; social_account_id: string }>) {
      if (r.consent_status === "opted_in" && r.social_account_id === audience.social_account_id) eligible.push(r.id);
    }
  }
  const existing = new Set(await allMemberIds(accountId, audienceId));
  const toAdd = eligible.filter((id) => !existing.has(id));
  const at = new Date().toISOString();
  for (let i = 0; i < toAdd.length; i += PAGE) {
    const ins = await supabase.from("whatsapp_audience_members").insert(toAdd.slice(i, i + PAGE).map((contact_id) => ({ audience_id: audienceId, contact_id, account_id: accountId, created_at: at })));
    if (ins.error) fail("member save failed", ins.error);
  }
  return { ok: true, added: toAdd.length, skipped: contactIds.length - toAdd.length };
}

export async function removeAudienceMember(accountId: string, audienceId: string, contactId: string): Promise<boolean> {
  const { data, error } = await supabase.from("whatsapp_audience_members").delete().eq("audience_id", audienceId).eq("contact_id", contactId).eq("account_id", accountId).select("contact_id");
  if (error) fail("member delete failed", error);
  return ((data as unknown[] | null) ?? []).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Update lines to an audience
// ---------------------------------------------------------------------------------------------------------------------

export interface UpdateInput {
  /** The short update, sent as free-form text to everyone whose 24 hour window is open. */
  text: string;
  /** For everyone whose window is closed: the approved template to send instead (a saved contact who opted in). */
  templateId?: string;
  params?: string[];
}

export interface UpdateResult {
  contactDisplay: string;
  status: "sent" | "skipped" | "failed" | "not_attempted";
  how?: "text" | "template";
  code?: string;
}

export type UpdateOutcome =
  | { ok: true; summary: { total: number; sent: number; skipped: number; failed: number; notAttempted: number }; results: UpdateResult[] }
  | { ok: false; code: "not_found" | "empty_audience" | "text_invalid"; message: string };

/** Refusals that apply to everyone, not just this person (the plan, the customer's own login, a pause Meta caused): the rest of the
 *  audience is not attempted. There is no limit on how many people an update line can reach. */
const STOP_CODES = new Set(["plan", "no_own_credentials", "connection_unavailable", "connection_paused", "storage_not_ready"]);

export async function sendUpdateToAudience(ctx: ChatSendContext, audienceId: string, input: UpdateInput): Promise<UpdateOutcome> {
  const audience = await ownedAudience(ctx.accountId, audienceId);
  if (!audience) return { ok: false, code: "not_found", message: "That audience was not found." };
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text === "" || text.length > MAX_TEXT_CHARS) return { ok: false, code: "text_invalid", message: "Write an update of up to 4,096 characters." };
  const members = await allMemberIds(ctx.accountId, audienceId);
  if (members.length === 0) return { ok: false, code: "empty_audience", message: "This audience has nobody in it yet." };

  // Count the real requests, to tell a refusal before any request (nothing was sent) from a failure after one.
  let requests = 0;
  const counted: HttpClient = (url, init) => {
    requests += 1;
    return ctx.http(url, init);
  };
  const cctx: ChatSendContext = { ...ctx, http: counted };
  const now = ctx.now ?? new Date();

  const results: UpdateResult[] = [];
  let stopped = false;
  for (const contactId of members) {
    if (stopped) {
      results.push({ contactDisplay: "", status: "not_attempted" });
      continue;
    }
    const started = await startConversation(ctx.accountId, contactId, now);
    if (!started.ok) {
      results.push({ contactDisplay: "", status: "skipped", code: started.code });
      continue;
    }
    const conv = await supabase.from("whatsapp_conversations").select("last_inbound_at").eq("id", started.conversationId).eq("account_id", ctx.accountId).maybeSingle();
    if (conv.error) fail("conversation lookup failed", conv.error);
    const open = serviceWindow((conv.data as { last_inbound_at: string | null } | null)?.last_inbound_at ?? null, now).open;
    if (!open && !input.templateId) {
      results.push({ contactDisplay: started.contactDisplay, status: "skipped", code: "window_closed" });
      continue;
    }
    const before = requests;
    const how: "text" | "template" = open ? "text" : "template";
    const out: ChatSendOutcome = open ? await sendChatText(cctx, started.conversationId, text) : await sendChatTemplate(cctx, started.conversationId, input.templateId!, input.params ?? []);
    if (out.ok) {
      results.push({ contactDisplay: started.contactDisplay, status: "sent", how });
      continue;
    }
    const attempted = requests > before;
    if (STOP_CODES.has(out.code)) {
      stopped = true;
      results.push({ contactDisplay: started.contactDisplay, status: attempted ? "failed" : "not_attempted", how, code: out.code });
      continue;
    }
    results.push({ contactDisplay: started.contactDisplay, status: attempted ? "failed" : "skipped", how, code: out.code });
  }
  const n = (s: UpdateResult["status"]) => results.filter((r) => r.status === s).length;
  return { ok: true, summary: { total: results.length, sent: n("sent"), skipped: n("skipped"), failed: n("failed"), notAttempted: n("not_attempted") }, results };
}
