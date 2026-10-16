// The inbox, thread, approvals list, saved audiences and project update lines of two-way WhatsApp. Everything is scoped to one account,
// nothing returned holds a phone number (a mask only), bodies are decrypted only here, for the signed-in customer. Supabase is the
// in-memory fake; the HTTP client is a fake.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";
import type { HttpClient } from "../whatsappBroadcast/cloudApi.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("../whatsappBroadcast/testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const svc = await import("./conversations.js");
const { recordInboundChat, extractChatMessages } = await import("./inbound.js");
const { sendApprovalRequest } = await import("./chatSend.js");
const { decryptPhone } = await import("../platforms/whatsapp/phoneVault.js");
const kit = await import("../whatsappBroadcast/testKit.js");
const { ACC, ACC_OTHER, SA, WABA, PHONE_ID, TEMPLATE_ID, seedWorld, resetTables, setTestEnv, addContact } = kit;

const SAVED = { ...process.env };
const NOW = new Date("2026-10-16T12:00:00.000Z");
const HOUR = 3_600_000;
let logged: string[] = [];

function inboundPayload(number: string, text: string, ageMs: number, id: string) {
  return { object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: number, profile: { name: `P${number.slice(-2)}` } }], messages: [{ from: number, id, timestamp: String(Math.floor((NOW.getTime() - ageMs) / 1000)), type: "text", text: { body: text } }] } }] }] };
}
const inbound = (number: string, text: string, ageMs = 10 * 60_000, id = `wamid.IN${number.slice(-4)}`) => recordInboundChat({ id: SA, account_id: ACC }, extractChatMessages(inboundPayload(number, text, ageMs, id), NOW).messages, NOW);
function makeHttp(respond: (n: number) => { status: number; json: unknown } | Error = (n) => ({ status: 200, json: { messages: [{ id: `wamid.UPD${n}` }] } })) {
  const calls: Array<Record<string, any>> = [];
  const http: HttpClient = async (_u, init) => {
    calls.push(JSON.parse(init.body ?? "{}"));
    const r = respond(calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { http, calls };
}
const ctx = (http: HttpClient) => ({ accountId: ACC, userId: "33333333-3333-4333-8333-333333333333", http, now: NOW });

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

describe("listConversations", () => {
  it("lists this account's conversations newest first with a mask, the window state and the unread count, and never a number", async () => {
    await inbound("27829990001", "older", 5 * HOUR, "wamid.A1111");
    await inbound("27829990002", "newer", 10 * 60_000, "wamid.B2222");
    await inbound("27829990003", "closed window", 30 * HOUR, "wamid.C3333");
    tables.whatsapp_conversations.push({ id: "foreign", account_id: ACC_OTHER, social_account_id: SA, contact_key: "f".repeat(64), contact_display: "+27 ** *** 9999", last_message_at: NOW.toISOString() });
    const out = await svc.listConversations(ACC, { socialAccountId: SA, limit: 50 }, NOW);
    expect(out.conversations.map((c) => c.displayName)).toEqual(["P02", "P01", "P03"]);
    expect(out.conversations[0]).toMatchObject({ unreadCount: 1, isContact: false, window: { open: true, hoursLeft: 24 } });
    expect(out.conversations[2].window).toEqual({ open: false, expiresAt: null, hoursLeft: 0 });
    expect(JSON.stringify(out)).not.toMatch(/2782999000|phone_ciphertext|body_ciphertext/);
  });

  it("flags a conversation that belongs to a stored contact, and pages with 'before'", async () => {
    addContact("+27829990001");
    await inbound("27829990001", "hi", 5 * HOUR, "wamid.A1111");
    await inbound("27829990002", "hi", HOUR, "wamid.B2222");
    const page1 = await svc.listConversations(ACC, { limit: 1 }, NOW);
    expect(page1.conversations).toHaveLength(1);
    expect(page1.nextBefore).toBeTruthy();
    const page2 = await svc.listConversations(ACC, { limit: 1, before: page1.nextBefore! }, NOW);
    expect(page2.conversations[0]).toMatchObject({ isContact: true });
  });
});

describe("getThread", () => {
  it("returns the messages oldest first, decrypted for the signed-in customer, with Meta's delivery state per message", async () => {
    await inbound("27829990001", "Is my logo ready?", HOUR, "wamid.A1111");
    const conv = tables.whatsapp_conversations[0];
    const sent = await (await import("./chatSend.js")).sendChatText(ctx(makeHttp().http), conv.id as string, "Yes, sending now.");
    expect(sent.ok).toBe(true);
    tables.whatsapp_chat_messages.find((m) => m.direction === "outbound")!.status = "delivered";
    const t = await svc.getThread(ACC, conv.id as string, { limit: 100 }, NOW);
    expect(t).not.toBeNull();
    expect(t!.messages.map((m) => [m.direction, m.text, m.status])).toEqual([
      ["inbound", "Is my logo ready?", "received"],
      ["outbound", "Yes, sending now.", "delivered"],
    ]);
    expect(t!.conversation).toMatchObject({ id: conv.id, window: { open: true } });
    expect(JSON.stringify(t)).not.toMatch(/2782999000|ciphertext/);
  });

  it("an unreadable body is shown as a placeholder, not an error", async () => {
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    tables.whatsapp_chat_messages[0].body_ciphertext = "v1.k1.AAAA.AAAA.AAAA";
    const t = await svc.getThread(ACC, tables.whatsapp_conversations[0].id as string, { limit: 100 }, NOW);
    expect(t!.messages[0].text).toBe("[This message could not be read]");
  });

  it("another account's conversation is not found", async () => {
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    expect(await svc.getThread(ACC_OTHER, tables.whatsapp_conversations[0].id as string, { limit: 100 }, NOW)).toBeNull();
  });

  it("attaches the approval request (title, options, state, the client's answer) to the message that carried the buttons", async () => {
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    const conv = tables.whatsapp_conversations[0];
    const out = await sendApprovalRequest(ctx(makeHttp().http), conv.id as string, { title: "Logo proof v2", body: "Please review." });
    expect(out.ok).toBe(true);
    tables.whatsapp_approval_requests[0].status = "approved";
    tables.whatsapp_approval_requests[0].response_title = "Approve";
    const t = await svc.getThread(ACC, conv.id as string, { limit: 100 }, NOW);
    const m = t!.messages.find((x) => x.approval)!;
    expect(m.approval).toMatchObject({ title: "Logo proof v2", status: "approved", responseTitle: "Approve" });
    expect(m.approval!.options.map((o) => o.title)).toEqual(["Approve", "Request changes", "Question"]);
  });
});

describe("markRead", () => {
  it("clears the unread count for this account's conversation only", async () => {
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    const id = tables.whatsapp_conversations[0].id as string;
    expect(await svc.markRead(ACC_OTHER, id)).toBe(false);
    expect(tables.whatsapp_conversations[0].unread_count).toBe(1);
    expect(await svc.markRead(ACC, id)).toBe(true);
    expect(tables.whatsapp_conversations[0].unread_count).toBe(0);
  });
});

describe("startConversation: message a saved contact", () => {
  it("opens a conversation for a saved, opted-in contact (window closed, so a template is needed), reusing the contact's own encrypted number", async () => {
    const c = addContact("+27829990001");
    const out = await svc.startConversation(ACC, c.id as string, NOW);
    expect(out).toMatchObject({ ok: true, created: true });
    const conv = tables.whatsapp_conversations[0];
    expect(conv).toMatchObject({ account_id: ACC, contact_id: c.id, contact_key: c.contact_key, last_inbound_at: null });
    expect(decryptPhone(ACC, conv.contact_key as string, conv.phone_ciphertext as string)).toBe("+27829990001");
    expect(JSON.stringify(tables.whatsapp_conversations)).not.toContain("27829990001");
  });

  it("reuses an existing conversation instead of making another", async () => {
    const c = addContact("+27829990001");
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    const out = await svc.startConversation(ACC, c.id as string, NOW);
    expect(out).toMatchObject({ ok: true, created: false });
    expect(tables.whatsapp_conversations).toHaveLength(1);
  });

  it("refuses a contact who opted out, a contact of another account, and one that does not exist", async () => {
    const c = addContact("+27829990001", { consent_status: "opted_out" });
    expect(await svc.startConversation(ACC, c.id as string, NOW)).toEqual({ ok: false, code: "opted_out" });
    const other = addContact("+27829990002", { account_id: ACC_OTHER });
    expect(await svc.startConversation(ACC, other.id as string, NOW)).toEqual({ ok: false, code: "not_found" });
    expect(await svc.startConversation(ACC, "nope", NOW)).toEqual({ ok: false, code: "not_found" });
    expect(tables.whatsapp_conversations).toHaveLength(0);
  });
});

describe("listApprovals", () => {
  async function seed() {
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    await inbound("27829990002", "hi", HOUR, "wamid.B2222");
    const h = makeHttp();
    for (const conv of tables.whatsapp_conversations) await sendApprovalRequest(ctx(h.http), conv.id as string, { title: `Proof for ${conv.display_name}`, body: "Please review." });
  }

  it("lists approval requests with their state, newest first, the person as a mask and name, and a plain note that it is not consent", async () => {
    await seed();
    tables.whatsapp_approval_requests[0].status = "changes_requested";
    tables.whatsapp_approval_requests[0].response_title = "Request changes";
    const out = await svc.listApprovals(ACC, { limit: 50 });
    expect(out.approvals).toHaveLength(2);
    expect(out.approvals.map((a) => a.title).sort()).toEqual(["Proof for P01", "Proof for P02"]);
    expect(out.approvals.find((a) => a.status === "changes_requested")).toMatchObject({ responseTitle: "Request changes" });
    expect(out.counts).toEqual({ pending: 1, approved: 0, changes_requested: 1, question: 0, other_reply: 0 });
    expect(JSON.stringify(out)).not.toMatch(/2782999000|ciphertext/);
  });

  it("filters by status and is scoped to the account", async () => {
    await seed();
    tables.whatsapp_approval_requests[1].status = "approved";
    tables.whatsapp_approval_requests.push({ id: "foreign", account_id: ACC_OTHER, conversation_id: "x", message_id: "y", status: "approved", options: [], created_at: NOW.toISOString() });
    const out = await svc.listApprovals(ACC, { status: "approved", limit: 50 });
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].status).toBe("approved");
  });
});

describe("saved audiences", () => {
  it("creates, lists (with member counts) and deletes an audience for this account's connection", async () => {
    const a = await svc.createAudience(ACC, "33333333-3333-4333-8333-333333333333", { socialAccountId: SA, name: "Website clients" });
    expect(a).toMatchObject({ ok: true });
    const list = await svc.listAudiences(ACC, SA);
    expect(list).toEqual([expect.objectContaining({ name: "Website clients", memberCount: 0 })]);
    expect(await svc.deleteAudience(ACC_OTHER, (a as { id: string }).id)).toBe(false);
    expect(await svc.deleteAudience(ACC, (a as { id: string }).id)).toBe(true);
    expect(tables.whatsapp_audiences).toHaveLength(0);
  });

  it("refuses a bad or duplicate name and another account's connection", async () => {
    expect(await svc.createAudience(ACC, null, { socialAccountId: SA, name: "  " })).toMatchObject({ ok: false, code: "name_invalid" });
    expect(await svc.createAudience(ACC, null, { socialAccountId: SA, name: "+27 82 999 0001" })).toMatchObject({ ok: false, code: "name_invalid" });
    await svc.createAudience(ACC, null, { socialAccountId: SA, name: "Clients" });
    expect(await svc.createAudience(ACC, null, { socialAccountId: SA, name: "Clients" })).toMatchObject({ ok: false, code: "name_taken" });
    expect(await svc.createAudience(ACC, null, { socialAccountId: "22222222-2222-4222-8222-222222222222", name: "X" })).toMatchObject({ ok: false, code: "connection_not_found" });
  });

  it("adds only this account's, opted-in contacts of the same connection, and removes members", async () => {
    const c1 = addContact("+27829990001");
    const c2 = addContact("+27829990002", { consent_status: "opted_out" });
    const c3 = addContact("+27829990003", { account_id: ACC_OTHER });
    const a = (await svc.createAudience(ACC, null, { socialAccountId: SA, name: "Clients" })) as { id: string };
    const out = await svc.addAudienceMembers(ACC, a.id, [c1.id as string, c2.id as string, c3.id as string, "nope"]);
    expect(out).toEqual({ ok: true, added: 1, skipped: 3 });
    expect(tables.whatsapp_audience_members).toHaveLength(1);
    expect(await svc.addAudienceMembers(ACC, a.id, [c1.id as string])).toEqual({ ok: true, added: 0, skipped: 1 });
    expect(await svc.removeAudienceMember(ACC, a.id, c1.id as string)).toBe(true);
    expect(tables.whatsapp_audience_members).toHaveLength(0);
    expect(await svc.addAudienceMembers(ACC_OTHER, a.id, [c1.id as string])).toEqual({ ok: false, code: "not_found" });
  });
});

describe("sendUpdateToAudience: short update lines to a saved audience", () => {
  async function audience(contacts: Array<Record<string, unknown>>) {
    const a = (await svc.createAudience(ACC, null, { socialAccountId: SA, name: "Clients" })) as { id: string };
    await svc.addAudienceMembers(ACC, a.id, contacts.map((c) => c.id as string));
    return a.id;
  }

  it("sends free-form text where the window is open and the approved template where it is closed; skips a closed window with no template", async () => {
    const c1 = addContact("+27829990001"); // window open
    const c2 = addContact("+27829990002"); // window closed
    const c3 = addContact("+27829990003"); // window closed
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    const id = await audience([c1, c2, c3]);

    const h = makeHttp();
    const out = await svc.sendUpdateToAudience(ctx(h.http), id, { text: "Your site goes live on Friday.", templateId: TEMPLATE_ID, params: ["Friend", "soon"] });
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.summary).toEqual({ total: 3, sent: 3, skipped: 0, failed: 0, notAttempted: 0 });
    const types = h.calls.map((c) => c.type).sort();
    expect(types).toEqual(["template", "template", "text"]);
    expect(out.results.map((r) => r.how).sort()).toEqual(["template", "template", "text"]);
    expect(JSON.stringify(out)).not.toMatch(/2782999000/);

    const h2 = makeHttp();
    const noTemplate = await svc.sendUpdateToAudience(ctx(h2.http), id, { text: "Another note." });
    if (!noTemplate.ok) throw new Error("unexpected");
    expect(noTemplate.summary).toMatchObject({ sent: 1, skipped: 2 });
    expect(noTemplate.results.filter((r) => r.status === "skipped").every((r) => r.code === "window_closed")).toBe(true);
  });

  it("skips a member who opted out and keeps going", async () => {
    const c1 = addContact("+27829990001");
    const c2 = addContact("+27829990002");
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    await inbound("27829990002", "hi", HOUR, "wamid.B2222");
    const id = await audience([c1, c2]);
    c1.consent_status = "opted_out";
    const h = makeHttp();
    const out = await svc.sendUpdateToAudience(ctx(h.http), id, { text: "Update" });
    if (!out.ok) throw new Error("unexpected");
    expect(out.summary).toMatchObject({ sent: 1, skipped: 1 });
    expect(h.calls).toHaveLength(1);
  });

  it("stops at a gate that applies to everyone (kill switch, paused connection, cap), leaving the rest not attempted", async () => {
    const cs = [addContact("+27829990001"), addContact("+27829990002"), addContact("+27829990003")];
    for (const [i, c] of cs.entries()) await inbound(`2782999000${i + 1}`, "hi", HOUR, `wamid.X${i}000`);
    const id = await audience(cs);
    tables.whatsapp_send_controls[0].max_messages_per_day = 2;
    const h = makeHttp();
    const out = await svc.sendUpdateToAudience(ctx(h.http), id, { text: "Update" });
    if (!out.ok) throw new Error("unexpected");
    expect(out.summary).toEqual({ total: 3, sent: 2, skipped: 0, failed: 0, notAttempted: 1 });
    expect(h.calls).toHaveLength(2);
  });

  it("a connection pause from Meta stops the rest at once", async () => {
    const cs = [addContact("+27829990001"), addContact("+27829990002")];
    for (const [i, c] of cs.entries()) await inbound(`2782999000${i + 1}`, "hi", HOUR, `wamid.X${i}000`);
    const id = await audience(cs);
    const h = makeHttp(() => ({ status: 400, json: { error: { code: 131048 } } }));
    const out = await svc.sendUpdateToAudience(ctx(h.http), id, { text: "Update" });
    if (!out.ok) throw new Error("unexpected");
    expect(h.calls).toHaveLength(1);
    expect(out.summary).toMatchObject({ failed: 1, notAttempted: 1 });
  });

  it("refuses an audience over the placeholder size cap, an empty audience, a missing text, and another account's audience", async () => {
    const empty = (await svc.createAudience(ACC, null, { socialAccountId: SA, name: "Empty" })) as { id: string };
    expect(await svc.sendUpdateToAudience(ctx(makeHttp().http), empty.id, { text: "x" })).toMatchObject({ ok: false, code: "empty_audience" });
    const c = addContact("+27829990001");
    const id = await audience([c]);
    expect(await svc.sendUpdateToAudience(ctx(makeHttp().http), id, { text: " " })).toMatchObject({ ok: false, code: "text_invalid" });
    expect(await svc.sendUpdateToAudience({ ...ctx(makeHttp().http), accountId: ACC_OTHER }, id, { text: "x" })).toMatchObject({ ok: false, code: "not_found" });
    expect(svc.MAX_UPDATE_RECIPIENTS).toBe(25);
    for (let i = 0; i < 26; i++) tables.whatsapp_audience_members.push({ audience_id: id, contact_id: `fake${i}`, account_id: ACC });
    expect(await svc.sendUpdateToAudience(ctx(makeHttp().http), id, { text: "x" })).toMatchObject({ ok: false, code: "audience_too_large" });
  });

  it("never logs a number or the update text", async () => {
    const c = addContact("+27829990001");
    await inbound("27829990001", "hi", HOUR, "wamid.A1111");
    const id = await audience([c]);
    await svc.sendUpdateToAudience(ctx(makeHttp().http), id, { text: "secret project update" });
    expect(logged.join("\n")).not.toMatch(/27829990001|secret project update/);
  });
});
