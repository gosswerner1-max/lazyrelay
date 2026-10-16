// Inbound chat messages (two-way WhatsApp): what is read out of a delivery, and what is stored for it. Bodies and numbers only as
// AES-GCM envelopes, a repeated delivery is a no-op, a person who is not a stored contact still gets a conversation (so they can be
// answered inside Meta's 24 hour window) but is NEVER added to the contact list, a STOP-style message still opts the number out, and
// a button or list tap is matched to the approval request it answers. Supabase is the in-memory fake; nothing reaches a network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("../whatsappBroadcast/testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { extractChatMessages, recordInboundChat } = await import("./inbound.js");
const { DEFAULT_APPROVAL_OPTIONS } = await import("./approvalOptions.js");
const { decryptBody } = await import("./chatVault.js");
const { decryptPhone } = await import("../platforms/whatsapp/phoneVault.js");
const kit = await import("../whatsappBroadcast/testKit.js");
const { ACC, ACC_OTHER, SA, WABA, PHONE_ID, seedWorld, resetTables, setTestEnv, addContact } = kit;
const { messageKeyFor, contactKeyFor } = await import("../platforms/whatsapp/contactPrivacy.js");

const SAVED = { ...process.env };
const NOW = new Date("2026-10-16T12:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000) - 60;
const account = { id: SA, account_id: ACC };

function payload(messages: unknown[], contacts: unknown[] = [{ wa_id: "27829990001", profile: { name: "Pablo" } }]) {
  return { object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "27820000000", phone_number_id: PHONE_ID }, contacts, messages } }] }] };
}
const text = (id: string, body: string, over: Record<string, unknown> = {}) => ({ from: "27829990001", id, timestamp: String(T), type: "text", text: { body }, ...over });
const read = (p: unknown) => extractChatMessages(p, NOW).messages;

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("extractChatMessages", () => {
  it("reads every message of a full Meta batch (up to 1,000 updates) and skips none", () => {
    const many = Array.from({ length: 1000 }, (_, i) => text(`wamid.B${String(i).padStart(5, "0")}`, `m${i}`));
    const out = extractChatMessages(payload(many), NOW);
    expect(out.messages).toHaveLength(1000);
    expect(out.skipped).toBe(0);
  });

  it("reads a text message, with the sender's profile name", () => {
    expect(read(payload([text("wamid.A1234", "Hello there")]))).toEqual([
      { wabaId: WABA, phoneNumberId: PHONE_ID, from: "27829990001", wamid: "wamid.A1234", name: "Pablo", at: new Date(T * 1000), kind: "text", text: "Hello there", contextWamid: null, interaction: null },
    ]);
  });

  it("reads a reply-button tap with the id and title of the button and the message it answers", () => {
    const m = read(payload([{ from: "27829990001", id: "wamid.B1234", timestamp: String(T), type: "interactive", context: { from: "27820000000", id: "wamid.OUT1" }, interactive: { type: "button_reply", button_reply: { id: "approve", title: "Approve" } } }]))[0];
    expect(m).toMatchObject({ kind: "button_reply", text: "Approve", contextWamid: "wamid.OUT1", interaction: { id: "approve", title: "Approve" } });
  });

  it("reads a list selection", () => {
    const m = read(payload([{ from: "27829990001", id: "wamid.C1234", timestamp: String(T), type: "interactive", context: { id: "wamid.OUT2" }, interactive: { type: "list_reply", list_reply: { id: "row1", title: "Option one", description: "d" } } }]))[0];
    expect(m).toMatchObject({ kind: "list_reply", text: "Option one", interaction: { id: "row1", title: "Option one" } });
  });

  it("reads a template quick-reply tap (type 'button') as a button reply", () => {
    const m = read(payload([{ from: "27829990001", id: "wamid.D1234", timestamp: String(T), type: "button", context: { id: "wamid.OUT3" }, button: { payload: "Approve", text: "Approve" } }]))[0];
    expect(m).toMatchObject({ kind: "button_reply", text: "Approve", contextWamid: "wamid.OUT3", interaction: { id: "Approve", title: "Approve" } });
  });

  it("a media or other message is kept as a plain placeholder naming only the type, never its content", () => {
    const m = read(payload([{ from: "27829990001", id: "wamid.E1234", timestamp: String(T), type: "image", image: { id: "123", caption: "secret caption" } }]))[0];
    expect(m).toMatchObject({ kind: "unsupported", text: "[image message: open WhatsApp to view it]" });
    expect(JSON.stringify(m)).not.toContain("secret caption");
  });

  it("ignores reactions, and skips anything malformed, empty or with a bad id", () => {
    const out = read(
      payload([
        { from: "27829990001", id: "wamid.F1234", timestamp: String(T), type: "reaction", reaction: { emoji: "x" } },
        text("wamid.G1234", "   "),
        text("bad id!", "hi"),
        text("wamid.H1234", "hi", { from: "not-a-number" }),
        "junk",
        null,
        text("wamid.I1234", "ok"),
      ]),
    );
    expect(out.map((m) => m.wamid)).toEqual(["wamid.I1234"]);
  });

  it("caps a text at 4096 characters and a profile name at 80", () => {
    const m = read(payload([text("wamid.J1234", "x".repeat(5000))], [{ wa_id: "27829990001", profile: { name: "N".repeat(200) } }]))[0];
    expect(m.text).toHaveLength(4096);
    expect(m.name).toHaveLength(80);
  });

  it("is not fooled by a payload that is not a WhatsApp delivery", () => {
    expect(read({ object: "page", entry: [] })).toEqual([]);
    expect(read(null)).toEqual([]);
  });
});

describe("recordInboundChat", () => {
  const record = (messages: Array<ReturnType<typeof read>[number]>) => recordInboundChat(account, messages, NOW);

  it("a message from a number that is NOT a stored contact starts a conversation: encrypted number and body, a mask, unread 1, window open", async () => {
    const out = await record(read(payload([text("wamid.A1234", "Is my logo ready?")])));
    expect(out).toMatchObject({ stored: 1, duplicates: 0 });
    expect(tables.whatsapp_conversations).toHaveLength(1);
    const c = tables.whatsapp_conversations[0];
    expect(c).toMatchObject({ account_id: ACC, social_account_id: SA, contact_id: null, display_name: "Pablo", unread_count: 1, last_inbound_at: new Date(T * 1000).toISOString() });
    expect(c.contact_key).toBe(contactKeyFor(ACC, "27829990001"));
    expect(c.contact_display).toMatch(/\*\*/);
    expect(decryptPhone(ACC, c.contact_key as string, c.phone_ciphertext as string)).toBe("+27829990001");
    const m = tables.whatsapp_chat_messages[0];
    expect(m).toMatchObject({ direction: "inbound", kind: "text", status: "received", conversation_id: c.id, message_key: messageKeyFor(ACC, "wamid.A1234") });
    expect(decryptBody(ACC, c.id as string, m.body_ciphertext as string)).toBe("Is my logo ready?");
  });

  it("stores no plain number, body or message id anywhere", async () => {
    await record(read(payload([text("wamid.A1234", "Is my logo ready?")])));
    const all = JSON.stringify({ c: tables.whatsapp_conversations, m: tables.whatsapp_chat_messages });
    expect(all).not.toMatch(/27829990001|logo ready|wamid\./);
  });

  it("NEVER adds an unknown number to the contact list, and an unknown number is not a marketing contact", async () => {
    await record(read(payload([text("wamid.A1234", "hello")])));
    expect(tables.whatsapp_contacts).toHaveLength(0);
    expect(tables.whatsapp_opt_ins).toHaveLength(0);
  });

  it("links a stored contact's conversation to the contact, and does not touch its consent", async () => {
    const c = addContact("+27829990001");
    await record(read(payload([text("wamid.A1234", "hi")])));
    expect(tables.whatsapp_conversations[0].contact_id).toBe(c.id);
    expect(c.consent_status).toBe("opted_in");
  });

  it("a second message joins the same conversation and counts as unread", async () => {
    await record(read(payload([text("wamid.A1234", "one")])));
    await record(read(payload([text("wamid.B1234", "two", { timestamp: String(T + 30) })])));
    expect(tables.whatsapp_conversations).toHaveLength(1);
    expect(tables.whatsapp_conversations[0]).toMatchObject({ unread_count: 2, last_inbound_at: new Date((T + 30) * 1000).toISOString() });
    expect(tables.whatsapp_chat_messages).toHaveLength(2);
  });

  it("the same delivery again (Meta retries) is a no-op: one message, unread not double-counted", async () => {
    const msgs = read(payload([text("wamid.A1234", "one")]));
    await record(msgs);
    const again = await record(msgs);
    expect(again).toMatchObject({ stored: 0, duplicates: 1 });
    expect(tables.whatsapp_chat_messages).toHaveLength(1);
    expect(tables.whatsapp_conversations[0].unread_count).toBe(1);
  });

  it("the window anchor only moves forward (a late, out-of-order message does not shorten the window)", async () => {
    await record(read(payload([text("wamid.A1234", "new", { timestamp: String(T + 100) })])));
    await record(read(payload([text("wamid.B1234", "old", { timestamp: String(T - 5000) })])));
    expect(tables.whatsapp_conversations[0].last_inbound_at).toBe(new Date((T + 100) * 1000).toISOString());
  });

  it("keeps the keyed hash of the message a reply answers", async () => {
    await record(read(payload([{ from: "27829990001", id: "wamid.B1234", timestamp: String(T), type: "interactive", context: { id: "wamid.OUT1" }, interactive: { type: "button_reply", button_reply: { id: "approve", title: "Approve" } } }])));
    expect(tables.whatsapp_chat_messages[0]).toMatchObject({ kind: "button_reply", reply_to_message_key: messageKeyFor(ACC, "wamid.OUT1") });
  });

  it("a STOP message is still stored, AND opts the number out (also for a number that is not a stored contact)", async () => {
    const c = addContact("+27829990001");
    await record(read(payload([text("wamid.S1234", "STOP")])));
    expect(c.consent_status).toBe("opted_out");
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
    expect(tables.whatsapp_chat_messages).toHaveLength(1);
    await record(read(payload([text("wamid.S2234", "unsubscribe", { from: "27829990002" })], [{ wa_id: "27829990002", profile: { name: "Zed" } }])));
    expect(tables.whatsapp_opt_outs).toHaveLength(2);
  });

  it("with no encryption key or no hash key nothing is stored (fail closed)", async () => {
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    await expect(record(read(payload([text("wamid.A1234", "hi")])))).rejects.toThrow();
    expect(tables.whatsapp_chat_messages).toHaveLength(0);
    process.env.WHATSAPP_CONTACT_ENC_KEY = (await import("node:crypto")).randomBytes(32).toString("base64");
    delete process.env.WHATSAPP_CONTACT_HASH_KEY;
    expect(await record(read(payload([text("wamid.A1234", "hi")])))).toMatchObject({ stored: 0 });
  });
});

describe("approval requests: the client's tap is matched to the request it answers", () => {
  async function seedApproval(options: unknown = DEFAULT_APPROVAL_OPTIONS, over: Record<string, unknown> = {}) {
    // a conversation with one outgoing message that carried the buttons
    await recordInboundChat(account, read(payload([text("wamid.HELLO1", "hi")])), NOW);
    const conv = tables.whatsapp_conversations[0];
    tables.whatsapp_chat_messages.push({ id: "m-out", account_id: ACC, conversation_id: conv.id, direction: "outbound", kind: "interactive_buttons", message_key: messageKeyFor(ACC, "wamid.OUT1"), status: "delivered" });
    tables.whatsapp_approval_requests.push({ id: "ap1", account_id: ACC, conversation_id: conv.id, message_id: "m-out", options, status: "pending", response_option_id: null, response_title: null, responded_at: null, ...over });
  }
  const tap = (id: string, title: string, ctx = "wamid.OUT1", msgId = "wamid.T1234") => ({ from: "27829990001", id: msgId, timestamp: String(T + 5), type: "interactive", context: { id: ctx }, interactive: { type: "button_reply", button_reply: { id, title } } });

  it.each([
    ["approve", "Approve", "approved"],
    ["changes", "Request changes", "changes_requested"],
    ["question", "Question", "question"],
  ])("the '%s' button sets the request to %s and keeps the button id, title and time", async (id, title, status) => {
    await seedApproval();
    await recordInboundChat(account, read(payload([tap(id, title)])), NOW);
    expect(tables.whatsapp_approval_requests[0]).toMatchObject({ status, response_option_id: id, response_title: title, responded_at: new Date((T + 5) * 1000).toISOString() });
    expect(tables.whatsapp_approval_requests[0].response_message_id).toBeTruthy();
  });

  it("a button id that is not one of ours is recorded as 'other_reply', never as an approval", async () => {
    await seedApproval();
    await recordInboundChat(account, read(payload([tap("hack", "Approve everything")])), NOW);
    expect(tables.whatsapp_approval_requests[0].status).toBe("other_reply");
  });

  it("a template quick-reply tap is matched by its title when it carries no id of ours", async () => {
    await seedApproval();
    const quick = { from: "27829990001", id: "wamid.Q1234", timestamp: String(T + 5), type: "button", context: { id: "wamid.OUT1" }, button: { payload: "approve", text: "approve" } };
    await recordInboundChat(account, read(payload([quick])), NOW);
    expect(tables.whatsapp_approval_requests[0].status).toBe("approved");
  });

  it("a tap that answers some other message changes no request", async () => {
    await seedApproval();
    await recordInboundChat(account, read(payload([tap("approve", "Approve", "wamid.SOMETHINGELSE")])), NOW);
    expect(tables.whatsapp_approval_requests[0].status).toBe("pending");
  });

  it("a request of another account is never touched, even for the same message id", async () => {
    await seedApproval(DEFAULT_APPROVAL_OPTIONS, { account_id: ACC_OTHER });
    await recordInboundChat(account, read(payload([tap("approve", "Approve")])), NOW);
    expect(tables.whatsapp_approval_requests[0].status).toBe("pending");
  });

  it("the latest answer wins if the client changes their mind", async () => {
    await seedApproval();
    await recordInboundChat(account, read(payload([tap("approve", "Approve", "wamid.OUT1", "wamid.T1")])), NOW);
    await recordInboundChat(account, read(payload([tap("changes", "Request changes", "wamid.OUT1", "wamid.T2")])), NOW);
    expect(tables.whatsapp_approval_requests[0].status).toBe("changes_requested");
  });
});
