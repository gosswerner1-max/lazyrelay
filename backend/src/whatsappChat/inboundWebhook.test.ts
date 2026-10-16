// The inbound chat webhook path: a delivery is verified with the connection's OWN app secret before anything is stored, and the
// feature needs the send flag, a paid plan and both contact keys. Same fake database, signed payloads, no network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { tables, vault } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("../whatsappBroadcast/testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});
const securityEvents: string[] = [];
vi.mock("../http/securityAlerts.js", () => ({ recordSecurityEvent: (kind: string) => void securityEvents.push(kind) }));

const { processWhatsAppChatEvent } = await import("./inboundWebhook.js");
const kit = await import("../whatsappBroadcast/testKit.js");
const { ACC, WABA, PHONE_ID, APP_SECRET, TOKEN, seedWorld, resetTables, setTestEnv } = kit;
const { serializeWhatsAppBundle } = await import("../platforms/whatsapp/credentials.js");

const SAVED = { ...process.env };
const NOW = new Date("2026-10-16T12:00:00.000Z");
const sign = (raw: string, secret = APP_SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const body = (messages: unknown[], opts: { waba?: string; phone?: string } = {}) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: opts.waba ?? WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: opts.phone ?? PHONE_ID }, contacts: [{ wa_id: "27829990001", profile: { name: "Pablo" } }], messages } }] }] });
const msg = (id: string, text: string) => ({ from: "27829990001", id, timestamp: String(Math.floor(NOW.getTime() / 1000) - 10), type: "text", text: { body: text } });
const run = (raw: string, sig?: string) => processWhatsAppChatEvent(Buffer.from(raw), sig ?? sign(raw), NOW);

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  securityEvents.length = 0;
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("processWhatsAppChatEvent", () => {
  it("stores a verified inbound message", async () => {
    const out = await run(body([msg("wamid.A1234", "hello")]));
    expect(out).toMatchObject({ messages: 1, stored: 1 });
    expect(tables.whatsapp_chat_messages).toHaveLength(1);
  });

  it("is idempotent: the same delivery twice stores one message", async () => {
    const raw = body([msg("wamid.A1234", "hello")]);
    await run(raw);
    await run(raw);
    expect(tables.whatsapp_chat_messages).toHaveLength(1);
  });

  it("a wrong, missing or foreign signature stores nothing", async () => {
    const raw = body([msg("wamid.A1234", "hello")]);
    for (const sig of ["", "sha256=" + "0".repeat(64), sign(raw, "otherSecret0123456789")]) {
      expect((await processWhatsAppChatEvent(Buffer.from(raw), sig, NOW)).rejected).toBe(1);
    }
    expect(tables.whatsapp_chat_messages).toHaveLength(0);
    expect(tables.whatsapp_conversations).toHaveLength(0);
  });

  it("a connection with no saved app secret drops the delivery", async () => {
    vault.set("vault-wa-1", serializeWhatsAppBundle({ systemUserToken: TOKEN, wabaId: WABA, phoneNumberId: PHONE_ID }));
    expect((await run(body([msg("wamid.A1234", "hello")]))).blocked).toBe(1);
    expect(tables.whatsapp_chat_messages).toHaveLength(0);
  });

  it("an unknown business account or phone number id, or a disconnected connection, stores nothing", async () => {
    expect((await run(body([msg("wamid.A1234", "hello")], { phone: "1111111111" }))).unmatched).toBe(1);
    tables.social_accounts[0].disconnected_at = "2026-10-01T00:00:00Z";
    expect((await run(body([msg("wamid.A1234", "hello")]))).unmatched).toBe(1);
    expect(tables.whatsapp_chat_messages).toHaveLength(0);
  });

  it("a plan that is not paid stores nothing", async () => {
    tables.subscriptions = [];
    expect((await run(body([msg("wamid.A1234", "hello")]))).blocked).toBe(1);
    expect(tables.whatsapp_chat_messages).toHaveLength(0);
  });

  it("does nothing unless WHATSAPP_SEND_ENABLED (and the feature flags) are on", async () => {
    for (const name of ["WHATSAPP_SEND_ENABLED", "WHATSAPP_BROADCASTS_ENABLED", "WHATSAPP_BYOK_ENABLED"]) {
      process.env[name] = "false";
      expect((await run(body([msg("wamid.A1234", "hello")]))).messages).toBe(0);
      process.env[name] = "true";
    }
    expect(tables.whatsapp_chat_messages).toHaveLength(0);
  });

  it("does nothing without both contact keys (fail closed)", async () => {
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    expect((await run(body([msg("wamid.A1234", "hello")]))).messages).toBe(0);
    expect(tables.whatsapp_chat_messages).toHaveLength(0);
  });

  it("garbage is dropped without throwing", async () => {
    await expect(processWhatsAppChatEvent(Buffer.from("nope"), "x", NOW)).resolves.toMatchObject({ messages: 0 });
  });

  it("a forged delivery of button taps (which the older text-only handler never looks at) is counted as a security event", async () => {
    const tap = { from: "27829990001", id: "wamid.T1234", timestamp: "1760616000", type: "interactive", context: { id: "wamid.OUT1" }, interactive: { type: "button_reply", button_reply: { id: "approve", title: "Approve" } } };
    await processWhatsAppChatEvent(Buffer.from(body([tap])), "sha256=" + "1".repeat(64), NOW);
    expect(securityEvents).toContain("whatsapp_bad_signature");
  });
});
