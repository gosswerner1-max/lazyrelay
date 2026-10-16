// Meta's delivery receipts (sent, delivered, read, failed) and the account events that pause a number. Every delivery is verified
// with THAT connection's own app secret (X-Hub-Signature-256) before anything is stored. A receipt may arrive twice (Meta retries
// for up to 7 days) or out of order: the result is the same. "Delivered" is shown only from these receipts. Supabase is the
// in-memory fake; the payloads are signed with a made-up secret.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { tables, vault } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});
const securityEvents: string[] = [];
vi.mock("../http/securityAlerts.js", () => ({ recordSecurityEvent: (kind: string) => void securityEvents.push(kind) }));

const { processWhatsAppStatusEvent } = await import("./statusWebhook.js");
const kit = await import("./testKit.js");
const { ACC, ACC_OTHER, SA, WABA, PHONE_ID, APP_SECRET, seedWorld, resetTables, setTestEnv, addContact } = kit;
const { messageKeyFor } = await import("../platforms/whatsapp/contactPrivacy.js");
const { serializeWhatsAppBundle } = await import("../platforms/whatsapp/credentials.js");

const BID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SAVED = { ...process.env };
const T = 1_760_616_000; // 2025-10-16 12:00:00 UTC in seconds
const NOW = new Date("2026-10-16T12:00:00.000Z");

const sign = (raw: string, secret = APP_SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
function status(id: string, st: string, over: Record<string, unknown> = {}) {
  return { id, status: st, timestamp: String(T), recipient_id: "27821110001", ...over };
}
function delivery(statuses: unknown[], opts: { waba?: string; phone?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: opts.waba ?? WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "27820000000", phone_number_id: opts.phone ?? PHONE_ID }, statuses } }] }],
  });
}
function accountEvent(field: string, event: string, waba = WABA) {
  return JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field, value: { event, display_phone_number: "27820000000" } }] }] });
}
const run = (raw: string, sig?: string) => processWhatsAppStatusEvent(Buffer.from(raw), sig ?? sign(raw), NOW);

let contact: Record<string, unknown>;
let recipient: Record<string, unknown>;
const rec = () => tables.whatsapp_broadcast_recipients[0];
const bc = () => tables.whatsapp_broadcasts[0];

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  securityEvents.length = 0;
  contact = addContact("+27821110001");
  tables.whatsapp_broadcasts.push({ id: BID, account_id: ACC, social_account_id: SA, status: "sending", template_category: "marketing", template_name: "spring_offer" });
  recipient = {
    id: "rcp1",
    account_id: ACC,
    broadcast_id: BID,
    contact_id: contact.id,
    status: "handed_off",
    message_key: messageKeyFor(ACC, "wamid.ONE"),
    handed_off_at: NOW.toISOString(),
    attempt_count: 1,
    created_at: NOW.toISOString(),
  };
  tables.whatsapp_broadcast_recipients.push(recipient);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("receipts move a recipient forward, and only Meta's receipts say 'delivered'", () => {
  it("sent, delivered, read in order", async () => {
    await run(delivery([status("wamid.ONE", "sent")]));
    expect(rec()).toMatchObject({ status: "sent" });
    await run(delivery([status("wamid.ONE", "delivered")]));
    expect(rec()).toMatchObject({ status: "delivered" });
    expect(rec().delivered_at).toBe(new Date(T * 1000).toISOString());
    await run(delivery([status("wamid.ONE", "read")]));
    expect(rec()).toMatchObject({ status: "read" });
    expect(bc()).toMatchObject({ count_delivered: 0, count_read: 1, count_accepted: 1 });
  });

  it("never goes backwards when receipts arrive out of order", async () => {
    await run(delivery([status("wamid.ONE", "read", { timestamp: String(T + 5) })]));
    await run(delivery([status("wamid.ONE", "delivered", { timestamp: String(T + 1) })]));
    await run(delivery([status("wamid.ONE", "sent", { timestamp: String(T) })]));
    expect(rec().status).toBe("read");
  });

  it("the same receipt delivered again (Meta retries for 7 days) changes nothing and stores one event", async () => {
    const body = delivery([status("wamid.ONE", "delivered")]);
    await run(body);
    const after = JSON.stringify(rec());
    await run(body);
    await run(body);
    expect(JSON.stringify(rec())).toBe(after);
    expect(tables.whatsapp_broadcast_status_events).toHaveLength(1);
  });

  it("several receipts in one delivery are all applied", async () => {
    tables.whatsapp_broadcast_recipients.push({ ...recipient, id: "rcp2", message_key: messageKeyFor(ACC, "wamid.TWO"), contact_id: "c2" });
    await run(delivery([status("wamid.ONE", "delivered"), status("wamid.TWO", "delivered")]));
    expect(tables.whatsapp_broadcast_recipients.map((r) => r.status)).toEqual(["delivered", "delivered"]);
  });

  it("an event row stores keyed hashes, Meta's category and 'billable' - and no number, no message id, no money", async () => {
    await run(delivery([status("wamid.ONE", "delivered", { pricing: { billable: true, pricing_model: "PMP", category: "marketing" } })]));
    const ev = tables.whatsapp_broadcast_status_events[0];
    expect(ev).toMatchObject({ account_id: ACC, social_account_id: SA, broadcast_recipient_id: "rcp1", status: "delivered", pricing_category: "marketing", billable: true });
    expect(ev.event_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev)).not.toMatch(/27821110001|wamid/);
  });

  it("a receipt for a message that is not a broadcast message (an ordinary conversation) is ignored", async () => {
    const out = await run(delivery([status("wamid.UNKNOWN", "delivered")]));
    expect(out).toMatchObject({ statuses: 1, applied: 0, unmatched: 1 });
    expect(tables.whatsapp_broadcast_status_events).toHaveLength(0);
  });

  it("a receipt can only touch its own account's recipient", async () => {
    rec().account_id = ACC_OTHER;
    await run(delivery([status("wamid.ONE", "delivered")]));
    expect(rec().status).toBe("handed_off");
  });
});

describe("signature: this connection's own app secret, or nothing is stored", () => {
  it("a wrong signature, no signature, or a different secret changes nothing and is counted as a security event", async () => {
    const body = delivery([status("wamid.ONE", "delivered")]);
    for (const sig of ["", "sha256=" + "0".repeat(64), sign(body, "someOtherSecret0123456789")]) {
      const out = await processWhatsAppStatusEvent(Buffer.from(body), sig, NOW);
      expect(out.rejected).toBe(1);
    }
    expect(rec().status).toBe("handed_off");
    expect(tables.whatsapp_broadcast_status_events).toHaveLength(0);
    expect(securityEvents).toContain("whatsapp_bad_signature");
  });

  it("a connection with no saved app secret drops the delivery", async () => {
    vault.set("vault-wa-1", serializeWhatsAppBundle({ systemUserToken: kit.TOKEN, wabaId: WABA, phoneNumberId: PHONE_ID }));
    const body = delivery([status("wamid.ONE", "delivered")]);
    const out = await run(body);
    expect(out.blocked).toBe(1);
    expect(rec().status).toBe("handed_off");
  });

  it("an unknown WABA / phone number id, or a disconnected connection, stores nothing", async () => {
    const body = delivery([status("wamid.ONE", "delivered")], { phone: "1111111111" });
    expect((await run(body)).unmatched).toBe(1);
    tables.social_accounts[0].disconnected_at = "2026-10-01T00:00:00Z";
    expect((await run(delivery([status("wamid.ONE", "delivered")]))).unmatched).toBe(1);
    expect(rec().status).toBe("handed_off");
  });

  it("garbage is dropped without throwing", async () => {
    await expect(processWhatsAppStatusEvent(Buffer.from("not json"), "x", NOW)).resolves.toMatchObject({ statuses: 0 });
    await expect(processWhatsAppStatusEvent(Buffer.alloc(0), "", NOW)).resolves.toMatchObject({ statuses: 0 });
    await expect(run(JSON.stringify({ object: "page", entry: [] }))).resolves.toMatchObject({ statuses: 0 });
  });

  it("does nothing unless the feature flags are on, or without the hash key", async () => {
    process.env.WHATSAPP_BROADCASTS_ENABLED = "false";
    expect((await run(delivery([status("wamid.ONE", "delivered")]))).applied).toBe(0);
    process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
    delete process.env.WHATSAPP_CONTACT_HASH_KEY;
    expect((await run(delivery([status("wamid.ONE", "delivered")]))).applied).toBe(0);
    expect(rec().status).toBe("handed_off");
  });
});

describe("failed receipts", () => {
  const failed = (code: number, extra: Record<string, unknown> = {}) => delivery([status("wamid.ONE", "failed", { errors: [{ code, title: "text that must never be kept" }], ...extra })]);

  it("131050 (the person stopped marketing messages): opt-out recorded for good, contact blocked, recipient failed as opted out", async () => {
    await run(failed(131050));
    expect(rec()).toMatchObject({ status: "failed", failure_reason: "recipient_opted_out", error_code: 131050 });
    expect(contact.consent_status).toBe("opted_out");
    expect(tables.whatsapp_opt_outs[0]).toMatchObject({ source: "meta_131050", scope: "marketing", contact_key: contact.contact_key });
    expect(JSON.stringify(tables.whatsapp_opt_outs)).not.toMatch(/27821110001/);
  });

  it("repeating a 131050 receipt does not duplicate the opt-out", async () => {
    await run(failed(131050));
    await run(failed(131050));
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
  });

  it("a restriction or quality code pauses the connection, and the recipient fails", async () => {
    await run(failed(131048));
    expect(rec()).toMatchObject({ status: "failed" });
    expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ social_account_id: SA, pause_reason: "quality", meta_error_code: 131048 });
  });

  it("a template error pauses the broadcast", async () => {
    await run(failed(132015));
    expect(bc()).toMatchObject({ status: "paused", pause_reason: "template_unusable" });
  });

  it("an ordinary failure fails that recipient with the numeric code only; a transient one is NOT re-queued from a receipt", async () => {
    await run(failed(131026));
    expect(rec()).toMatchObject({ status: "failed", failure_reason: "meta_error_131026", error_code: 131026 });
    rec().status = "handed_off";
    rec().failure_reason = null;
    await run(failed(131016, { timestamp: String(T + 9) }));
    expect(rec().status).toBe("failed");
    expect(JSON.stringify(tables.whatsapp_broadcast_recipients)).not.toMatch(/must never be kept/);
  });

  it("a failure that arrives after the message was delivered is ignored", async () => {
    await run(delivery([status("wamid.ONE", "delivered")]));
    await run(failed(131026, { timestamp: String(T + 5) }));
    expect(rec().status).toBe("delivered");
  });

  it("a failure with no error code is still a failure", async () => {
    await run(delivery([status("wamid.ONE", "failed")]));
    expect(rec()).toMatchObject({ status: "failed", failure_reason: "delivery_failed" });
  });
});

describe("account events that pause a number", () => {
  it("a quality flag or downgrade pauses every connection on that business account (quality)", async () => {
    for (const event of ["FLAGGED", "DOWNGRADE"]) {
      tables.whatsapp_connection_send_state = [];
      const out = await run(accountEvent("phone_number_quality_update", event));
      expect(out.paused).toBe(1);
      expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ social_account_id: SA, pause_reason: "quality" });
    }
  });

  it("a disabled or restricted account pauses it (restricted)", async () => {
    await run(accountEvent("account_update", "DISABLED_UPDATE"));
    expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ pause_reason: "restricted" });
  });

  it("harmless events change nothing", async () => {
    await run(accountEvent("phone_number_quality_update", "UPGRADE"));
    await run(accountEvent("account_update", "VERIFIED_ACCOUNT"));
    expect(tables.whatsapp_connection_send_state).toHaveLength(0);
  });

  it("an event with a bad signature pauses nothing", async () => {
    const raw = accountEvent("account_update", "DISABLED_UPDATE");
    await processWhatsAppStatusEvent(Buffer.from(raw), "sha256=" + "1".repeat(64), NOW);
    expect(tables.whatsapp_connection_send_state).toHaveLength(0);
  });

  it("an event for another business account pauses nothing here", async () => {
    await run(accountEvent("account_update", "DISABLED_UPDATE", "999999999"));
    expect(tables.whatsapp_connection_send_state).toHaveLength(0);
  });
});

describe("receipts for chat messages (two-way WhatsApp)", () => {
  let conv: Record<string, unknown>;
  const chat = () => tables.whatsapp_chat_messages[0];
  beforeEach(() => {
    tables.whatsapp_broadcast_recipients = [];
    conv = { id: "conv1", account_id: ACC, social_account_id: SA, contact_key: contact.contact_key, contact_display: contact.contact_display, contact_id: contact.id };
    tables.whatsapp_conversations.push(conv);
    tables.whatsapp_chat_messages.push({ id: "cm1", account_id: ACC, conversation_id: "conv1", direction: "outbound", kind: "text", status: "handed_off", message_key: messageKeyFor(ACC, "wamid.CHAT1"), handed_off_at: NOW.toISOString() });
  });

  it("sent, delivered, read move the chat message forward with Meta's own times", async () => {
    await run(delivery([status("wamid.CHAT1", "sent", { timestamp: String(T) })]));
    expect(chat()).toMatchObject({ status: "sent", sent_at: new Date(T * 1000).toISOString() });
    await run(delivery([status("wamid.CHAT1", "delivered", { timestamp: String(T + 2) })]));
    await run(delivery([status("wamid.CHAT1", "read", { timestamp: String(T + 9) })]));
    expect(chat()).toMatchObject({ status: "read", read_at: new Date((T + 9) * 1000).toISOString() });
  });

  it("is idempotent and never goes backwards", async () => {
    const body = delivery([status("wamid.CHAT1", "read")]);
    await run(body);
    await run(body);
    await run(delivery([status("wamid.CHAT1", "delivered")]));
    expect(chat().status).toBe("read");
  });

  it("a failed receipt with 131050 opts the person out (a stored contact, or by key alone for someone who is not)", async () => {
    await run(delivery([status("wamid.CHAT1", "failed", { errors: [{ code: 131050 }] })]));
    expect(chat()).toMatchObject({ status: "failed", failure_reason: "recipient_opted_out", error_code: 131050 });
    expect(contact.consent_status).toBe("opted_out");

    tables.whatsapp_opt_outs = [];
    conv.contact_id = null;
    contact.consent_status = "opted_in";
    chat().status = "handed_off";
    await run(delivery([status("wamid.CHAT1", "failed", { errors: [{ code: 131050 }], timestamp: String(T + 77) })]));
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
    expect(tables.whatsapp_opt_outs[0]).toMatchObject({ contact_key: contact.contact_key, source: "meta_131050" });
    expect(JSON.stringify(tables.whatsapp_opt_outs)).not.toMatch(/27821110001/);
  });

  it("a restriction code pauses the connection; a failure after delivery is ignored; another account's message is untouched", async () => {
    await run(delivery([status("wamid.CHAT1", "failed", { errors: [{ code: 131048 }] })]));
    expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ pause_reason: "quality" });

    chat().status = "delivered";
    await run(delivery([status("wamid.CHAT1", "failed", { errors: [{ code: 131026 }], timestamp: String(T + 50) })]));
    expect(chat().status).toBe("delivered");

    chat().status = "handed_off";
    chat().account_id = ACC_OTHER;
    await run(delivery([status("wamid.CHAT1", "delivered", { timestamp: String(T + 60) })]));
    expect(chat().status).toBe("handed_off");
  });

  it("a chat receipt does not touch any broadcast's totals", async () => {
    await run(delivery([status("wamid.CHAT1", "delivered")]));
    expect(bc().count_delivered ?? 0).toBe(0);
  });
});
