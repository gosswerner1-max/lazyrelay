// Sending in a two-way conversation: a free-form reply (only inside Meta's 24 hour window), an approved template (any time, only to
// a stored contact who opted in), and an approval request (reply buttons inside the window, a template outside it). Every send goes
// through the SAME gates as a broadcast: a paid plan AND the customer's own stored login, an unpaused connection, and the opt-out and
// suppression rules, all failing closed (there is no volume cap or kill switch of ours). The HTTP client is a fake: nothing reaches Meta.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";
import type { HttpClient } from "../whatsappBroadcast/cloudApi.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("../whatsappBroadcast/testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { sendChatText, sendChatTemplate, sendApprovalRequest, sendChatList } = await import("./chatSend.js");
const { recordInboundChat, extractChatMessages } = await import("./inbound.js");
const { decryptBody, decryptTitle } = await import("./chatVault.js");
const kit = await import("../whatsappBroadcast/testKit.js");
const { ACC, ACC_OTHER, SA, WABA, PHONE_ID, TEMPLATE_ID, TOKEN, seedWorld, resetTables, setTestEnv, addContact, addOptOut } = kit;
const { messageKeyFor } = await import("../platforms/whatsapp/contactPrivacy.js");

const SAVED = { ...process.env };
const NOW = new Date("2026-10-16T12:00:00.000Z");
const HOUR = 3_600_000;
const NUMBER = "27829990001";
let logged: string[] = [];

type Reply = { status: number; json: unknown } | Error;
const ok = (n = 1): Reply => ({ status: 200, json: { messages: [{ id: `wamid.CHATOUT${n}` }] } });
const err = (status: number, code: number): Reply => ({ status, json: { error: { code, message: "text that must never be kept" } } });
function makeHttp(respond: (n: number) => Reply = (n) => ok(n)) {
  const calls: Array<{ body: Record<string, any>; auth: string }> = [];
  const http: HttpClient = async (_u, init) => {
    calls.push({ body: JSON.parse(init.body ?? "{}"), auth: init.headers.Authorization });
    const r = respond(calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { http, calls };
}
const ctx = (http: HttpClient, over: Record<string, unknown> = {}) => ({ accountId: ACC, userId: "33333333-3333-4333-8333-333333333333", http, now: NOW, ...over });

/** A conversation that began with an inbound message `ageMs` before NOW. */
async function conversation(opts: { ageMs?: number; stored?: boolean; number?: string } = {}) {
  const number = opts.number ?? NUMBER;
  if (opts.stored) addContact(`+${number}`);
  const seconds = Math.floor((NOW.getTime() - (opts.ageMs ?? 10 * 60_000)) / 1000);
  const payload = { object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: number, profile: { name: "Pablo" } }], messages: [{ from: number, id: "wamid.HELLO1", timestamp: String(seconds), type: "text", text: { body: "hello" } }] } }] }] };
  await recordInboundChat({ id: SA, account_id: ACC }, extractChatMessages(payload, NOW).messages, NOW);
  return tables.whatsapp_conversations[0];
}
const outbound = () => tables.whatsapp_chat_messages.filter((m) => m.direction === "outbound");

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  logged = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("sendChatText: a free-form reply, only inside the 24 hour window", () => {
  it("sends the text to the person's decrypted number with the customer's OWN token, and records an encrypted outgoing message 'handed off'", async () => {
    const conv = await conversation();
    const h = makeHttp();
    const out = await sendChatText(ctx(h.http), conv.id as string, "Your proof is ready.");
    expect(out).toMatchObject({ ok: true, status: "handed_off" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(h.calls[0].body).toMatchObject({ to: NUMBER, type: "text", text: { body: "Your proof is ready." } });
    const m = outbound()[0];
    expect(m).toMatchObject({ direction: "outbound", kind: "text", status: "handed_off", sent_by: "33333333-3333-4333-8333-333333333333", message_key: messageKeyFor(ACC, "wamid.CHATOUT1"), handed_off_at: NOW.toISOString() });
    expect(decryptBody(ACC, conv.id as string, m.body_ciphertext as string)).toBe("Your proof is ready.");
    expect(JSON.stringify(tables.whatsapp_chat_messages)).not.toMatch(/proof is ready|wamid\./);
    expect(tables.whatsapp_conversations[0].last_message_at).toBe(NOW.toISOString());
  });

  it("refuses OUTSIDE the window, with a plain message and no request to Meta", async () => {
    const conv = await conversation({ ageMs: 24 * HOUR + 1000 });
    const h = makeHttp();
    const out = await sendChatText(ctx(h.http), conv.id as string, "Hello?");
    expect(out).toMatchObject({ ok: false, code: "window_closed" });
    expect((out as { message: string }).message).toMatch(/template/i);
    expect(h.calls).toHaveLength(0);
    expect(outbound()).toHaveLength(0);
  });

  it("the window is measured from the person's LAST message: a newer one reopens it", async () => {
    const conv = await conversation({ ageMs: 30 * HOUR });
    conv.last_inbound_at = new Date(NOW.getTime() - HOUR).toISOString();
    expect((await sendChatText(ctx(makeHttp().http), conv.id as string, "Hi")).ok).toBe(true);
  });

  it.each([
    ["an empty text", "   ", "text_invalid"],
    ["a text over 4096 characters", "x".repeat(4097), "text_invalid"],
  ])("refuses %s", async (_l, text, code) => {
    const conv = await conversation();
    const h = makeHttp();
    expect(await sendChatText(ctx(h.http), conv.id as string, text)).toMatchObject({ ok: false, code });
    expect(h.calls).toHaveLength(0);
  });

  const gates: Array<[string, () => void, string]> = [
    ["a free plan", () => void (tables.subscriptions = []), "plan"],
    ["no stored login", () => void (tables.social_accounts[0].access_token_vault_id = null), "no_own_credentials"],
    ["a paused connection", () => void (tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: NOW.toISOString(), pause_reason: "quality" }]), "connection_paused"],
  ];
  it.each(gates)("is refused by %s, with no request to Meta", async (_l, arrange, code) => {
    const conv = await conversation();
    arrange();
    const h = makeHttp();
    expect(await sendChatText(ctx(h.http), conv.id as string, "hi")).toMatchObject({ ok: false, code });
    expect(h.calls).toHaveLength(0);
  });

  it("a stored contact who opted out is never messaged, even inside the window", async () => {
    const conv = await conversation({ stored: true });
    tables.whatsapp_contacts[0].consent_status = "opted_out";
    const h = makeHttp();
    expect(await sendChatText(ctx(h.http), conv.id as string, "hi")).toMatchObject({ ok: false, code: "opted_out" });
    expect(h.calls).toHaveLength(0);
  });

  it("a suppression row blocks the send too (a number that is not a stored contact, or a contact whose flag lagged)", async () => {
    const conv = await conversation();
    addOptOut({ account_id: ACC, contact_key: conv.contact_key, contact_display: conv.contact_display });
    const h = makeHttp();
    expect(await sendChatText(ctx(h.http), conv.id as string, "hi")).toMatchObject({ ok: false, code: "opted_out" });
    expect(h.calls).toHaveLength(0);
  });

  it("another account's conversation is not found", async () => {
    const conv = await conversation();
    tables.subscriptions.push({ account_id: ACC_OTHER, tier: "business", status: "active" });
    const h = makeHttp();
    expect(await sendChatText(ctx(h.http, { accountId: ACC_OTHER }), conv.id as string, "hi")).toMatchObject({ ok: false, code: "not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("if the contact storage keys are missing nothing is sent", async () => {
    const conv = await conversation();
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    const h = makeHttp();
    expect(await sendChatText(ctx(h.http), conv.id as string, "hi")).toMatchObject({ ok: false, code: "storage_not_ready" });
    expect(h.calls).toHaveLength(0);
  });

  describe("when Meta refuses", () => {
    it("131050 records a permanent opt-out and shows the failed message", async () => {
      const conv = await conversation({ stored: true });
      const out = await sendChatText(ctx(makeHttp(() => err(400, 131050)).http), conv.id as string, "hi");
      expect(out).toMatchObject({ ok: false, code: "recipient_opted_out" });
      expect(tables.whatsapp_opt_outs[0]).toMatchObject({ source: "meta_131050", scope: "marketing" });
      expect(tables.whatsapp_contacts[0].consent_status).toBe("opted_out");
      expect(outbound()[0]).toMatchObject({ status: "failed", failure_reason: "recipient_opted_out", error_code: 131050 });
    });

    it("a restriction or credential code pauses the whole connection", async () => {
      const conv = await conversation();
      await sendChatText(ctx(makeHttp(() => err(400, 131048)).http), conv.id as string, "hi");
      expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ pause_reason: "quality", meta_error_code: 131048 });
      expect(await sendChatText(ctx(makeHttp().http), conv.id as string, "again")).toMatchObject({ ok: false, code: "connection_paused" });
    });

    it("a transient error is NOT retried automatically: the failed message is shown so the person can send it again", async () => {
      const conv = await conversation();
      const h = makeHttp(() => ({ status: 503, json: null }));
      expect(await sendChatText(ctx(h.http), conv.id as string, "hi")).toMatchObject({ ok: false, code: "try_again" });
      expect(h.calls).toHaveLength(1);
      expect(outbound()[0]).toMatchObject({ status: "failed", failure_reason: "transient_error" });
    });

    it("no answer at all is shown as unconfirmed, never retried", async () => {
      const conv = await conversation();
      const h = makeHttp(() => new Error("socket hang up"));
      expect(await sendChatText(ctx(h.http), conv.id as string, "hi")).toMatchObject({ ok: false, code: "unconfirmed" });
      expect(outbound()[0]).toMatchObject({ status: "failed", failure_reason: "unconfirmed_no_response" });
    });

    it("never logs a number, a token, a message body or Meta's error text", async () => {
      const conv = await conversation();
      await sendChatText(ctx(makeHttp(() => err(400, 131026)).http), conv.id as string, "very private text");
      const all = logged.join("\n");
      expect(all).not.toMatch(new RegExp(`${NUMBER}|very private|must never be kept`));
      expect(all).not.toContain(TOKEN);
    });
  });
});

describe("sendChatTemplate: an approved template, any time, only to a stored contact who opted in", () => {
  it("sends it outside the window and records the filled-in text (encrypted) as a template message", async () => {
    const conv = await conversation({ stored: true, ageMs: 48 * HOUR });
    const h = makeHttp();
    const out = await sendChatTemplate(ctx(h.http), conv.id as string, TEMPLATE_ID, ["Pablo", "20%"]);
    expect(out).toMatchObject({ ok: true });
    expect(h.calls[0].body).toMatchObject({ to: NUMBER, type: "template", template: { name: "spring_offer", language: { code: "en_US" } } });
    const m = outbound()[0];
    expect(m).toMatchObject({ kind: "template", template_name: "spring_offer", status: "handed_off" });
    expect(decryptBody(ACC, conv.id as string, m.body_ciphertext as string)).toBe("Hi Pablo, 20% off today");
  });

  it("a person who is NOT a stored, opted-in contact can never be sent a template (no opt-in on record)", async () => {
    const conv = await conversation({ ageMs: 48 * HOUR });
    const h = makeHttp();
    expect(await sendChatTemplate(ctx(h.http), conv.id as string, TEMPLATE_ID, ["Pablo", "20%"])).toMatchObject({ ok: false, code: "no_opt_in" });
    expect(h.calls).toHaveLength(0);
  });

  it("a marketing template never goes to a US (+1) number; a utility one may", async () => {
    const conv = await conversation({ stored: true, ageMs: 48 * HOUR, number: "14155550100" });
    const h = makeHttp();
    expect(await sendChatTemplate(ctx(h.http), conv.id as string, TEMPLATE_ID, ["a", "b"])).toMatchObject({ ok: false, code: "us_marketing_blocked" });
    tables.whatsapp_message_templates[0].category = "utility";
    expect((await sendChatTemplate(ctx(h.http), conv.id as string, TEMPLATE_ID, ["a", "b"])).ok).toBe(true);
  });

  it.each([
    ["a pending template", () => void (tables.whatsapp_message_templates[0].status = "pending"), ["a", "b"], "template_unusable"],
    ["an unsupported template", () => void (tables.whatsapp_message_templates[0].supported = false), ["a", "b"], "template_unusable"],
    ["too few variables", () => {}, ["a"], "params_mismatch"],
    ["a blank variable", () => {}, ["a", " "], "params_mismatch"],
  ])("refuses %s", async (_l, arrange, params, code) => {
    const conv = await conversation({ stored: true, ageMs: 48 * HOUR });
    arrange();
    const h = makeHttp();
    expect(await sendChatTemplate(ctx(h.http), conv.id as string, TEMPLATE_ID, params as string[])).toMatchObject({ ok: false, code });
    expect(h.calls).toHaveLength(0);
  });

  it("a template of another connection is not found", async () => {
    const conv = await conversation({ stored: true, ageMs: 48 * HOUR });
    tables.whatsapp_message_templates[0].social_account_id = SA_OTHER_ID;
    expect(await sendChatTemplate(ctx(makeHttp().http), conv.id as string, TEMPLATE_ID, ["a", "b"])).toMatchObject({ ok: false, code: "template_not_found" });
  });

  it("goes through the same plan and opt-out gates", async () => {
    const conv = await conversation({ stored: true, ageMs: 48 * HOUR });
    tables.subscriptions = [];
    expect(await sendChatTemplate(ctx(makeHttp().http), conv.id as string, TEMPLATE_ID, ["a", "b"])).toMatchObject({ ok: false, code: "plan" });
    tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
    tables.whatsapp_contacts[0].consent_status = "opted_out";
    expect(await sendChatTemplate(ctx(makeHttp().http), conv.id as string, TEMPLATE_ID, ["a", "b"])).toMatchObject({ ok: false, code: "opted_out" });
  });
});
const SA_OTHER_ID = "22222222-2222-4222-8222-222222222222";

describe("sendApprovalRequest: reply buttons inside the window, a template outside it", () => {
  it("inside the window sends 3 reply buttons and records a PENDING approval with an encrypted title", async () => {
    const conv = await conversation();
    const h = makeHttp();
    const out = await sendApprovalRequest(ctx(h.http), conv.id as string, { title: "Logo proof v2", body: "Please review the logo proof and choose an option." });
    expect(out).toMatchObject({ ok: true, mode: "buttons" });
    expect(h.calls[0].body.interactive).toMatchObject({ type: "button", body: { text: "Please review the logo proof and choose an option." }, action: { buttons: [{ reply: { id: "approve", title: "Approve" } }, { reply: { id: "changes", title: "Request changes" } }, { reply: { id: "question", title: "Question" } }] } });
    const msg = outbound()[0];
    expect(msg).toMatchObject({ kind: "interactive_buttons", status: "handed_off", message_key: messageKeyFor(ACC, "wamid.CHATOUT1") });
    const ap = tables.whatsapp_approval_requests[0];
    expect(ap).toMatchObject({ account_id: ACC, conversation_id: conv.id, message_id: msg.id, status: "pending" });
    expect(ap.options).toEqual([{ id: "approve", title: "Approve" }, { id: "changes", title: "Request changes" }, { id: "question", title: "Question" }]);
    expect(decryptTitle(ACC, conv.id as string, ap.title_ciphertext as string)).toBe("Logo proof v2");
    expect(JSON.stringify(tables.whatsapp_approval_requests)).not.toContain("Logo proof");
  });

  it("custom options are allowed up to Meta's limits (3 buttons, titles up to 20 and unique)", async () => {
    const conv = await conversation();
    const h = makeHttp();
    const options = [{ id: "yes", title: "Looks good" }, { id: "no", title: "Not yet" }];
    expect((await sendApprovalRequest(ctx(h.http), conv.id as string, { title: "T", body: "B", options })).ok).toBe(true);
    for (const bad of [[], [...options, { id: "c", title: "Three" }, { id: "d", title: "Four" }], [{ id: "a", title: "x".repeat(21) }], [{ id: "a", title: "Same" }, { id: "b", title: "same" }]]) {
      expect(await sendApprovalRequest(ctx(h.http), conv.id as string, { title: "T", body: "B", options: bad })).toMatchObject({ ok: false, code: "options_invalid" });
    }
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a missing title, a missing or over-long body", async () => {
    const conv = await conversation();
    const h = makeHttp();
    for (const over of [{ title: " " }, { title: "t".repeat(61) }, { body: " " }, { body: "b".repeat(1025) }]) {
      expect(await sendApprovalRequest(ctx(h.http), conv.id as string, { title: "T", body: "B", ...over })).toMatchObject({ ok: false, code: "request_invalid" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("OUTSIDE the window buttons cannot be sent: a template is required, and without one it is refused", async () => {
    const conv = await conversation({ stored: true, ageMs: 48 * HOUR });
    const h = makeHttp();
    const out = await sendApprovalRequest(ctx(h.http), conv.id as string, { title: "T", body: "B" });
    expect(out).toMatchObject({ ok: false, code: "window_closed_template_required" });
    expect(h.calls).toHaveLength(0);
  });

  it("outside the window it is sent as the chosen approved template, and the request is recorded as pending", async () => {
    const conv = await conversation({ stored: true, ageMs: 48 * HOUR });
    const h = makeHttp();
    const out = await sendApprovalRequest(ctx(h.http), conv.id as string, { title: "Logo proof v2", body: "unused when a template is used", templateId: TEMPLATE_ID, params: ["Pablo", "20%"] });
    expect(out).toMatchObject({ ok: true, mode: "template" });
    expect(h.calls[0].body.type).toBe("template");
    expect(tables.whatsapp_approval_requests[0]).toMatchObject({ status: "pending", message_id: outbound()[0].id });
  });

  it("is refused by the same gates (plan, a pause Meta caused, opt-out)", async () => {
    const conv = await conversation();
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: NOW.toISOString(), pause_reason: "quality" }];
    expect(await sendApprovalRequest(ctx(makeHttp().http), conv.id as string, { title: "T", body: "B" })).toMatchObject({ ok: false, code: "connection_paused" });
    expect(tables.whatsapp_approval_requests).toHaveLength(0);
  });

  it("a failed send leaves no pending approval behind", async () => {
    const conv = await conversation();
    await sendApprovalRequest(ctx(makeHttp(() => err(400, 131026)).http), conv.id as string, { title: "T", body: "B" });
    expect(tables.whatsapp_approval_requests).toHaveLength(0);
    expect(outbound()[0].status).toBe("failed");
  });
});

describe("sendChatList: list messages inside the window", () => {
  const sections = [{ title: "Updates", rows: [{ id: "r1", title: "Design" }, { id: "r2", title: "Content" }] }];

  it("sends a list inside the window and records it", async () => {
    const conv = await conversation();
    const h = makeHttp();
    expect(await sendChatList(ctx(h.http), conv.id as string, { body: "Pick a topic", buttonLabel: "Topics", sections })).toMatchObject({ ok: true });
    expect(h.calls[0].body.interactive.type).toBe("list");
    expect(outbound()[0]).toMatchObject({ kind: "interactive_list", status: "handed_off" });
  });

  it("refuses outside the window, and refuses an invalid list", async () => {
    const closed = await conversation({ ageMs: 30 * HOUR });
    const h = makeHttp();
    expect(await sendChatList(ctx(h.http), closed.id as string, { body: "x", buttonLabel: "Open", sections })).toMatchObject({ ok: false, code: "window_closed" });
    closed.last_inbound_at = new Date(NOW.getTime() - HOUR).toISOString();
    expect(await sendChatList(ctx(h.http), closed.id as string, { body: "x", buttonLabel: "Open", sections: [{ title: "S", rows: [] }] })).toMatchObject({ ok: false, code: "list_invalid" });
    expect(h.calls).toHaveLength(0);
  });
});
