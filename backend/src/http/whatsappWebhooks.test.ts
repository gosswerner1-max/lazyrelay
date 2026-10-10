// The WhatsApp webhook, over HTTP through the REAL app (buildApp), so the mounting is tested too: public (no sign-in), raw
// body, handshake, signature gate, immediate 200 EVENT_RECEIVED, fail-closed account lookup, storage in the DM cache,
// the hand-off to triage, and that no message text, name or phone number is ever logged. Supabase is the in-memory fake,
// triage is a mock, Meta is simulated by signing payloads with a fake secret. Nothing real is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tables } from "../testFakeSupabase.js";

const triage = vi.hoisted(() => ({ calls: [] as Array<{ accountId: string; type: string; items: Array<Record<string, string>> }>, impl: null as null | (() => Promise<unknown>) }));
vi.mock("../commentTriage.js", () => ({
  triageItems: vi.fn(async (accountId: string, type: string, items: Array<Record<string, string>>) => {
    triage.calls.push({ accountId, type, items });
    if (triage.impl) await triage.impl();
    return new Map();
  }),
}));
vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) }, createUserClient: vi.fn() };
});
// 30 requests a minute per IP is right in production and would stop this test file after a handful of calls.
vi.mock("./rateLimit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rateLimit.js")>();
  return { ...actual, publicRateLimit: (_r: unknown, _s: unknown, next: () => void) => next() };
});

const { supabase } = await import("../supabase.js");
const { buildApp } = await import("./app.js");
const { StubMorAdapter } = await import("../billing/stub.js");
const { extractWhatsAppTextMessages, whatsAppWebhookIdle } = await import("./whatsappWebhooks.js");

// Fake values that merely look the right shape. None is a real credential.
const VERIFY_TOKEN = "test-verify-token-not-real-0123456789";
const APP_SECRET = "test-app-secret-not-real-0123456789";
const WABA = "123456789012345";
const PHONE = "109876543210987";
const FROM = "27820001111";
const AT = Math.floor(Date.UTC(2026, 9, 10, 10, 0, 0) / 1000); // 2026-10-10T10:00:00Z
const AT_ISO = "2026-10-10T10:00:00+00:00";

const app = () => buildApp(new StubMorAdapter(), new Map());
const sign = (body: string, secret = APP_SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

interface Msg {
  from?: string;
  id?: string;
  type?: string;
  text?: string | null;
  timestamp?: number | string;
}
function delivery(opts: { waba?: string; phone?: string; messages?: Msg[]; names?: Record<string, string>; extra?: Record<string, unknown> } = {}) {
  const messages = (opts.messages ?? [{}]).map((m, i) => ({
    from: m.from ?? FROM,
    id: m.id ?? `wamid.TEST${i}`,
    timestamp: String(m.timestamp ?? AT),
    type: m.type ?? "text",
    ...(m.type && m.type !== "text" ? {} : { text: { body: m.text === undefined ? "Hi, how much is the premium plan?" : m.text } }),
  }));
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: opts.waba ?? WABA,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "27821234567", phone_number_id: opts.phone ?? PHONE },
              contacts: Object.entries(opts.names ?? { [FROM]: "Thandi Mokoena" }).map(([wa_id, name]) => ({ wa_id, profile: { name } })),
              messages,
              ...(opts.extra ?? {}),
            },
          },
        ],
      },
    ],
  });
}
const send = (body: string, sig: string | null = sign(body)) => {
  const r = request(app()).post("/api/webhooks/whatsapp").set("Content-Type", "application/json");
  if (sig !== null) r.set("X-Hub-Signature-256", sig);
  return r.send(body);
};

const account = (over: Record<string, unknown> = {}) => ({
  id: "sa1", account_id: "acc1", platform: "whatsapp", platform_account_id: PHONE,
  whatsapp_business_account_id: WABA, whatsapp_phone_number_id: PHONE,
  byok_status: "valid", paused_at: null, disconnected_at: null, credential_mode: "byok", ...over,
});
const setTier = (tier: string, acc = "acc1") => {
  tables.subscriptions = (tables.subscriptions ?? []).filter((r) => r.account_id !== acc);
  tables.subscriptions.push({ account_id: acc, tier, status: "active" });
};
const stored = () => tables.dm_conversations_cache ?? [];

let logged: string[];
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.social_accounts = [account()];
  setTier("business");
  triage.calls = [];
  triage.impl = null;
  process.env.WHATSAPP_BYOK_ENABLED = "true";
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  logged = [];
  const grab = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
});
afterEach(async () => {
  await whatsAppWebhookIdle();
  vi.restoreAllMocks();
  for (const k of ["WHATSAPP_BYOK_ENABLED", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]) delete process.env[k];
});

describe("GET /api/webhooks/whatsapp: Meta's handshake, public", () => {
  const hs = (q: Record<string, string>) => request(app()).get("/api/webhooks/whatsapp").query(q);

  it("echoes the challenge as plain text when the mode and the token are right, with no sign-in of any kind", async () => {
    const r = await hs({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" });
    expect(r.status).toBe(200);
    expect(r.text).toBe("1158201444");
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("refuses a wrong token, a wrong mode, a missing token or challenge, and an oversized challenge", async () => {
    for (const q of [
      { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" },
      { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" },
      { "hub.mode": "subscribe", "hub.challenge": "1" },
      { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN },
      { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "x".repeat(300) },
      {},
    ]) {
      const r = await hs(q);
      expect(r.status, JSON.stringify(q)).toBe(403);
      expect(r.text).toBe("");
    }
  });

  it("a challenge is never interpreted as markup", async () => {
    const r = await hs({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "<script>alert(1)</script>" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("is a 404 while the feature is off, and a 500 (fail closed) if the verify token is not configured", async () => {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    expect((await hs({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" })).status).toBe(500);
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
    process.env.WHATSAPP_BYOK_ENABLED = "off";
    expect((await hs({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" })).status).toBe(404);
  });
});

describe("POST /api/webhooks/whatsapp: the signature is the gate", () => {
  it("a missing, wrong or mismatched signature gets 403 and touches nothing", async () => {
    const body = delivery();
    for (const sig of [null, "", "sha256=deadbeef", sign(body, "some-other-secret"), sign(body + " ")]) {
      const r = await send(body, sig);
      expect(r.status, String(sig)).toBe(403);
    }
    await whatsAppWebhookIdle();
    expect(stored()).toHaveLength(0);
    expect(triage.calls).toHaveLength(0);
  });

  it("a body edited after signing is refused", async () => {
    const body = delivery();
    const r = await send(body.replace("premium", "free"), sign(body));
    expect(r.status).toBe(403);
    expect(triage.calls).toHaveLength(0);
  });

  it("a delivery that is not JSON content cannot match a signature, even with a correct one for its bytes", async () => {
    const body = delivery();
    const r = await request(app()).post("/api/webhooks/whatsapp").set("Content-Type", "text/plain").set("X-Hub-Signature-256", sign(body)).send(body);
    expect(r.status).toBe(403);
    expect(stored()).toHaveLength(0);
  });

  it("fails closed with a 500 if the app secret is not configured, and is a 404 while the feature is off", async () => {
    const body = delivery();
    delete process.env.WHATSAPP_APP_SECRET;
    expect((await send(body)).status).toBe(500);
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_BYOK_ENABLED = "off";
    expect((await send(body)).status).toBe(404);
    expect(stored()).toHaveLength(0);
  });

  it("an oversized body is refused before it is parsed", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", pad: "x".repeat(1_100_000) });
    const r = await send(body);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(stored()).toHaveLength(0);
  });

  it("the route sits before the dashboard's authenticated router and the CORS policy, in app.ts", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.ts"), "utf8");
    const mount = src.indexOf('app.post(\n    "/api/webhooks/whatsapp"');
    const mountCrlf = src.indexOf('app.post(\r\n    "/api/webhooks/whatsapp"');
    const at = mount >= 0 ? mount : mountCrlf;
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf('app.use("/api", buildRouter('));
    expect(at).toBeLessThan(src.indexOf("allowedOrigins") > 0 ? src.indexOf("allowedOrigins") : src.indexOf("cors("));
    expect(src).toMatch(/"\/api\/webhooks\/whatsapp",\s+publicRateLimit,\s+express\.raw\(\{ type: "application\/json", limit: "1mb" \}\)/);
  });
});

describe("a valid delivery: answered at once, processed after", () => {
  it("answers 200 EVENT_RECEIVED while triage is still running, then stores the conversation and hands the text to triage", async () => {
    let release: () => void = () => {};
    triage.impl = () => new Promise<void>((resolve) => (release = resolve));
    const r = await send(delivery());
    expect(r.status).toBe(200);
    expect(r.text).toBe("EVENT_RECEIVED");
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    // The answer is out while the work is not finished: the row is stored, triage is mid-call.
    await vi.waitFor(() => expect(triage.calls).toHaveLength(1));
    release();
    await whatsAppWebhookIdle();

    expect(stored()).toEqual([
      expect.objectContaining({
        account_id: "acc1",
        social_account_id: "sa1",
        conversation_id: FROM,
        participant_id: FROM,
        participant_name: "Thandi Mokoena",
        snippet: "Hi, how much is the premium plan?",
        conversation_updated_at: "2026-10-10T10:00:00.000Z",
      }),
    ]);
    expect(triage.calls).toEqual([
      { accountId: "acc1", type: "dm", items: [{ itemId: FROM, sourceSignature: AT_ISO, author: "Thandi Mokoena", text: "Hi, how much is the premium plan?" }] },
    ]);
  });

  it("uses a neutral name when Meta sent none, and strips line breaks from a name", async () => {
    await send(delivery({ names: {} }));
    await whatsAppWebhookIdle();
    expect(stored()[0].participant_name).toBe("WhatsApp contact");
    for (const k of Object.keys(tables)) delete tables[k];
    tables.social_accounts = [account()];
    setTier("business");
    await send(delivery({ names: { [FROM]: "Line\r\nBreak\nName" } }));
    await whatsAppWebhookIdle();
    expect(stored()[0].participant_name).toBe("Line Break Name");
  });

  it("an answer of 200 does not depend on the work: a failing lookup is logged by message only and the answer already went out", async () => {
    vi.spyOn(supabase, "from").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const r = await send(delivery());
    expect(r.status).toBe(200);
    await whatsAppWebhookIdle();
    expect(logged.join("\n")).toMatch(/processing failed: db down/);
    expect(logged.join("\n")).not.toMatch(/Thandi|premium|27820001111/);
  });

  it("a delivery that is valid JSON-wise garbage, or not JSON, stores nothing and still answers 200", async () => {
    for (const body of ["not json at all", "{}", JSON.stringify({ object: "page", entry: [] }), JSON.stringify({ object: "whatsapp_business_account", entry: "nope" })]) {
      expect((await send(body)).status).toBe(200);
    }
    await whatsAppWebhookIdle();
    expect(stored()).toHaveLength(0);
    expect(triage.calls).toHaveLength(0);
  });
});

describe("fail closed: an unknown number, a refused account", () => {
  const deliver = async (body = delivery()) => {
    const r = await send(body);
    await whatsAppWebhookIdle();
    return r;
  };
  const nothingHappened = () => {
    expect(stored()).toHaveLength(0);
    expect(triage.calls).toHaveLength(0);
  };

  it("a phone number id that matches no row stores nothing and calls no AI", async () => {
    expect((await deliver(delivery({ phone: "999999999999999" }))).status).toBe(200); // Meta still gets its 200
    nothingHappened();
  });

  it("BOTH ids must belong to the same row: a right WABA with another account's phone number id, or the reverse, matches nothing", async () => {
    tables.social_accounts = [account(), account({ id: "sa2", account_id: "acc2", whatsapp_business_account_id: "555555555555555", whatsapp_phone_number_id: "444444444444444", platform_account_id: "444444444444444" })];
    setTier("business", "acc2");
    await deliver(delivery({ waba: WABA, phone: "444444444444444" }));
    await deliver(delivery({ waba: "555555555555555", phone: PHONE }));
    nothingHappened();
  });

  it("a disconnected connection stores nothing", async () => {
    tables.social_accounts = [account({ disconnected_at: "2026-10-09T00:00:00Z" })];
    await deliver();
    nothingHappened();
  });

  it("an account whose own keys are out of credit stores nothing and calls no AI", async () => {
    tables.social_accounts = [account({ byok_status: "out_of_credit" })];
    await deliver();
    nothingHappened();
    expect(logged.join("\n")).toMatch(/blocked=1/);
  });

  it("a paused connection stores nothing", async () => {
    tables.social_accounts = [account({ paused_at: "2026-10-09T00:00:00Z" })];
    await deliver();
    nothingHappened();
  });

  it("a plan below Business (a downgrade after connecting) stores nothing and costs no AI call; so does no subscription", async () => {
    for (const tier of ["free", "starter", "pro"]) {
      setTier(tier);
      await deliver();
      nothingHappened();
    }
    tables.subscriptions = [];
    await deliver();
    nothingHappened();
  });

  it("Business, Agency and Agency Plus are stored", async () => {
    for (const tier of ["business", "agency", "agency_plus"]) {
      for (const k of ["dm_conversations_cache"]) delete tables[k];
      triage.calls = [];
      setTier(tier);
      await deliver();
      expect(stored(), tier).toHaveLength(1);
      expect(triage.calls, tier).toHaveLength(1);
    }
  });
});

describe("what is stored", () => {
  const deliver = async (body: string) => {
    await send(body);
    await whatsAppWebhookIdle();
  };

  it("skips everything that is not plain text: delivery receipts, images, reactions, empty text, a bad sender id", async () => {
    await deliver(
      delivery({
        messages: [{ type: "image" }, { type: "reaction" }, { text: "   " }, { from: "not-a-number" }, { from: "123" }],
        extra: { statuses: [{ id: "wamid.X", status: "delivered", recipient_id: FROM }] },
      }),
    );
    expect(stored()).toHaveLength(0);
    expect(triage.calls).toHaveLength(0);
  });

  it("keeps one conversation per contact (the newest message of the delivery) and sends all contacts to triage in one call", async () => {
    const OTHER = "27830002222";
    await deliver(
      delivery({
        messages: [
          { from: FROM, text: "first", timestamp: AT },
          { from: FROM, text: "second, newest", timestamp: AT + 60 },
          { from: OTHER, text: "hello from someone else", timestamp: AT + 10 },
        ],
        names: { [FROM]: "Thandi", [OTHER]: "Pieter" },
      }),
    );
    expect(stored().map((r) => [r.conversation_id, r.snippet]).sort()).toEqual([[FROM, "second, newest"], [OTHER, "hello from someone else"]]);
    expect(triage.calls).toHaveLength(1);
    expect(triage.calls[0].items.map((i) => i.itemId).sort()).toEqual([FROM, OTHER]);
  });

  it("an older or repeated delivery never overwrites a newer stored message, and a repeat costs no second AI call", async () => {
    await deliver(delivery({ messages: [{ text: "newer", timestamp: AT + 100 }] }));
    expect(triage.calls).toHaveLength(1);
    await deliver(delivery({ messages: [{ text: "older", timestamp: AT }] }));
    await deliver(delivery({ messages: [{ text: "newer", timestamp: AT + 100 }] })); // Meta retry of the first delivery
    expect(stored()).toHaveLength(1);
    expect(stored()[0].snippet).toBe("newer");
    expect(triage.calls).toHaveLength(1);
  });

  it("a newer message from the same contact replaces the snippet and is triaged again", async () => {
    await deliver(delivery({ messages: [{ text: "one", timestamp: AT }] }));
    await deliver(delivery({ messages: [{ text: "two", timestamp: AT + 30 }] }));
    expect(stored()).toHaveLength(1);
    expect(stored()[0].snippet).toBe("two");
    expect(triage.calls).toHaveLength(2);
  });

  it("caps the stored and triaged text at 1000 characters", async () => {
    await deliver(delivery({ messages: [{ text: "a".repeat(5000) }] }));
    expect((stored()[0].snippet as string).length).toBe(1000);
    expect(triage.calls[0].items[0].text.length).toBe(1000);
  });

  it("caps the work one delivery can cause at 200 messages", async () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({ from: String(27800000000 + i), text: `m${i}` }));
    await deliver(delivery({ messages, names: {} }));
    expect(stored()).toHaveLength(200);
  });

  it("a number connected under two accounts is kept for each, under its own account id and own AI call", async () => {
    tables.social_accounts = [account(), account({ id: "sa2", account_id: "acc2" })];
    setTier("agency", "acc2");
    await deliver(delivery());
    expect(stored().map((r) => [r.account_id, r.social_account_id]).sort()).toEqual([["acc1", "sa1"], ["acc2", "sa2"]]);
    expect(triage.calls.map((c) => c.accountId).sort()).toEqual(["acc1", "acc2"]);
    // acc2 downgrades: only acc1 is served
    for (const k of ["dm_conversations_cache"]) delete tables[k];
    triage.calls = [];
    setTier("pro", "acc2");
    await deliver(delivery({ messages: [{ timestamp: AT + 500 }] }));
    expect(stored().map((r) => r.account_id)).toEqual(["acc1"]);
  });

  it("a triage failure never loses the stored message and never crashes the process", async () => {
    triage.impl = () => Promise.reject(new Error("model unavailable"));
    await deliver(delivery());
    expect(stored()).toHaveLength(1);
    expect(logged.join("\n")).toMatch(/triage failed: model unavailable/);
  });
});

describe("privacy: nothing the sender wrote is logged", () => {
  it("across success, refusals, failures and bad deliveries, no log line holds a message, a name or a phone number", async () => {
    const secretText = "my card number is 4111 1111 1111 1111";
    const body = delivery({ messages: [{ text: secretText }], names: { [FROM]: "Thandi Mokoena" } });
    await send(body); // stored
    await send(body, "sha256=bad"); // refused
    tables.social_accounts = [account({ byok_status: "out_of_credit" })];
    await send(delivery({ messages: [{ text: secretText, timestamp: AT + 9 }] })); // blocked
    triage.impl = () => Promise.reject(new Error("boom"));
    tables.social_accounts = [account()];
    await send(delivery({ messages: [{ text: secretText, timestamp: AT + 99 }] })); // triage fails
    await send("not json");
    await whatsAppWebhookIdle();
    const all = logged.join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const needle of [secretText, "4111", "Thandi", "Mokoena", FROM, "27821234567", APP_SECRET, VERIFY_TOKEN]) expect(all, needle).not.toContain(needle);
  });
});

describe("extractWhatsAppTextMessages (the parser alone)", () => {
  it("returns plain text messages with their sender, name, number ids and time", () => {
    const { messages, skipped } = extractWhatsAppTextMessages(JSON.parse(delivery()));
    expect(skipped).toBe(0);
    expect(messages).toEqual([{ wabaId: WABA, phoneNumberId: PHONE, from: FROM, name: "Thandi Mokoena", text: "Hi, how much is the premium plan?", at: new Date(AT * 1000) }]);
  });

  it("never throws on anything, and returns nothing for what it does not understand", () => {
    for (const junk of [null, undefined, 5, "x", [], {}, { object: "whatsapp_business_account" }, { object: "whatsapp_business_account", entry: [null, 3, { changes: "x" }, { id: WABA, changes: [{ field: "messages", value: null }] }] }]) {
      expect(() => extractWhatsAppTextMessages(junk)).not.toThrow();
      expect(extractWhatsAppTextMessages(junk).messages).toEqual([]);
    }
  });

  it("only reads the messages field, and rejects ids that are not numeric", () => {
    const p = JSON.parse(delivery());
    p.entry[0].changes[0].field = "message_template_status_update";
    expect(extractWhatsAppTextMessages(p).messages).toEqual([]);
    const q = JSON.parse(delivery({ waba: "abc" }));
    expect(extractWhatsAppTextMessages(q).messages).toEqual([]);
    const r = JSON.parse(delivery({ phone: "1 OR 1=1" }));
    expect(extractWhatsAppTextMessages(r).messages).toEqual([]);
  });

  it("falls back to now for a missing or nonsense timestamp", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const p = JSON.parse(delivery());
    p.entry[0].changes[0].value.messages[0].timestamp = "soon";
    expect(extractWhatsAppTextMessages(p, now).messages[0].at).toEqual(now);
  });
});
