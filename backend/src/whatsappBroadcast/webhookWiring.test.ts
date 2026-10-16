// The existing WhatsApp webhook handler now also (1) applies delivery receipts and account events for broadcasts and (2) turns a
// STOP-style inbound reply into an opt-out. This checks the wiring through handleWhatsAppWebhookEvent itself, with signed
// payloads, the in-memory fake database and no network. The feature flags gate both additions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { tables } from "../testFakeSupabase.js";

vi.mock("../posthogClient.js", () => ({ createAnthropicClient: () => ({ messages: { create: async () => ({ content: [{ type: "text", text: "[]" }] }) } }) }));
vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) }, createUserClient: vi.fn() };
});

const { handleWhatsAppWebhookEvent, whatsAppWebhookIdle } = await import("../http/whatsappWebhooks.js");
const kit = await import("./testKit.js");
const { ACC, WABA, PHONE_ID, APP_SECRET, seedWorld, resetTables, setTestEnv, addContact } = kit;
const { messageKeyFor } = await import("../platforms/whatsapp/contactPrivacy.js");

const SAVED = { ...process.env };
const sign = (raw: string) => "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");

async function deliver(value: Record<string, unknown>) {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "27820000000", phone_number_id: PHONE_ID }, ...value } }] }] });
  const sent: { status?: number } = {};
  const res = { status: (n: number) => ((sent.status = n), res), type: () => res, send: () => res, end: () => res };
  const req = { body: Buffer.from(raw), header: (h: string) => (h.toLowerCase() === "x-hub-signature-256" ? sign(raw) : undefined) };
  handleWhatsAppWebhookEvent(req as never, res as never);
  await whatsAppWebhookIdle();
  return sent.status;
}

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  tables.whatsapp_messages = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

const inbound = (from: string, text: string, id = "wamid.IN1") => ({ contacts: [{ wa_id: from, profile: { name: "Thandi" } }], messages: [{ from, id, timestamp: "1760616000", type: "text", text: { body: text } }] });

describe("handleWhatsAppWebhookEvent: broadcast additions", () => {
  it("answers 200 at once and applies a delivery receipt to its broadcast recipient", async () => {
    const c = addContact("+27821110001");
    tables.whatsapp_broadcast_recipients.push({ id: "r1", account_id: ACC, broadcast_id: "b1", contact_id: c.id, status: "handed_off", message_key: messageKeyFor(ACC, "wamid.ONE"), handed_off_at: new Date().toISOString() });
    tables.whatsapp_broadcasts.push({ id: "b1", account_id: ACC, social_account_id: kit.SA, status: "sending", template_category: "marketing" });
    const status = await deliver({ statuses: [{ id: "wamid.ONE", status: "delivered", timestamp: "1760616000", recipient_id: "27821110001" }] });
    expect(status).toBe(200);
    expect(tables.whatsapp_broadcast_recipients[0].status).toBe("delivered");
  });

  it("a STOP reply opts the contact out and the message is still stored as before", async () => {
    const c = addContact("+27821110001");
    await deliver(inbound("27821110001", "STOP"));
    expect(c.consent_status).toBe("opted_out");
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
    expect(tables.whatsapp_messages).toHaveLength(1);
  });

  it("an ordinary message does not opt anyone out", async () => {
    const c = addContact("+27821110001");
    await deliver(inbound("27821110001", "stop the car"));
    expect(c.consent_status).toBe("opted_in");
    expect(tables.whatsapp_opt_outs).toHaveLength(0);
  });

  it("with the broadcast feature OFF neither addition does anything (the old inbound behaviour is untouched)", async () => {
    process.env.WHATSAPP_BROADCASTS_ENABLED = "false";
    const c = addContact("+27821110001");
    await deliver(inbound("27821110001", "STOP"));
    expect(c.consent_status).toBe("opted_in");
    expect(tables.whatsapp_opt_outs).toHaveLength(0);
    expect(tables.whatsapp_messages).toHaveLength(1);
  });

  it("a STOP with a bad signature is ignored", async () => {
    const c = addContact("+27821110001");
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_ID }, ...inbound("27821110001", "STOP") } }] }] });
    const res = { status: () => res, type: () => res, send: () => res, end: () => res };
    handleWhatsAppWebhookEvent({ body: Buffer.from(raw), header: () => "sha256=" + "0".repeat(64) } as never, res as never);
    await whatsAppWebhookIdle();
    expect(c.consent_status).toBe("opted_in");
  });
});
