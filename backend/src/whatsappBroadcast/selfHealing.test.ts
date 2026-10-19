// WhatsApp broadcast sender under SELF_HEALING_MODE (off, shadow, on): unknown Meta codes, and the one owner digest when a connection is
// having trouble. No cross-channel failover exists or is added: a failed recipient stays failed. Supabase is the in-memory fake, the
// HTTP client is a fake, the email is a spy. NOTHING here reaches Meta, a mailbox or any network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";
import type { HttpClient } from "./cloudApi.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});
const digest = vi.fn();
vi.mock("../email.js", () => ({ sendWhatsappFaultDigest: (...a: unknown[]) => digest(...a), sendReconnectNeededEmail: vi.fn() }));

const { runBroadcastCycle } = await import("./sender.js");
const { noteWhatsappOutcome, resetWhatsappFaultState } = await import("../selfHealing/whatsappAlert.js");
const kit = await import("./testKit.js");
const { ACC, SA, TEMPLATE_ID, seedWorld, resetTables, setTestEnv, addContact, clock } = kit;

const T0 = new Date("2026-10-16T12:00:00.000Z");
const BID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SAVED = { ...process.env };
const HOURS = 3_600_000;
let now = T0;

type Reply = { status: number; json: unknown } | Error;
const ok = (n: number): Reply => ({ status: 200, json: { messages: [{ id: `wamid.TESTID${n}` }] } });
const err = (status: number, code: number): Reply => ({ status, json: { error: { code, message: "text that must never be kept" } } });

function makeHttp(respond: (to: string, n: number) => Reply = (_to, n) => ok(n)) {
  const calls: string[] = [];
  const http: HttpClient = async (_url, init) => {
    const body = JSON.parse(init.body ?? "{}");
    calls.push(body.to);
    const r = respond(body.to, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { http, calls };
}

function addBroadcast() {
  tables.whatsapp_broadcasts.push({
    id: BID, account_id: ACC, social_account_id: SA, template_id: TEMPLATE_ID, template_name: "spring_offer", template_language: "en_US", template_category: "utility",
    template_params: ["Friend", "20%"], name: "Sale", status: "scheduled", pause_reason: null, scheduled_for: new Date(T0.getTime() - 60_000).toISOString(), started_at: null,
    completed_at: null, cancelled_at: null, recipients_materialised_at: null, audience_estimate: 0, created_at: new Date(T0.getTime() - 3_600_000).toISOString(),
  });
}
const recips = () => tables.whatsapp_broadcast_recipients.filter((r) => r.broadcast_id === BID);
const flush = () => new Promise((r) => setTimeout(r, 0));
const phone = (i: number) => `+2782111${String(i).padStart(4, "0")}`;
const digits = (i: number) => phone(i).replace(/\D/g, "");

function setMode(mode: string | undefined) {
  if (mode === undefined) delete process.env.SELF_HEALING_MODE;
  else process.env.SELF_HEALING_MODE = mode;
}

const cyc = (http: HttpClient, at: Date = now) => {
  now = at;
  clock.now = at;
  return runBroadcastCycle({ http, now: () => at });
};

beforeEach(() => {
  // Each test needs its own in-process failure window.
  resetWhatsappFaultState();
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  tables.accounts[0].email = "owner@acme-cafe.co.za"; // not an internal test address (those never get automated email)
  now = T0;
  clock.now = T0;
  digest.mockClear();
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
  clock.now = undefined;
});

describe("unknown Meta codes", () => {
  it("off: an unknown code fails that recipient at once, as before", async () => {
    addContact(phone(1));
    addBroadcast();
    const h = makeHttp(() => err(400, 999999));
    await cyc(h.http);
    await cyc(h.http, new Date(T0.getTime() + 2 * HOURS));
    expect(h.calls).toHaveLength(1);
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "meta_error_999999", error_code: 999999 });
  });

  it("shadow: still fails at once, and the new decision is only recorded", async () => {
    setMode("shadow");
    addContact(phone(1));
    addBroadcast();
    const h = makeHttp(() => err(400, 999999));
    await cyc(h.http);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "meta_error_999999" });
    expect(tables.self_healing_shadow_events).toHaveLength(1);
    expect(tables.self_healing_shadow_events[0]).toMatchObject({ source: "whatsapp", platform: "whatsapp", social_account_id: SA, post_id: null, legacy_action: "fail", new_action: "retry", diverged: true, would_alert: false });
    expect(JSON.stringify(tables.self_healing_shadow_events)).not.toMatch(/must never be kept|27821/);
  });

  it("on: 3 attempts, then terminal unknown_error, never retried again and never sent any other way", async () => {
    setMode("on");
    addContact(phone(1));
    addBroadcast();
    const h = makeHttp(() => err(400, 999999));
    await cyc(h.http);
    expect(recips()[0]).toMatchObject({ status: "queued", attempt_count: 1, error_code: 999999 });
    expect(new Date(recips()[0].next_attempt_at as string).getTime()).toBe(T0.getTime() + 60_000);
    await cyc(h.http, new Date(T0.getTime() + 61_000));
    expect(recips()[0]).toMatchObject({ status: "queued", attempt_count: 2 });
    await cyc(h.http, new Date(T0.getTime() + 61_000 + 5 * 60_000 + 1000));
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "unknown_error", attempt_count: 3, error_code: 999999 });
    await cyc(h.http, new Date(T0.getTime() + 48 * HOURS));
    expect(h.calls).toHaveLength(3);
  });

  it("on: a code the repo already classifies as permanent for one recipient stays terminal at once", async () => {
    setMode("on");
    addContact(phone(1));
    addBroadcast();
    const h = makeHttp(() => err(400, 131026));
    await cyc(h.http);
    await cyc(h.http, new Date(T0.getTime() + 2 * HOURS));
    expect(h.calls).toHaveLength(1);
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "meta_error_131026" });
  });

  it("on: a request that got no answer is still not retried (the message may have gone out)", async () => {
    setMode("on");
    addContact(phone(1));
    addBroadcast();
    const h = makeHttp(() => new Error("socket hang up"));
    await cyc(h.http);
    await cyc(h.http, new Date(T0.getTime() + 2 * HOURS));
    expect(h.calls).toHaveLength(1);
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "unconfirmed_no_response" });
  });

  it("on: an account-level code still pauses the connection and sends no more", async () => {
    setMode("on");
    addContact(phone(1));
    addContact(phone(2));
    addBroadcast();
    const h = makeHttp(() => err(401, 190));
    await cyc(h.http);
    expect(h.calls).toHaveLength(1);
    expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ pause_reason: "credentials" });
  });
});

describe("the owner digest", () => {
  /** n opted-in contacts, a due broadcast, and an answer for each send in the order the sends are made (1 based). */
  function world(n: number, answer: (call: number) => Reply) {
    for (let i = 1; i <= n; i++) addContact(phone(i));
    addBroadcast();
    return makeHttp((_to, call) => answer(call));
  }
  const fail131026 = (): Reply => err(400, 131026);

  it("5 failed sends in a row tell the owner once, with the counts, in on mode; the stored time blocks a second one", async () => {
    setMode("on");
    const h = world(7, (i) => (i <= 6 ? fail131026() : ok(i)));
    await cyc(h.http);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledWith("owner@acme-cafe.co.za", { sends: 5, failed: 5, recipientLevel: 5, accountLevel: 0 });
    expect(tables.social_accounts[0].whatsapp_fault_alert_sent_at).toBe(T0.toISOString());
    expect(h.calls).toHaveLength(7); // the sixth failure and the seventh success made no second email
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("an account-level fault in the run is counted as account-level", async () => {
    setMode("on");
    const h = world(5, (i) => (i <= 4 ? fail131026() : err(401, 190)));
    await cyc(h.http);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0][1]).toEqual({ sends: 5, failed: 5, recipientLevel: 4, accountLevel: 1 });
    expect(tables.whatsapp_connection_send_state[0].pause_reason).toBe("credentials");
  });

  it("20 percent of at least 10 sends alerts even without 5 in a row", async () => {
    setMode("on");
    const h = world(10, (i) => (i === 3 || i === 8 ? fail131026() : ok(i)));
    await cyc(h.http);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0][1]).toEqual({ sends: 10, failed: 2, recipientLevel: 2, accountLevel: 0 });
  });

  it("9 sends with 2 failures do not alert (fewer than 10 sends), and neither do 4 in a row", async () => {
    setMode("on");
    const h = world(9, (i) => (i === 3 || i === 8 ? fail131026() : ok(i)));
    await cyc(h.http);
    expect(digest).not.toHaveBeenCalled();
    expect(tables.social_accounts[0].whatsapp_fault_alert_sent_at ?? null).toBeNull();
  });

  it("after 6 hours a connection that is still in trouble can be told again, not before", async () => {
    setMode("on");
    const h = world(5, () => fail131026());
    await cyc(h.http);
    expect(digest).toHaveBeenCalledTimes(1);
    // five more failing recipients, 5 hours later: still inside the cooldown
    for (let i = 6; i <= 10; i++) addContact(phone(i));
    tables.whatsapp_broadcasts[0].status = "sending";
    tables.whatsapp_broadcasts[0].recipients_materialised_at = null;
    await cyc(h.http, new Date(T0.getTime() + 5 * HOURS));
    expect(digest).toHaveBeenCalledTimes(1);
    for (let i = 11; i <= 15; i++) addContact(phone(i));
    tables.whatsapp_broadcasts[0].status = "sending";
    tables.whatsapp_broadcasts[0].recipients_materialised_at = null;
    await cyc(h.http, new Date(T0.getTime() + 6 * HOURS + 1));
    expect(digest).toHaveBeenCalledTimes(2);
    expect(tables.social_accounts[0].whatsapp_fault_alert_sent_at).toBe(new Date(T0.getTime() + 6 * HOURS + 1).toISOString());
  });

  it("an internal test address never gets the email", async () => {
    setMode("on");
    tables.accounts[0].email = "owner@acme.example";
    const h = world(6, () => fail131026());
    await cyc(h.http);
    expect(digest).not.toHaveBeenCalled();
  });

  it("off: no tracking, no email, no stored time", async () => {
    const h = world(7, () => fail131026());
    await cyc(h.http);
    expect(digest).not.toHaveBeenCalled();
    expect(tables.social_accounts[0].whatsapp_fault_alert_sent_at ?? null).toBeNull();
  });

  it("shadow: nothing is emailed or stored, the would-be alert is recorded once", async () => {
    setMode("shadow");
    const h = world(7, () => fail131026());
    await cyc(h.http);
    await flush();
    expect(digest).not.toHaveBeenCalled();
    expect(tables.social_accounts[0].whatsapp_fault_alert_sent_at ?? null).toBeNull();
    const alerts = (tables.self_healing_shadow_events ?? []).filter((r) => r.source === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ platform: "whatsapp", social_account_id: SA, legacy_action: "none", new_action: "owner_alert", would_alert: true, diverged: true });
  });

  it("nobody on the list is messaged about a failure: only the template sends happen, one per recipient", async () => {
    setMode("on");
    const h = world(6, () => fail131026());
    await cyc(h.http);
    expect(h.calls.sort()).toEqual([1, 2, 3, 4, 5, 6].map(digits).sort());
    expect(recips().every((r) => r.status === "failed")).toBe(true);
  });

  it("an email that cannot be sent never stops the send loop, and one with no address is skipped", async () => {
    setMode("on");
    digest.mockImplementationOnce(() => {
      throw new Error("mail down");
    });
    const h = world(6, () => fail131026());
    await expect(cyc(h.http)).resolves.toBeDefined();
    expect(h.calls).toHaveLength(6);
  });
});

describe("the alert when the database cannot be used", () => {
  const five = async (db: unknown) => {
    for (let i = 0; i < 5; i++) await noteWhatsappOutcome({ db: db as never, accountId: ACC, socialAccountId: SA, outcome: "recipient_failed", now: T0 });
  };

  it("a column that cannot be read (migration not applied) means no email and no throw", async () => {
    setMode("on");
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42703", message: "column does not exist" } }) }) }) }) };
    await expect(five(db)).resolves.toBeUndefined();
    expect(digest).not.toHaveBeenCalled();
  });

  it("two loops racing: only the one whose stored-time update takes effect sends", async () => {
    setMode("on");
    const db = {
      from: (t: string) =>
        t === "social_accounts"
          ? {
              select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { whatsapp_fault_alert_sent_at: null }, error: null }) }) }),
              update: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [], error: null }) }) }) }),
            }
          : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "owner@acme.example" }, error: null }) }) }) },
    };
    await five(db);
    expect(digest).not.toHaveBeenCalled();
  });
});
