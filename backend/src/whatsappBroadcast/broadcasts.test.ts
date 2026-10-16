// Creating, previewing, listing and cancelling a broadcast. Supabase is the in-memory fake; nothing here sends a message.
// Every refusal has a stable code. Cost is an ESTIMATE from the customer's own rate card, never a Meta figure.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { createBroadcast, listBroadcasts, getBroadcast, cancelBroadcast, refreshCounts, estimateCost } = await import("./broadcasts.js");
const { ACC, ACC_OTHER, SA, TEMPLATE_ID, seedWorld, resetTables, setTestEnv, addContact, addOptOut } = await import("./testKit.js");

const NOW = new Date("2026-10-16T12:00:00.000Z");
const IN_1H = new Date(NOW.getTime() + 3_600_000);
const ctx = { accountId: ACC, createdBy: "33333333-3333-4333-8333-333333333333" };
const input = (over: Record<string, unknown> = {}) => ({ socialAccountId: SA, templateId: TEMPLATE_ID, name: "Spring sale", params: ["Friend", "20%"], scheduledFor: IN_1H, ...over });
const create = (over: Record<string, unknown> = {}, opts: { dryRun?: boolean } = {}) => createBroadcast(ctx, input(over) as never, { dryRun: opts.dryRun ?? false, now: NOW });

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  addContact("+27821110001");
  addContact("+27821110002");
  addContact("+14155550100"); // a US number
});

describe("createBroadcast", () => {
  it("schedules a broadcast: a snapshot of the template, the params, who scheduled it, and the audience size", async () => {
    const out = await create();
    expect(out.ok).toBe(true);
    expect(tables.whatsapp_broadcasts).toHaveLength(1);
    expect(tables.whatsapp_broadcasts[0]).toMatchObject({
      account_id: ACC,
      social_account_id: SA,
      template_id: TEMPLATE_ID,
      template_name: "spring_offer",
      template_language: "en_US",
      template_category: "marketing",
      template_params: ["Friend", "20%"],
      name: "Spring sale",
      status: "scheduled",
      scheduled_for: IN_1H.toISOString(),
      audience_estimate: 2,
      created_by: ctx.createdBy,
    });
    if (out.ok) expect(out.broadcast).toMatchObject({ status: "scheduled", templateName: "spring_offer", scheduledFor: IN_1H.toISOString() });
  });

  it("a US (+1) number is not in a MARKETING audience, and the preview says how many were left out", async () => {
    const out = await create({}, { dryRun: true });
    expect(out.ok && out.preview).toMatchObject({ audience: 2, excludedUs: 1 });
  });

  it("a utility template does include +1 numbers", async () => {
    tables.whatsapp_message_templates[0].category = "utility";
    const out = await create({}, { dryRun: true });
    expect(out.ok && out.preview).toMatchObject({ audience: 3, excludedUs: 0 });
  });

  it("opted-out contacts are not counted", async () => {
    const c = addContact("+27821110003");
    c.consent_status = "opted_out";
    addOptOut(c);
    const out = await create({}, { dryRun: true });
    expect(out.ok && out.preview.audience).toBe(2);
  });

  it("only this connection's contacts are counted", async () => {
    addContact("+27821110009", { social_account_id: "other-connection" });
    const out = await create({}, { dryRun: true });
    expect(out.ok && out.preview.audience).toBe(2);
  });

  it("dryRun writes nothing and returns the preview, with an ESTIMATED cost from the customer's own rate card", async () => {
    tables.whatsapp_rate_cards = [{ account_id: ACC, social_account_id: SA, currency: "USD", marketing_per_message: 0.05, utility_per_message: 0.01, authentication_per_message: 0.01 }];
    const out = await create({}, { dryRun: true });
    expect(tables.whatsapp_broadcasts).toHaveLength(0);
    expect(out.ok && out.broadcast).toBeUndefined();
    expect(out.ok && out.preview.estimatedCost).toEqual({ amount: 0.1, currency: "USD", isEstimate: true });
  });

  it("without a rate card there is no cost figure at all (never a guess)", async () => {
    const out = await create({}, { dryRun: true });
    expect(out.ok && out.preview.estimatedCost).toBeNull();
  });

  const refused: Array<[string, () => void | Promise<void>, Record<string, unknown>, string]> = [
    ["a free plan", () => void (tables.subscriptions = []), {}, "plan"],
    ["no stored login", () => void (tables.social_accounts[0].access_token_vault_id = null), {}, "no_own_credentials"],
    ["a paused connection", () => void (tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: NOW.toISOString(), pause_reason: "quality" }]), {}, "connection_paused"],
    ["a template that does not exist", () => {}, { templateId: "99999999-9999-4999-8999-999999999999" }, "template_not_found"],
    ["a pending template", () => void (tables.whatsapp_message_templates[0].status = "pending"), {}, "template_unusable"],
    ["an unsupported template", () => void (tables.whatsapp_message_templates[0].supported = false), {}, "template_unusable"],
    ["too few variables", () => {}, { params: ["Friend"] }, "params_mismatch"],
    ["too many variables", () => {}, { params: ["a", "b", "c"] }, "params_mismatch"],
    ["a blank variable", () => {}, { params: ["Friend", "   "] }, "params_mismatch"],
    ["a time in the past", () => {}, { scheduledFor: new Date(NOW.getTime() - 1000) }, "schedule_invalid"],
    ["a time less than a minute away", () => {}, { scheduledFor: new Date(NOW.getTime() + 20_000) }, "schedule_invalid"],
    ["a time over 30 days away", () => {}, { scheduledFor: new Date(NOW.getTime() + 31 * 86_400_000) }, "schedule_invalid"],
    ["an invalid time", () => {}, { scheduledFor: new Date("nope") }, "schedule_invalid"],
    ["an empty name", () => {}, { name: "  " }, "name_invalid"],
    ["a name that is a phone number", () => {}, { name: "+27 82 111 0001" }, "name_invalid"],
  ];
  it.each(refused)("refuses %s", async (_label, arrange, over, code) => {
    await arrange();
    const out = await create(over);
    expect(out).toMatchObject({ ok: false, code });
    expect(tables.whatsapp_broadcasts).toHaveLength(0);
  });

  it("refuses a template that belongs to another account's connection", async () => {
    tables.whatsapp_message_templates[0].account_id = ACC_OTHER;
    expect(await create()).toMatchObject({ ok: false, code: "template_not_found" });
  });

  it("refuses an empty audience", async () => {
    tables.whatsapp_contacts = [];
    expect(await create()).toMatchObject({ ok: false, code: "empty_audience" });
  });

  it("stores no phone number anywhere in the broadcast row", async () => {
    await create();
    expect(JSON.stringify(tables.whatsapp_broadcasts)).not.toMatch(/2782111|\+27|4155550100/);
  });
});

describe("cancelBroadcast", () => {
  it("cancels a scheduled broadcast", async () => {
    await create();
    const id = tables.whatsapp_broadcasts[0].id as string;
    expect(await cancelBroadcast(ACC, id, NOW)).toEqual({ ok: true, status: "cancelled" });
    expect(tables.whatsapp_broadcasts[0]).toMatchObject({ status: "cancelled", cancelled_at: NOW.toISOString() });
  });

  it("cancelling a sending broadcast stops further claims and skips everything still queued", async () => {
    await create();
    const b = tables.whatsapp_broadcasts[0];
    b.status = "sending";
    tables.whatsapp_broadcast_recipients = [
      { id: "r1", account_id: ACC, broadcast_id: b.id, contact_id: "c1", status: "queued" },
      { id: "r2", account_id: ACC, broadcast_id: b.id, contact_id: "c2", status: "handed_off" },
    ];
    expect(await cancelBroadcast(ACC, b.id as string, NOW)).toEqual({ ok: true, status: "cancelled" });
    expect(tables.whatsapp_broadcast_recipients.map((r) => r.status)).toEqual(["skipped", "handed_off"]);
    expect(tables.whatsapp_broadcast_recipients[0].skip_reason).toBe("broadcast_cancelled");
  });

  it("a finished or already cancelled broadcast cannot be cancelled; another account's is not found", async () => {
    await create();
    const id = tables.whatsapp_broadcasts[0].id as string;
    expect(await cancelBroadcast(ACC_OTHER, id, NOW)).toEqual({ ok: false, code: "not_found" });
    tables.whatsapp_broadcasts[0].status = "completed";
    expect(await cancelBroadcast(ACC, id, NOW)).toEqual({ ok: false, code: "not_cancellable" });
    expect(await cancelBroadcast(ACC, "nope", NOW)).toEqual({ ok: false, code: "not_found" });
  });
});

describe("refreshCounts and the delivery numbers", () => {
  it("recounts the recipients: accepted is 'Meta accepted it', delivered counts only Meta's receipts", async () => {
    await create();
    const id = tables.whatsapp_broadcasts[0].id as string;
    const rec = (status: string, over: Record<string, unknown> = {}) => ({ id: `r-${tables.whatsapp_broadcast_recipients.length}`, account_id: ACC, broadcast_id: id, contact_id: "c", status, handed_off_at: null, ...over });
    tables.whatsapp_broadcast_recipients = [
      rec("queued"),
      rec("claimed"),
      rec("handed_off", { handed_off_at: NOW.toISOString() }),
      rec("sent", { handed_off_at: NOW.toISOString() }),
      rec("delivered", { handed_off_at: NOW.toISOString() }),
      rec("delivered", { handed_off_at: NOW.toISOString() }),
      rec("read", { handed_off_at: NOW.toISOString() }),
      rec("failed", { handed_off_at: NOW.toISOString() }),
      rec("failed"),
      rec("skipped"),
    ];
    await refreshCounts(id);
    expect(tables.whatsapp_broadcasts[0]).toMatchObject({ count_total: 10, count_queued: 2, count_accepted: 6, count_sent: 1, count_delivered: 2, count_read: 1, count_failed: 2, count_skipped: 1 });
  });

  it("estimateCost: (delivered + read) times the rate for the template's category, flagged as an estimate; null without a card", () => {
    const card = { currency: "ZAR", marketing_per_message: 0.8, utility_per_message: 0.2, authentication_per_message: 0.2 };
    expect(estimateCost("marketing", 3, card)).toEqual({ amount: 2.4, currency: "ZAR", isEstimate: true });
    expect(estimateCost("utility", 3, card)).toEqual({ amount: 0.6, currency: "ZAR", isEstimate: true });
    expect(estimateCost("marketing", 0, card)).toEqual({ amount: 0, currency: "ZAR", isEstimate: true });
    expect(estimateCost("marketing", 3, null)).toBeNull();
  });
});

describe("listBroadcasts / getBroadcast", () => {
  it("lists this account's broadcasts newest first with numbers a person can read, and a cost estimate from their rate card", async () => {
    await create();
    const b = tables.whatsapp_broadcasts[0];
    Object.assign(b, { status: "completed", count_total: 2, count_accepted: 2, count_delivered: 1, count_read: 1 });
    tables.whatsapp_rate_cards = [{ account_id: ACC, social_account_id: SA, currency: "USD", marketing_per_message: 0.05, utility_per_message: 0, authentication_per_message: 0 }];
    tables.whatsapp_broadcasts.push({ ...b, id: "other", account_id: ACC_OTHER });
    const out = await listBroadcasts(ACC, { socialAccountId: SA, limit: 20 });
    expect(out.broadcasts).toHaveLength(1);
    expect(out.broadcasts[0]).toMatchObject({
      id: b.id,
      name: "Spring sale",
      status: "completed",
      counts: { total: 2, accepted: 2, delivered: 1, read: 1 },
      delivery: { delivered: 2, ofAccepted: 2 },
      costEstimate: { amount: 0.1, currency: "USD", isEstimate: true },
    });
  });

  it("getBroadcast is scoped to the account", async () => {
    await create();
    const id = tables.whatsapp_broadcasts[0].id as string;
    expect(await getBroadcast(ACC, id)).toMatchObject({ id });
    expect(await getBroadcast(ACC_OTHER, id)).toBeNull();
  });
});
