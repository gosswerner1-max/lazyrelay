// Sending in a two-way conversation. Three kinds, all behind the SAME gates a broadcast has, every one failing closed:
//
//   gates      a paid plan AND the customer's own stored login (byok.ts), a connection Meta has not paused, the opt-out and
//              suppression rules, and the contact storage keys. There is NO volume cap and NO kill switch of ours (customers pay Meta
//              directly with their own tokens): any number of messages may be sent.
//   free-form  sendChatText / sendApprovalRequest (buttons) / sendChatList: ONLY inside Meta's 24 hour customer-service window
//              (window.ts). Outside it the call is refused before anything is sent and the screen asks for an approved template.
//   template   sendChatTemplate / sendApprovalRequest (outside the window): an APPROVED, supported template, to a STORED contact who
//              opted in only. A person who merely messaged us first has no opt-in on record, so they can be answered inside the window
//              but never sent a template. A marketing template never goes to a US (+1) number.
//
// There is no retry: a send is one synchronous call. A transient error shows as a failed message the person can send again; a
// request that got no answer shows as unconfirmed (the message may have gone out). Meta's error text is never kept, only its numeric
// code. Nothing here logs a number, a token or a message body.

import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { decryptPhone, PhoneVaultError } from "../platforms/whatsapp/phoneVault.js";
import { messageKeyFor } from "../platforms/whatsapp/contactPrivacy.js";
import { countryCallingCodeOf } from "../platforms/whatsapp/phone.js";
import { checkSendEligibility } from "../whatsappBroadcast/byok.js";
import { pauseConnection } from "../whatsappBroadcast/connectionPause.js";
import { sendInteractiveButtons, sendInteractiveList, sendTemplate, sendText, sanitizeTemplateParam, MAX_TEXT_CHARS, type HttpClient, type ListSection, type ReplyButton, type SendOutcome } from "../whatsappBroadcast/cloudApi.js";
import { classifyMetaFailure } from "../whatsappBroadcast/metaErrors.js";
import { isSuppressed, recordOptOutForContact, recordOptOutForKey } from "../whatsappBroadcast/optOuts.js";
import { encryptBody, encryptTitle } from "./chatVault.js";
import { serviceWindow, type ServiceWindow } from "./window.js";
import { DEFAULT_APPROVAL_OPTIONS, MAX_APPROVAL_BODY, MAX_APPROVAL_TITLE, type ApprovalOption } from "./approvalOptions.js";

export interface ChatSendContext {
  accountId: string;
  /** The signed-in user's id, for the record of who sent it. */
  userId: string | null;
  http: HttpClient;
  now?: Date;
}

export type ChatRefusal = { ok: false; code: string; message: string };
export type ChatSent = { ok: true; messageId: string; status: "handed_off"; window: ServiceWindow; mode: "text" | "buttons" | "list" | "template"; approvalId?: string };
export type ChatSendOutcome = ChatSent | ChatRefusal;

const refuse = (code: string, message: string): ChatRefusal => ({ ok: false, code, message });

const MESSAGES: Record<string, string> = {
  plan: "WhatsApp messaging is available on the Business plan and above.",
  no_own_credentials: "This WhatsApp connection does not hold your own Meta credentials. Reconnect it with your own Meta credentials in Social Platforms.",
  connection_unavailable: "That WhatsApp connection is not available. Check it in Social Platforms.",
  connection_paused: "Sending from this WhatsApp number is paused because of a problem Meta reported. Check your number in Meta Business Manager, then resume it.",
  opted_out: "This person has opted out of WhatsApp messages from you, so nothing can be sent to them.",
  storage_not_ready: "Contact storage is not set up yet.",
  window_closed: "The 24 hour window is closed, so only an approved template can be sent. Pick a template instead.",
  window_closed_template_required: "The 24 hour window is closed, so buttons cannot be sent. Pick an approved template to send this request.",
  no_opt_in: "Templates can only be sent to a saved contact who opted in. This person messaged you first, so you can reply while the 24 hour window is open.",
  us_marketing_blocked: "Meta does not deliver marketing templates to US (+1) numbers.",
  template_not_found: "That template was not found for this WhatsApp number. Sync your templates and pick one again.",
  template_unusable: "Only approved templates that this version supports can be sent.",
  params_mismatch: "Fill in every value this template needs.",
};
const message = (code: string): string => MESSAGES[code] ?? "That could not be sent.";

// ---------------------------------------------------------------------------------------------------------------------
// Shared preparation: every send passes through here
// ---------------------------------------------------------------------------------------------------------------------

interface Prepared {
  conv: { id: string; social_account_id: string; contact_key: string; contact_id: string | null; contact_display: string; phone_ciphertext: string; last_inbound_at: string | null };
  bundle: Parameters<typeof sendText>[1];
  digits: string;
  /** The stored contact, when this person is one, with the consent state read just now. */
  contact: { id: string; consent_status: string } | null;
  window: ServiceWindow;
  now: Date;
}

async function prepare(ctx: ChatSendContext, conversationId: string): Promise<{ ok: true; p: Prepared } | ChatRefusal> {
  const now = ctx.now ?? new Date();
  const found = await supabase
    .from("whatsapp_conversations")
    .select("id, social_account_id, contact_key, contact_id, contact_display, phone_ciphertext, last_inbound_at")
    .eq("id", conversationId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (found.error) throw new Error(`conversation lookup failed: ${found.error.message}`);
  const conv = found.data as Prepared["conv"] | null;
  if (!conv) return refuse("not_found", "That conversation was not found.");

  const eligible = await checkSendEligibility(ctx.accountId, conv.social_account_id);
  if (!eligible.ok) return refuse(eligible.reason, message(eligible.reason));

  // Opt-out, fail closed: a stored contact's live consent, and the hash-only suppression list (any scope).
  let contact: Prepared["contact"] = null;
  let waKey: string | null = null;
  if (conv.contact_id) {
    const c = await supabase.from("whatsapp_contacts").select("id, consent_status, wa_contact_key").eq("id", conv.contact_id).eq("account_id", ctx.accountId).maybeSingle();
    if (c.error) throw new Error(`contact lookup failed: ${c.error.message}`);
    const row = c.data as { id: string; consent_status: string; wa_contact_key: string | null } | null;
    if (!row || row.consent_status !== "opted_in") return refuse("opted_out", message("opted_out"));
    contact = { id: row.id, consent_status: row.consent_status };
    waKey = row.wa_contact_key;
  }
  if (await isSuppressed(ctx.accountId, { contact_key: conv.contact_key, wa_contact_key: waKey })) return refuse("opted_out", message("opted_out"));

  let digits: string;
  try {
    digits = decryptPhone(ctx.accountId, conv.contact_key, conv.phone_ciphertext).replace(/\D/g, "");
  } catch (e) {
    if (e instanceof PhoneVaultError) return refuse("storage_not_ready", message("storage_not_ready"));
    throw e;
  }
  return { ok: true, p: { conv, bundle: eligible.bundle, digits, contact, window: serviceWindow(conv.last_inbound_at, now), now } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Deliver and record
// ---------------------------------------------------------------------------------------------------------------------

interface Deliver {
  kind: "text" | "interactive_buttons" | "interactive_list" | "template";
  mode: ChatSent["mode"];
  /** What the thread shows for this message (stored encrypted). */
  text: string;
  templateName?: string;
  send: () => Promise<SendOutcome>;
}

async function deliver(ctx: ChatSendContext, p: Prepared, d: Deliver): Promise<{ ok: true; messageId: string; sent: ChatSent } | ChatRefusal> {
  let outcome: SendOutcome;
  try {
    outcome = await d.send();
  } catch (e) {
    // A request malformed on OUR side (checked before anything was sent). Shown, never swallowed; it carries no number or token.
    console.error(`[whatsapp-chat] a send was refused before it was made: ${e instanceof Error ? e.message : "unknown error"}`);
    return refuse("request_invalid", e instanceof Error && e.message.startsWith("Refusing to send") ? e.message.replace("Refusing to send: ", "") : "That could not be sent.");
  }

  const at = p.now.toISOString();
  const id = randomUUID();
  const base = {
    id,
    account_id: ctx.accountId,
    conversation_id: p.conv.id,
    direction: "outbound",
    kind: d.kind,
    body_ciphertext: encryptBody(ctx.accountId, p.conv.id, d.text),
    template_name: d.templateName ?? null,
    sent_by: ctx.userId,
    occurred_at: at,
    created_at: at,
  };

  if (outcome.ok) {
    const ins = await supabase.from("whatsapp_chat_messages").insert({ ...base, status: "handed_off", message_key: messageKeyFor(ctx.accountId, outcome.wamid), handed_off_at: at });
    if (ins.error) throw new Error(`message save failed: ${ins.error.message}`);
    const upd = await supabase.from("whatsapp_conversations").update({ last_message_at: at, updated_at: at }).eq("id", p.conv.id);
    if (upd.error) throw new Error(`conversation update failed: ${upd.error.message}`);
    return { ok: true, messageId: id, sent: { ok: true, messageId: id, status: "handed_off", window: p.window, mode: d.mode } };
  }

  // Failure: decide what it means from Meta's numeric code only, record the failed attempt so the thread shows it.
  const noResponse = "noResponse" in outcome;
  const code = "noResponse" in outcome ? null : outcome.code;
  const action = classifyMetaFailure("noResponse" in outcome ? { noResponse: true } : { httpStatus: outcome.httpStatus, code: outcome.code });
  let reason: string;
  let refusal: ChatRefusal;
  switch (action.kind) {
    case "opt_out":
      if (p.contact) await recordOptOutForContact(ctx.accountId, p.contact.id, { scope: "marketing", source: "meta_131050" }, p.now);
      else await recordOptOutForKey(ctx.accountId, p.conv.contact_key, p.conv.contact_display, { scope: "marketing", source: "meta_131050" }, p.now);
      reason = action.reason;
      refusal = refuse("recipient_opted_out", message("opted_out"));
      break;
    case "pause_connection":
      await pauseConnection(ctx.accountId, p.conv.social_account_id, action.pause, code, p.now);
      reason = action.reason;
      refusal = refuse("connection_paused", message("connection_paused"));
      break;
    case "pause_broadcast":
      reason = action.reason;
      refusal = refuse("template_unusable", message("template_unusable"));
      break;
    case "retry":
      reason = "transient_error";
      refusal = refuse("try_again", "WhatsApp could not take that message just now. It was not sent. You can send it again.");
      break;
    case "recipient_failed":
      reason = action.reason;
      refusal = noResponse
        ? refuse("unconfirmed", "WhatsApp did not answer, so we cannot tell if this was sent. Check the chat before sending it again.")
        : code === 131047
          ? refuse("window_closed", message("window_closed"))
          : refuse("send_failed", "WhatsApp did not accept that message.");
      break;
  }
  const ins = await supabase.from("whatsapp_chat_messages").insert({ ...base, status: "failed", error_code: code, failure_reason: reason, failed_at: at });
  if (ins.error) throw new Error(`message save failed: ${ins.error.message}`);
  return refusal;
}

// ---------------------------------------------------------------------------------------------------------------------
// Free-form text
// ---------------------------------------------------------------------------------------------------------------------

export async function sendChatText(ctx: ChatSendContext, conversationId: string, text: string): Promise<ChatSendOutcome> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_TEXT_CHARS) return refuse("text_invalid", "Write a message of up to 4,096 characters.");
  const prep = await prepare(ctx, conversationId);
  if (!prep.ok) return prep;
  const { p } = prep;
  if (!p.window.open) return refuse("window_closed", message("window_closed"));
  const res = await deliver(ctx, p, { kind: "text", mode: "text", text: trimmed, send: () => sendText(ctx.http, p.bundle, { toDigits: p.digits, text: trimmed }) });
  return res.ok ? res.sent : res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------------------------

interface TemplateLookup {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  supported: boolean;
  variable_count: number;
  body_text: string;
}

/** The template's body with its {{1}} style placeholders filled in, as the person will read it. */
export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? "");
}

async function templateSend(ctx: ChatSendContext, p: Prepared, templateId: string, rawParams: string[]): Promise<{ ok: true; deliver: Deliver } | ChatRefusal> {
  if (!p.contact) return refuse("no_opt_in", message("no_opt_in"));
  const t = await supabase
    .from("whatsapp_message_templates")
    .select("id, name, language, category, status, supported, variable_count, body_text")
    .eq("id", templateId)
    .eq("account_id", ctx.accountId)
    .eq("social_account_id", p.conv.social_account_id)
    .maybeSingle();
  if (t.error) throw new Error(`template lookup failed: ${t.error.message}`);
  const template = t.data as TemplateLookup | null;
  if (!template) return refuse("template_not_found", message("template_not_found"));
  if (template.status !== "approved" || template.supported !== true) return refuse("template_unusable", message("template_unusable"));
  const params = rawParams.map((x) => (typeof x === "string" ? sanitizeTemplateParam(x) : ""));
  if (params.length !== template.variable_count || params.some((x) => x === "")) return refuse("params_mismatch", message("params_mismatch"));
  if (template.category === "marketing" && countryCallingCodeOf(p.digits) === "1") return refuse("us_marketing_blocked", message("us_marketing_blocked"));
  return {
    ok: true,
    deliver: {
      kind: "template",
      mode: "template",
      text: renderTemplateBody(template.body_text, params),
      templateName: template.name,
      send: () => sendTemplate(ctx.http, p.bundle, { toDigits: p.digits, templateName: template.name, language: template.language, params }),
    },
  };
}

export async function sendChatTemplate(ctx: ChatSendContext, conversationId: string, templateId: string, params: string[]): Promise<ChatSendOutcome> {
  const prep = await prepare(ctx, conversationId);
  if (!prep.ok) return prep;
  const built = await templateSend(ctx, prep.p, templateId, params);
  if (!built.ok) return built;
  const res = await deliver(ctx, prep.p, built.deliver);
  return res.ok ? res.sent : res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Approval requests
// ---------------------------------------------------------------------------------------------------------------------

export interface ApprovalRequestInput {
  /** A short label of what is being approved, shown in the approvals list. */
  title: string;
  /** The message the client reads, above the buttons. */
  body: string;
  /** Up to 3 buttons; defaults to Approve / Request changes / Question. */
  options?: ReplyButton[];
  /** Outside the 24 hour window: the approved template to send instead. */
  templateId?: string;
  params?: string[];
}

function optionsValid(options: ReplyButton[]): boolean {
  if (!Array.isArray(options) || options.length < 1 || options.length > 3) return false;
  const titles = new Set<string>();
  const ids = new Set<string>();
  for (const o of options) {
    const title = typeof o?.title === "string" ? o.title.trim() : "";
    if (title === "" || title.length > 20 || typeof o.id !== "string" || o.id === "" || o.id.length > 256) return false;
    if (titles.has(title.toLowerCase()) || ids.has(o.id)) return false;
    titles.add(title.toLowerCase());
    ids.add(o.id);
  }
  return true;
}

/** Sends an approval request and records it as PENDING. A convenience record of what the client taps, not legal consent. */
export async function sendApprovalRequest(ctx: ChatSendContext, conversationId: string, input: ApprovalRequestInput): Promise<ChatSendOutcome> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (title === "" || title.length > MAX_APPROVAL_TITLE || body === "" || body.length > MAX_APPROVAL_BODY) {
    return refuse("request_invalid", "Give the request a short title (up to 60 characters) and a message (up to 1,024 characters).");
  }
  const options: ApprovalOption[] = (input.options ?? [...DEFAULT_APPROVAL_OPTIONS]).map((o) => ({ id: o.id, title: o.title.trim() }));
  if (!optionsValid(options)) return refuse("options_invalid", "Use 1 to 3 buttons, each with a title of up to 20 characters, all different.");

  const prep = await prepare(ctx, conversationId);
  if (!prep.ok) return prep;
  const { p } = prep;

  let d: Deliver;
  let mode: "buttons" | "template";
  if (p.window.open) {
    mode = "buttons";
    d = { kind: "interactive_buttons", mode: "buttons", text: body, send: () => sendInteractiveButtons(ctx.http, p.bundle, { toDigits: p.digits, body, options }) };
  } else if (input.templateId) {
    mode = "template";
    const built = await templateSend(ctx, p, input.templateId, input.params ?? []);
    if (!built.ok) return built;
    d = built.deliver;
  } else {
    return refuse("window_closed_template_required", message("window_closed_template_required"));
  }

  const res = await deliver(ctx, p, d);
  if (!res.ok) return res;
  const at = p.now.toISOString();
  const approvalId = randomUUID();
  const ins = await supabase.from("whatsapp_approval_requests").insert({
    id: approvalId,
    account_id: ctx.accountId,
    conversation_id: p.conv.id,
    message_id: res.messageId,
    title_ciphertext: encryptTitle(ctx.accountId, p.conv.id, title),
    options,
    status: "pending",
    created_by: ctx.userId,
    created_at: at,
    updated_at: at,
  });
  if (ins.error) throw new Error(`approval save failed: ${ins.error.message}`);
  return { ...res.sent, mode: mode === "template" ? "template" : "buttons", approvalId };
}

// ---------------------------------------------------------------------------------------------------------------------
// List messages
// ---------------------------------------------------------------------------------------------------------------------

export async function sendChatList(ctx: ChatSendContext, conversationId: string, input: { body: string; buttonLabel: string; sections: ListSection[] }): Promise<ChatSendOutcome> {
  const prep = await prepare(ctx, conversationId);
  if (!prep.ok) return prep;
  const { p } = prep;
  if (!p.window.open) return refuse("window_closed", message("window_closed"));
  const res = await deliver(ctx, p, {
    kind: "interactive_list",
    mode: "list",
    text: input.body.trim(),
    send: () => sendInteractiveList(ctx.http, p.bundle, { toDigits: p.digits, body: input.body, buttonLabel: input.buttonLabel, sections: input.sections }),
  });
  if (res.ok) return res.sent;
  return res.code === "request_invalid" ? refuse("list_invalid", res.message) : res;
}
