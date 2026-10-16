// The opposite of a cap, proven: big audiences, many broadcasts in a day, hundreds of messages in 24 hours and large update lines are all
// ACCEPTED and SENT. Customers pay Meta directly with their own tokens; the only things that stop a send are the plan gate, the rollout
// flags, consent, opt-out, the 24 hour window, Meta's formats, and Meta's own restriction signals. Fake database, fake HTTP, no network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";
import type { HttpClient } from "./cloudApi.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { createBroadcast } = await import("./broadcasts.js");
const { runBroadcastCycle } = await import("./sender.js");
const { sendChatText } = await import("../whatsappChat/chatSend.js");
const { recordInboundChat, extractChatMessages } = await import("../whatsappChat/inbound.js");
const svc = await import("../whatsappChat/conversations.js");
const kit = await import("./testKit.js");
const { ACC, SA, WABA, PHONE_ID, TEMPLATE_ID, seedWorld, resetTables, setTestEnv, addContact, clock } = kit;

const SAVED = { ...process.env };
const NOW = new Date("2026-10-16T12:00:00.000Z");
const IN_1H = new Date(NOW.getTime() + 3_600_000);
const ctx = { accountId: ACC, createdBy: "33333333-3333-4333-8333-333333333333" };

function okHttp() {
  const calls: Array<Record<string, any>> = [];
  const http: HttpClient = async (_u, init) => {
    calls.push(JSON.parse(init.body ?? "{}"));
    return { status: 200, json: { messages: [{ id: `wamid.NOCAP${calls.length}` }] } };
  };
  return { http, calls };
}
const phone = (i: number) => `+2782${String(1000000 + i)}`;

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
  clock.now = undefined;
});

describe("broadcasts", () => {
  it("a broadcast to 1,000 recipients is accepted, in a preview and for real", async () => {
    for (let i = 0; i < 1000; i++) addContact(phone(i));
    const input = { socialAccountId: SA, templateId: TEMPLATE_ID, name: "Big list", params: ["Friend", "20%"], scheduledFor: IN_1H };
    const preview = await createBroadcast(ctx, input, { dryRun: true, now: NOW });
    expect(preview).toMatchObject({ ok: true, preview: { audience: 1000 } });
    const real = await createBroadcast(ctx, input, { dryRun: false, now: NOW });
    expect(real).toMatchObject({ ok: true });
    expect(tables.whatsapp_broadcasts[0].audience_estimate).toBe(1000);
  });

  it("twelve broadcasts in one day are all accepted", async () => {
    addContact(phone(1));
    for (let i = 0; i < 12; i++) {
      const out = await createBroadcast(ctx, { socialAccountId: SA, templateId: TEMPLATE_ID, name: `Day broadcast ${i}`, params: ["a", "b"], scheduledFor: IN_1H }, { dryRun: false, now: NOW });
      expect(out.ok).toBe(true);
    }
    expect(tables.whatsapp_broadcasts).toHaveLength(12);
  });

  it("nothing needs a controls row: with no cap or kill-switch rows anywhere, a broadcast is scheduled and sent", async () => {
    expect(tables.whatsapp_send_controls).toBeUndefined();
    addContact(phone(1));
    expect((await createBroadcast(ctx, { socialAccountId: SA, templateId: TEMPLATE_ID, name: "One", params: ["a", "b"], scheduledFor: IN_1H }, { dryRun: false, now: NOW })).ok).toBe(true);
  });
});

describe("the sender", () => {
  it("sends 600 messages to 600 recipients in one go: no per-day limit and no per-cycle ceiling", async () => {
    for (let i = 0; i < 600; i++) addContact(phone(i));
    tables.whatsapp_broadcasts.push({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      account_id: ACC,
      social_account_id: SA,
      template_id: TEMPLATE_ID,
      template_name: "spring_offer",
      template_language: "en_US",
      template_category: "utility",
      template_params: ["a", "b"],
      name: "Big",
      status: "scheduled",
      scheduled_for: new Date(NOW.getTime() - 60_000).toISOString(),
      recipients_materialised_at: null,
      created_at: NOW.toISOString(),
    });
    tables.whatsapp_message_templates[0].category = "utility";
    clock.now = NOW;
    const h = okHttp();
    await runBroadcastCycle({ http: h.http, now: () => NOW });
    expect(h.calls).toHaveLength(600);
    expect(tables.whatsapp_broadcasts[0].status).toBe("completed");
  });

  it("a broadcast bigger than any old placeholder is materialised in full (no 'cap reached' pause)", async () => {
    for (let i = 0; i < 300; i++) addContact(phone(i));
    tables.whatsapp_broadcasts.push({ id: "b1", account_id: ACC, social_account_id: SA, template_id: TEMPLATE_ID, template_name: "spring_offer", template_language: "en_US", template_category: "utility", template_params: ["a", "b"], name: "Big", status: "scheduled", scheduled_for: new Date(NOW.getTime() - 60_000).toISOString(), recipients_materialised_at: null, created_at: NOW.toISOString() });
    tables.whatsapp_message_templates[0].category = "utility";
    clock.now = NOW;
    await runBroadcastCycle({ http: okHttp().http, now: () => NOW });
    expect(tables.whatsapp_broadcasts[0].status).not.toBe("paused");
    expect(tables.whatsapp_broadcast_recipients).toHaveLength(300);
  });
});

describe("chat", () => {
  it("300 free-form messages inside one 24 hour period are all sent", async () => {
    const payload = { object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: "27829990001", profile: { name: "Pablo" } }], messages: [{ from: "27829990001", id: "wamid.HELLO1", timestamp: String(Math.floor(NOW.getTime() / 1000) - 60), type: "text", text: { body: "hello" } }] } }] }] };
    await recordInboundChat({ id: SA, account_id: ACC }, extractChatMessages(payload, NOW).messages, NOW);
    const conv = tables.whatsapp_conversations[0];
    const h = okHttp();
    for (let i = 0; i < 300; i++) {
      const out = await sendChatText({ accountId: ACC, userId: null, http: h.http, now: NOW }, conv.id as string, `update ${i}`);
      expect(out.ok).toBe(true);
    }
    expect(h.calls).toHaveLength(300);
  });

  it("an update line to 100 saved contacts is accepted and sent to all of them", async () => {
    const contacts = Array.from({ length: 100 }, (_, i) => addContact(phone(i)));
    const a = (await svc.createAudience(ACC, null, { socialAccountId: SA, name: "Everyone" })) as { id: string };
    expect(await svc.addAudienceMembers(ACC, a.id, contacts.map((c) => c.id as string))).toEqual({ ok: true, added: 100, skipped: 0 });
    const h = okHttp();
    const out = await svc.sendUpdateToAudience({ accountId: ACC, userId: null, http: h.http, now: NOW }, a.id, { text: "Site live Friday", templateId: TEMPLATE_ID, params: ["Friend", "soon"] });
    expect(out).toMatchObject({ ok: true, summary: { total: 100, sent: 100, notAttempted: 0 } });
    expect(h.calls).toHaveLength(100);
  });

  it("an audience with more than 1,000 members is read in full (no silent truncation)", async () => {
    const a = (await svc.createAudience(ACC, null, { socialAccountId: SA, name: "Huge" })) as { id: string };
    for (let i = 0; i < 1500; i++) tables.whatsapp_audience_members.push({ audience_id: a.id, contact_id: `fake-${i}`, account_id: ACC });
    const list = await svc.listAudiences(ACC, SA);
    expect(list[0].memberCount).toBe(1500);
  });
});
