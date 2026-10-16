// /whatsapp chat routes (two-way): inbox, thread, reply, template, approval request, list message, start a conversation with a saved
// contact, the approvals view and saved audiences with update lines. Same gate as the broadcast routes (three flags, platform
// visible, signed-in HUMAN only, paid plan). The customer's own login is the only one used. Supabase is the in-memory fake; the Meta
// HTTP client is injected and fake; no response or log ever holds a phone number.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";
import type { HttpClient } from "../../whatsappBroadcast/cloudApi.js";

const ctx = vi.hoisted(() => ({ account: "acc1", signedIn: true, method: "jwt" as "jwt" | "apiKey", canSee: true }));

vi.mock("../auth.js", async () => {
  const payload = Buffer.from(JSON.stringify({ sub: "33333333-3333-4333-8333-333333333333" })).toString("base64url");
  return {
    requireAuth: (req: any, res: any, next: any) => {
      if (!ctx.signedIn) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.accountId = ctx.account;
      req.authMethod = ctx.method;
      req.rawToken = `h.${payload}.s`;
      next();
    },
    requireHumanAuth: (req: any, res: any, next: any) => {
      if (req.authMethod === "apiKey") {
        res.status(403).json({ error: "This endpoint requires signing in with your account, not an API key" });
        return;
      }
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  const k = await import("../../whatsappBroadcast/testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});
vi.mock("./socialAccounts.routes.js", () => ({ canSeePlatform: () => ctx.canSee }));

const { buildWhatsAppChatRouter } = await import("./whatsappChat.routes.js");
const { recordInboundChat, extractChatMessages } = await import("../../whatsappChat/inbound.js");
const kit = await import("../../whatsappBroadcast/testKit.js");
const { ACC, ACC_OTHER, SA, WABA, PHONE_ID, TEMPLATE_ID, TOKEN, seedWorld, resetTables, setTestEnv, addContact } = kit;

const SAVED = { ...process.env };
const NUMBER = "27829990001";
let sent: Array<Record<string, any>> = [];
let logged: string[] = [];
const http: HttpClient = async (_u, init) => {
  sent.push({ ...JSON.parse(init.body ?? "{}"), _auth: init.headers.Authorization });
  return { status: 200, json: { messages: [{ id: `wamid.R${sent.length}0000` }] } };
};
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildWhatsAppChatRouter({ http }));
  return a;
};
async function conversation(ageMs = 10 * 60_000, number = NUMBER) {
  const now = new Date();
  const payload = { object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: number, profile: { name: "Pablo" } }], messages: [{ from: number, id: `wamid.HI${number.slice(-4)}`, timestamp: String(Math.floor((now.getTime() - ageMs) / 1000)), type: "text", text: { body: "hello there" } }] } }] }] };
  await recordInboundChat({ id: SA, account_id: ACC }, extractChatMessages(payload, now).messages, now);
  return tables.whatsapp_conversations.at(-1)!;
}
const noNumbers = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/2782999000\d|ciphertext/);

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  ctx.account = ACC;
  ctx.signedIn = true;
  ctx.method = "jwt";
  ctx.canSee = true;
  sent = [];
  logged = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

const ID = "44444444-4444-4444-8444-444444444444";
const gatePaths: Array<[string, () => request.Test]> = [
  ["GET /whatsapp/conversations", () => request(app()).get("/whatsapp/conversations")],
  ["GET /whatsapp/conversations/:id", () => request(app()).get(`/whatsapp/conversations/${ID}`)],
  ["POST /whatsapp/conversations/:id/read", () => request(app()).post(`/whatsapp/conversations/${ID}/read`).send({})],
  ["POST /whatsapp/conversations/:id/reply", () => request(app()).post(`/whatsapp/conversations/${ID}/reply`).send({ text: "hi" })],
  ["POST /whatsapp/conversations/:id/template", () => request(app()).post(`/whatsapp/conversations/${ID}/template`).send({ template_id: TEMPLATE_ID, params: [] })],
  ["POST /whatsapp/conversations/:id/approval", () => request(app()).post(`/whatsapp/conversations/${ID}/approval`).send({ title: "T", body: "B" })],
  ["POST /whatsapp/conversations/:id/list", () => request(app()).post(`/whatsapp/conversations/${ID}/list`).send({ body: "B", button_label: "Open", sections: [] })],
  ["POST /whatsapp/contacts/:id/conversation", () => request(app()).post(`/whatsapp/contacts/${ID}/conversation`).send({})],
  ["POST /whatsapp/chats/start", () => request(app()).post("/whatsapp/chats/start").send({ social_account_id: SA, phone: "+27829990008" })],
  ["GET /whatsapp/approvals", () => request(app()).get("/whatsapp/approvals")],
  ["GET /whatsapp/audiences", () => request(app()).get("/whatsapp/audiences")],
  ["POST /whatsapp/audiences", () => request(app()).post("/whatsapp/audiences").send({ social_account_id: SA, name: "Clients" })],
  ["DELETE /whatsapp/audiences/:id", () => request(app()).delete(`/whatsapp/audiences/${ID}`)],
  ["POST /whatsapp/audiences/:id/members", () => request(app()).post(`/whatsapp/audiences/${ID}/members`).send({ contact_ids: [] })],
  ["DELETE /whatsapp/audiences/:id/members/:contactId", () => request(app()).delete(`/whatsapp/audiences/${ID}/members/${ID}`)],
  ["POST /whatsapp/audiences/:id/send-update", () => request(app()).post(`/whatsapp/audiences/${ID}/send-update`).send({ text: "hi" })],
];

describe("gating", () => {
  it.each(gatePaths)("%s is a 404 while any of the three flags is off", async (_n, call) => {
    for (const name of ["WHATSAPP_BYOK_ENABLED", "WHATSAPP_BROADCASTS_ENABLED", "WHATSAPP_SEND_ENABLED"]) {
      process.env[name] = "false";
      expect((await call()).status).toBe(404);
      process.env[name] = "true";
    }
  });
  it.each(gatePaths)("%s is a 404 when the platform is not visible", async (_n, call) => {
    ctx.canSee = false;
    expect((await call()).status).toBe(404);
  });
  it.each(gatePaths)("%s needs a sign-in", async (_n, call) => {
    ctx.signedIn = false;
    expect((await call()).status).toBe(401);
  });
  it.each(gatePaths)("%s REFUSES an API key: there is no API key path to send or read chats", async (_n, call) => {
    ctx.method = "apiKey";
    expect((await call()).status).toBe(403);
  });
  it.each(gatePaths)("%s is refused below the paid plan", async (_n, call) => {
    tables.subscriptions = [];
    expect((await call()).status).toBe(400);
  });
});

describe("plan gate over every tier, on every route", () => {
  const PAID = ["starter", "pro", "business", "agency", "agency_plus"];
  const LAPSED = ["cancelled", "canceled", "past_due", "paused", "unpaid", "incomplete"];
  it.each(gatePaths)("%s: Free and lapsed plans are refused, every paid tier gets through the gate", async (_n, call) => {
    tables.subscriptions = [];
    expect((await call()).status).toBe(400);
    for (const tier of PAID) {
      for (const status of LAPSED) {
        tables.subscriptions = [{ account_id: ACC, tier, status }];
        const r = await call();
        expect(r.status, `${tier} ${status}`).toBe(400);
        expect(r.body.requiresPlan, `${tier} ${status}`).toBe("Starter");
      }
      for (const status of ["active", "trialing"]) {
        tables.subscriptions = [{ account_id: ACC, tier, status }];
        expect((await call()).body.requiresPlan, `${tier} ${status}`).toBeUndefined();
      }
    }
  });
});

describe("inbox and thread", () => {
  it("lists conversations with the window state and no number", async () => {
    await conversation();
    const res = await request(app()).get("/whatsapp/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations[0]).toMatchObject({ displayName: "Pablo", unreadCount: 1, isContact: false, window: { open: true } });
    noNumbers(res.body);
  });

  it("returns a thread with decrypted text, and 404 for another account's conversation", async () => {
    const c = await conversation();
    const res = await request(app()).get(`/whatsapp/conversations/${c.id}`);
    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toMatchObject({ direction: "inbound", text: "hello there" });
    noNumbers(res.body);
    ctx.account = ACC_OTHER;
    tables.subscriptions.push({ account_id: ACC_OTHER, tier: "business", status: "active" });
    expect((await request(app()).get(`/whatsapp/conversations/${c.id}`)).status).toBe(404);
  });

  it("marks a conversation read", async () => {
    const c = await conversation();
    expect((await request(app()).post(`/whatsapp/conversations/${c.id}/read`).send({})).status).toBe(200);
    expect(tables.whatsapp_conversations[0].unread_count).toBe(0);
  });

  it("a bad id is a 400", async () => {
    expect((await request(app()).get("/whatsapp/conversations/not-a-uuid")).status).toBe(400);
  });
});

describe("sending", () => {
  it("a reply inside the window is sent with the customer's own token", async () => {
    const c = await conversation();
    const res = await request(app()).post(`/whatsapp/conversations/${c.id}/reply`).send({ text: "Your proof is ready." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "handed_off", mode: "text", window: { open: true } });
    expect(sent[0]).toMatchObject({ to: NUMBER, type: "text", _auth: `Bearer ${TOKEN}` });
    noNumbers(res.body);
  });

  it("a reply outside the window is a 409 'window_closed' that says a template is needed", async () => {
    const c = await conversation(30 * 3_600_000);
    const res = await request(app()).post(`/whatsapp/conversations/${c.id}/reply`).send({ text: "Hello?" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("window_closed");
    expect(res.body.error).toMatch(/template/i);
    expect(sent).toHaveLength(0);
  });

  it("validates the body", async () => {
    const c = await conversation();
    expect((await request(app()).post(`/whatsapp/conversations/${c.id}/reply`).send({})).status).toBe(400);
    expect((await request(app()).post(`/whatsapp/conversations/${c.id}/reply`).send({ text: "   " })).status).toBe(400);
  });

  it("a template to a saved, opted-in contact works outside the window; to someone who messaged first it is a 409", async () => {
    const stored = addContact(`+${NUMBER}`);
    const c = await conversation(48 * 3_600_000);
    expect(c.contact_id).toBe(stored.id);
    const res = await request(app()).post(`/whatsapp/conversations/${c.id}/template`).send({ template_id: TEMPLATE_ID, params: ["Pablo", "20%"] });
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ type: "template" });

    const other = await conversation(48 * 3_600_000, "27829990002");
    const refused = await request(app()).post(`/whatsapp/conversations/${other.id}/template`).send({ template_id: TEMPLATE_ID, params: ["Pablo", "20%"] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("no_opt_in");
  });

  it("an approval request sends buttons and is listed as pending, with the plain 'not legal consent' wording kept in the API", async () => {
    const c = await conversation();
    const res = await request(app()).post(`/whatsapp/conversations/${c.id}/approval`).send({ title: "Logo proof v2", body: "Please review." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "buttons" });
    expect(res.body.approvalId).toBeTruthy();
    const list = await request(app()).get("/whatsapp/approvals?status=pending");
    expect(list.body.approvals[0]).toMatchObject({ title: "Logo proof v2", status: "pending" });
    expect(list.body.counts).toMatchObject({ pending: 1 });
    expect(list.body.note).toMatch(/not legal consent/i);
    noNumbers(list.body);
  });

  it("approval options beyond Meta's limits are a 400", async () => {
    const c = await conversation();
    const res = await request(app()).post(`/whatsapp/conversations/${c.id}/approval`).send({ title: "T", body: "B", options: [{ id: "a", title: "x".repeat(21) }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("options_invalid");
  });

  it("a list message inside the window", async () => {
    const c = await conversation();
    const res = await request(app()).post(`/whatsapp/conversations/${c.id}/list`).send({ body: "Pick a topic", button_label: "Topics", sections: [{ title: "Updates", rows: [{ id: "r1", title: "Design" }] }] });
    expect(res.status).toBe(200);
    expect(sent[0].interactive.type).toBe("list");
    const bad = await request(app()).post(`/whatsapp/conversations/${c.id}/list`).send({ body: "Pick", button_label: "Topics", sections: [{ title: "Updates", rows: [] }] });
    expect(bad.status).toBe(400);
  });

});

describe("start a conversation with a saved contact", () => {
  it("creates one (201) the first time and finds it (200) after; an opted-out or foreign contact is refused", async () => {
    const c = addContact(`+${NUMBER}`);
    const first = await request(app()).post(`/whatsapp/contacts/${c.id}/conversation`).send({});
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, window: { open: false } });
    noNumbers(first.body);
    expect((await request(app()).post(`/whatsapp/contacts/${c.id}/conversation`).send({})).status).toBe(200);
    const out = addContact("+27829990002", { consent_status: "opted_out" });
    const refused = await request(app()).post(`/whatsapp/contacts/${out.id}/conversation`).send({});
    expect(refused.status).toBe(409);
    const foreign = addContact("+27829990003", { account_id: ACC_OTHER });
    expect((await request(app()).post(`/whatsapp/contacts/${foreign.id}/conversation`).send({})).status).toBe(404);
  });
});

describe("start a chat from a typed number (Direct Entry)", () => {
  const SENTENCE = "By initializing this chat, you confirm compliance with Meta's user opt-in messaging policies.";
  const start = (body: Record<string, unknown>) => request(app()).post("/whatsapp/chats/start").send(body);

  it("saves the contact with an automatic Direct Entry consent record, then opens the chat", async () => {
    const before = Date.now();
    const r = await start({ social_account_id: SA, phone: "+27 82 999 0004" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: true, contactCreated: true, window: { open: false } });
    expect(typeof r.body.conversationId).toBe("string");
    expect(tables.whatsapp_contacts).toHaveLength(1);
    expect(tables.whatsapp_contacts[0]).toMatchObject({ consent_status: "opted_in", social_account_id: SA });
    expect(tables.whatsapp_opt_ins).toHaveLength(1);
    const ev = tables.whatsapp_opt_ins[0];
    expect(ev).toMatchObject({ source: "direct_entry", attested: true, consent_text: SENTENCE, proof_reference: null, contact_id: tables.whatsapp_contacts[0].id });
    expect(ev.attestation_version).toMatch(/^direct-entry/);
    expect(Date.parse(ev.captured_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(ev.captured_at)).toBeLessThanOrEqual(Date.parse(ev.recorded_at));
    expect(ev.recorded_by).toBe("33333333-3333-4333-8333-333333333333");
    expect(tables.whatsapp_contacts[0].current_opt_in_id).toBe(ev.id);
    noNumbers(r.body);
    expect(logged.join("\n")).not.toMatch(/2782999000/);
  });

  it("writes a consent record whose hash chain verifies", async () => {
    await start({ social_account_id: SA, phone: "+27829990004" });
    const { verifyOptInChain } = await import("../../whatsappContacts.js");
    const e = tables.whatsapp_opt_ins[0];
    const ok = verifyOptInChain([{ prevHash: e.prev_hash, accountId: e.account_id, contactId: e.contact_id, source: e.source, capturedAt: e.captured_at, recordedAt: e.recorded_at, recordedBy: e.recorded_by, consentText: e.consent_text, proofReference: e.proof_reference, attested: e.attested, attestationVersion: e.attestation_version, importBatchId: e.import_batch_id, rowHash: e.row_hash }]);
    expect(ok).toEqual({ ok: true });
  });

  it("a second start for the same number reuses the contact and the chat and adds no new consent record", async () => {
    const first = await start({ social_account_id: SA, phone: "+27829990004" });
    const second = await start({ social_account_id: SA, phone: "27 82 999 0004" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, contactCreated: false, conversationId: first.body.conversationId });
    expect(tables.whatsapp_contacts).toHaveLength(1);
    expect(tables.whatsapp_opt_ins).toHaveLength(1);
  });

  it("keeps an existing contact's own consent evidence: no Direct Entry record is added on top", async () => {
    addContact(`+${NUMBER}`);
    const r = await start({ social_account_id: SA, phone: `+${NUMBER}` });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: true, contactCreated: false });
    expect(tables.whatsapp_opt_ins.some((o: any) => o.source === "direct_entry")).toBe(false);
  });

  it("refuses a number that opted out (409) and creates nothing", async () => {
    const { contactKeyFor } = await import("../../platforms/whatsapp/contactPrivacy.js");
    tables.whatsapp_opt_outs.push({ id: "oo1", account_id: ACC, contact_key: contactKeyFor(ACC, "27829990005"), wa_contact_key: null, contact_display: "+27 ** *** 0005", scope: "all", source: "keyword", keyword: "STOP", occurred_at: new Date().toISOString() });
    const r = await start({ social_account_id: SA, phone: "+27829990005" });
    expect(r.status).toBe(409);
    expect(tables.whatsapp_contacts).toHaveLength(0);
    expect(tables.whatsapp_opt_ins).toHaveLength(0);
    expect(tables.whatsapp_conversations ?? []).toHaveLength(0);
  });

  it("400 for a number that is not valid, 404 for a connection that is not the caller's, 400 for a missing field", async () => {
    expect((await start({ social_account_id: SA, phone: "not a number" })).status).toBe(400);
    expect((await start({ social_account_id: SA, phone: "123" })).status).toBe(400);
    expect((await start({ social_account_id: "55555555-5555-4555-8555-555555555555", phone: "+27829990006" })).status).toBe(404);
    expect((await start({ social_account_id: SA })).status).toBe(400);
    expect((await start({ phone: "+27829990006" })).status).toBe(400);
    expect(tables.whatsapp_contacts).toHaveLength(0);
  });

  it("ignores any consent fields the browser sends: source, date and wording are always the system's", async () => {
    const r = await start({ social_account_id: SA, phone: "+27829990007", optIn: { source: "in_person", capturedAt: "2020-01-01", consentText: "made up", attested: true }, source: "website_form", consentText: "made up" });
    expect(r.status).toBe(201);
    const ev = tables.whatsapp_opt_ins[0];
    expect(ev.source).toBe("direct_entry");
    expect(ev.consent_text).toBe(SENTENCE);
    expect(Date.parse(ev.captured_at)).toBeGreaterThan(Date.parse("2026-01-01"));
  });
});

describe("saved audiences and update lines", () => {
  it("create, add members, send an update, list and delete", async () => {
    const c1 = addContact(`+${NUMBER}`);
    await conversation();
    const made = await request(app()).post("/whatsapp/audiences").send({ social_account_id: SA, name: "Website clients" });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect((await request(app()).post(`/whatsapp/audiences/${id}/members`).send({ contact_ids: [c1.id] })).body).toEqual({ added: 1, skipped: 0 });
    const list = await request(app()).get("/whatsapp/audiences");
    expect(list.body.audiences).toEqual([expect.objectContaining({ name: "Website clients", memberCount: 1 })]);

    const upd = await request(app()).post(`/whatsapp/audiences/${id}/send-update`).send({ text: "Your site goes live on Friday." });
    expect(upd.status).toBe(200);
    expect(upd.body.summary).toMatchObject({ total: 1, sent: 1 });
    expect(sent[0]).toMatchObject({ type: "text", text: { body: "Your site goes live on Friday." } });
    noNumbers(upd.body);

    expect((await request(app()).delete(`/whatsapp/audiences/${id}/members/${c1.id}`)).status).toBe(200);
    expect((await request(app()).delete(`/whatsapp/audiences/${id}`)).status).toBe(200);
    expect((await request(app()).delete(`/whatsapp/audiences/${id}`)).status).toBe(404);
  });

  it("validation and refusals: duplicate name 409, empty audience 400, another account's audience 404", async () => {
    await request(app()).post("/whatsapp/audiences").send({ social_account_id: SA, name: "Clients" });
    expect((await request(app()).post("/whatsapp/audiences").send({ social_account_id: SA, name: "Clients" })).status).toBe(409);
    expect((await request(app()).post("/whatsapp/audiences").send({ social_account_id: SA, name: " " })).status).toBe(400);
    const id = tables.whatsapp_audiences[0].id;
    expect((await request(app()).post(`/whatsapp/audiences/${id}/send-update`).send({ text: "x" })).status).toBe(400);
    ctx.account = ACC_OTHER;
    tables.subscriptions.push({ account_id: ACC_OTHER, tier: "business", status: "active" });
    expect((await request(app()).post(`/whatsapp/audiences/${id}/send-update`).send({ text: "x" })).status).toBe(404);
  });
});

describe("privacy", () => {
  it("logs no number, message text or token", async () => {
    const c = await conversation();
    await request(app()).post(`/whatsapp/conversations/${c.id}/reply`).send({ text: "very private words" });
    await request(app()).get(`/whatsapp/conversations/${c.id}`);
    const all = logged.join("\n");
    expect(all).not.toMatch(/2782999000|very private|hello there/);
    expect(all).not.toContain(TOKEN);
  });
});
