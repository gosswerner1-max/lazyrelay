// The sender loop: hands due broadcasts off, claims recipients (consent and opt-out checked in the same step and again right
// before each message), sends approved templates with the customer's own token, and handles every way a send can go wrong.
// Supabase is the in-memory fake with a TypeScript model of the SQL claim function; the HTTP client is a fake. NOTHING here
// reaches Meta or any network, and no real number or token exists.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";
import type { HttpClient } from "./cloudApi.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { runBroadcastCycle, STUCK_CLAIM_MS } = await import("./sender.js");
const kit = await import("./testKit.js");
const { ACC, SA, TEMPLATE_ID, TOKEN, seedWorld, resetTables, setTestEnv, addContact, hooks, clock } = kit;
const { messageKeyFor } = await import("../platforms/whatsapp/contactPrivacy.js");

const T0 = new Date("2026-10-16T12:00:00.000Z");
const BID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SAVED = { ...process.env };
let logged: string[] = [];
let now = T0;

interface Call {
  to: string;
  name: string;
  params: string[];
  auth: string;
}
type Reply = { status: number; json: unknown } | Error;
const ok = (n: number): Reply => ({ status: 200, json: { messages: [{ id: `wamid.TESTID${n}` }] } });
const err = (status: number, code: number): Reply => ({ status, json: { error: { code, message: "text that must never be kept" } } });

function makeHttp(respond: (to: string, n: number) => Reply = (_to, n) => ok(n)) {
  const calls: Call[] = [];
  const http: HttpClient = async (_url, init) => {
    const body = JSON.parse(init.body ?? "{}");
    calls.push({ to: body.to, name: body.template?.name, params: (body.template?.components?.[0]?.parameters ?? []).map((p: { text: string }) => p.text), auth: init.headers.Authorization });
    const r = respond(body.to, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { http, calls };
}

function addBroadcast(over: Record<string, unknown> = {}) {
  const row = {
    id: BID,
    account_id: ACC,
    social_account_id: SA,
    template_id: TEMPLATE_ID,
    template_name: "spring_offer",
    template_language: "en_US",
    template_category: "marketing",
    template_params: ["Friend", "20%"],
    name: "Spring sale",
    status: "scheduled",
    pause_reason: null,
    scheduled_for: new Date(T0.getTime() - 60_000).toISOString(),
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    recipients_materialised_at: null,
    audience_estimate: 0,
    created_at: new Date(T0.getTime() - 3_600_000).toISOString(),
    ...over,
  };
  tables.whatsapp_broadcasts.push(row);
  return row;
}
const bcast = () => tables.whatsapp_broadcasts.find((b) => b.id === BID)!;
const recips = () => tables.whatsapp_broadcast_recipients.filter((r) => r.broadcast_id === BID);
const byStatus = () => recips().reduce<Record<string, number>>((m, r) => ((m[r.status as string] = (m[r.status as string] ?? 0) + 1), m), {});
const cycle = (http: HttpClient, at: Date = now) => {
  now = at;
  clock.now = at;
  return runBroadcastCycle({ http, now: () => at });
};

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  now = T0;
  clock.now = T0;
  hooks.afterClaim = undefined;
  logged = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
  clock.now = undefined;
  hooks.afterClaim = undefined;
});

/** Three opted-in South African contacts and a due broadcast. */
function standardWorld() {
  const contacts = [addContact("+27821110001"), addContact("+27821110002"), addContact("+27821110003")];
  addBroadcast();
  return contacts;
}

describe("switches", () => {
  it("does nothing at all unless WHATSAPP_SEND_ENABLED is exactly 'true'", async () => {
    standardWorld();
    const h = makeHttp();
    for (const v of [undefined, "false", "1", "TRUE"]) {
      if (v === undefined) delete process.env.WHATSAPP_SEND_ENABLED;
      else process.env.WHATSAPP_SEND_ENABLED = v;
      await cycle(h.http);
    }
    expect(h.calls).toHaveLength(0);
    expect(bcast().status).toBe("scheduled");
    expect(recips()).toHaveLength(0);
  });

  it("does nothing when the feature flag is off even if the send flag is on", async () => {
    standardWorld();
    process.env.WHATSAPP_BROADCASTS_ENABLED = "false";
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(0);
    expect(bcast().status).toBe("scheduled");
  });

  it("does nothing when the contact encryption or hash key is missing (it could not decrypt, and could not match receipts)", async () => {
    standardWorld();
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(0);
    expect(bcast().status).toBe("scheduled");
  });
});

describe("hand-off", () => {
  it("takes a due scheduled broadcast to sending and makes one recipient per opted-in contact, leaving a future one alone", async () => {
    standardWorld();
    const optedOut = addContact("+27821110004", { consent_status: "opted_out" });
    addBroadcast({ id: "future", scheduled_for: new Date(T0.getTime() + 3_600_000).toISOString() });
    const h = makeHttp();
    await cycle(h.http);
    expect(tables.whatsapp_broadcasts.find((b) => b.id === "future")!.status).toBe("scheduled");
    expect(recips().map((r) => r.contact_id)).not.toContain(optedOut.id);
    expect(recips()).toHaveLength(3);
    expect(bcast().started_at).toBe(T0.toISOString());
    expect(bcast().recipients_materialised_at).toBe(T0.toISOString());
  });

  it("a marketing broadcast marks US (+1) recipients skipped and never sends to them; a utility one does not", async () => {
    addContact("+27821110001");
    addContact("+14155550100");
    addBroadcast();
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls.map((c) => c.to)).toEqual(["27821110001"]);
    expect(recips().find((r) => r.skip_reason === "us_marketing_blocked")).toBeTruthy();

    resetTables();
    seedWorld({ template: { category: "utility" } });
    tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
    addContact("+14155550100");
    addBroadcast({ template_category: "utility" });
    const h2 = makeHttp();
    await cycle(h2.http);
    expect(h2.calls.map((c) => c.to)).toEqual(["14155550100"]);
  });

  it("is resumable: a broadcast already 'sending' whose recipients were not all made yet finishes making them, without duplicates", async () => {
    const [c1] = standardWorld();
    bcast().status = "sending";
    tables.whatsapp_broadcast_recipients.push({ id: "pre", account_id: ACC, broadcast_id: BID, contact_id: c1.id, status: "queued", attempt_count: 0, created_at: T0.toISOString() });
    const h = makeHttp();
    await cycle(h.http);
    expect(recips().filter((r) => r.contact_id === c1.id)).toHaveLength(1);
    expect(recips()).toHaveLength(3);
  });
});

describe("sending", () => {
  it("sends each opted-in contact the approved template with the customer's OWN token and the stored variables, and records 'handed off'", async () => {
    standardWorld();
    const h = makeHttp();
    const out = await cycle(h.http);
    expect(h.calls).toHaveLength(3);
    for (const c of h.calls) {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.name).toBe("spring_offer");
      expect(c.params).toEqual(["Friend", "20%"]);
    }
    expect(h.calls.map((c) => c.to).sort()).toEqual(["27821110001", "27821110002", "27821110003"]);
    expect(out.handedOff).toBe(3);
    expect(byStatus()).toEqual({ handed_off: 3 });
    expect(bcast().status).toBe("completed");
    expect(bcast()).toMatchObject({ count_total: 3, count_queued: 0, count_accepted: 3, count_delivered: 0 });
  });

  it("'handed off' is NOT 'delivered': nothing is delivered until Meta's receipts say so", async () => {
    standardWorld();
    await cycle(makeHttp().http);
    expect(bcast().count_delivered).toBe(0);
    expect(recips().every((r) => r.delivered_at == null && r.status === "handed_off")).toBe(true);
  });

  it("keeps only a keyed hash of Meta's message id, never the id or any number", async () => {
    const [c1] = standardWorld();
    await cycle(makeHttp().http);
    const r = recips().find((x) => x.contact_id === c1.id)!;
    expect(r.message_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(tables.whatsapp_broadcast_recipients)).not.toMatch(/wamid|27821110/);
    expect(JSON.stringify(tables.whatsapp_broadcasts)).not.toMatch(/wamid|27821110/);
    expect(new Set(recips().map((x) => x.message_key)).size).toBe(3);
    expect(messageKeyFor(ACC, "wamid.TESTID1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never logs a number, a token, or Meta's error text", async () => {
    standardWorld();
    await cycle(makeHttp((_to, n) => (n === 1 ? err(400, 131026) : ok(n))).http);
    const all = logged.join("\n");
    expect(all).not.toMatch(/2782111|\+27|text that must never be kept/);
    expect(all).not.toContain(TOKEN);
  });

  it("two loops running at once never send the same recipient twice", async () => {
    standardWorld();
    const h = makeHttp();
    await Promise.all([cycle(h.http), cycle(h.http)]);
    expect(h.calls).toHaveLength(3);
    expect(new Set(h.calls.map((c) => c.to)).size).toBe(3);
  });
});

describe("consent and opt-out are checked at send time and fail closed", () => {
  it("a contact who opts out after the broadcast was scheduled is never messaged", async () => {
    const [c1, c2] = standardWorld();
    bcast().status = "sending";
    // materialise by running a cycle that cannot send (Meta has paused the number), then the contact opts out, then sending resumes
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: T0.toISOString(), pause_reason: "quality" }];
    await cycle(makeHttp().http);
    expect(recips()).toHaveLength(3);
    c2.consent_status = "opted_out";
    tables.whatsapp_connection_send_state = [];
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls.map((c) => c.to).sort()).toEqual(["27821110001", "27821110003"]);
    expect(recips().find((r) => r.contact_id === c2.id)).toMatchObject({ status: "skipped", skip_reason: "opted_out_at_claim" });
    expect(c1.consent_status).toBe("opted_in");
  });

  it("a suppression row alone (no contact flag) also blocks the send", async () => {
    const [, c2] = standardWorld();
    kit.addOptOut(c2);
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls.map((c) => c.to)).not.toContain("27821110002");
    expect(h.calls).toHaveLength(2);
  });

  it("an opt-out that lands AFTER the claim but before that message is sent is still honoured (second layer)", async () => {
    const [, c2] = standardWorld();
    hooks.afterClaim = () => {
      c2.consent_status = "opted_out";
      kit.addOptOut(c2);
      hooks.afterClaim = undefined;
    };
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls.map((c) => c.to)).not.toContain("27821110002");
    expect(recips().find((r) => r.contact_id === c2.id)).toMatchObject({ status: "skipped", skip_reason: "opted_out_at_send" });
  });

  it("a contact erased after scheduling is skipped", async () => {
    const [c1] = standardWorld();
    bcast().status = "sending";
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: T0.toISOString(), pause_reason: "quality" }];
    await cycle(makeHttp().http);
    tables.whatsapp_contacts.splice(tables.whatsapp_contacts.indexOf(c1), 1);
    tables.whatsapp_connection_send_state = [];
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(2);
  });

  it("if the opt-out lookup itself fails, nothing is sent (fail closed) and nothing is lost", async () => {
    standardWorld();
    hooks.afterClaim = () => {
      Object.defineProperty(tables, "whatsapp_opt_outs", { get() { throw new Error("db down"); }, configurable: true });
    };
    const h = makeHttp();
    await cycle(h.http).catch(() => undefined);
    Object.defineProperty(tables, "whatsapp_opt_outs", { value: [], writable: true, configurable: true, enumerable: true });
    expect(h.calls).toHaveLength(0);
  });
});

describe("gates checked every cycle", () => {
  it("a plan that is no longer paid pauses the broadcast (plan) and sends nothing", async () => {
    standardWorld();
    tables.subscriptions = [];
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(0);
    expect(bcast()).toMatchObject({ status: "paused", pause_reason: "plan" });
  });

  it("a connection with no stored login pauses the broadcast (connection_unavailable) and sends nothing", async () => {
    standardWorld();
    tables.social_accounts[0].access_token_vault_id = null;
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(0);
    expect(bcast()).toMatchObject({ status: "paused", pause_reason: "connection_unavailable" });
  });

  it("a paused connection sends nothing and keeps the broadcast waiting", async () => {
    standardWorld();
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: T0.toISOString(), pause_reason: "quality" }];
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(0);
    expect(bcast().status).toBe("sending");
  });

  it("a template that is no longer approved pauses the broadcast (template_unusable)", async () => {
    standardWorld();
    tables.whatsapp_message_templates[0].status = "paused";
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(0);
    expect(bcast()).toMatchObject({ status: "paused", pause_reason: "template_unusable" });
  });

  it("a cancelled broadcast is never sent, and cancelling mid-flight stops the rest", async () => {
    standardWorld();
    bcast().status = "cancelled";
    const h = makeHttp();
    await cycle(h.http);
    expect(h.calls).toHaveLength(0);

    bcast().status = "scheduled";
    tables.whatsapp_broadcast_recipients = [];
    const h2 = makeHttp((to, n) => {
      if (n === 1) bcast().status = "cancelled";
      return ok(n);
    });
    await cycle(h2.http);
    expect(h2.calls).toHaveLength(1);
    expect(byStatus().handed_off).toBe(1);
  });
});

describe("when a send goes wrong", () => {
  it("131050 (the person stopped marketing messages): that recipient fails as opted out, the opt-out is recorded for good, the others continue", async () => {
    const [c1] = standardWorld();
    const h = makeHttp((to, n) => (to === "27821110001" ? err(400, 131050) : ok(n)));
    await cycle(h.http);
    expect(h.calls).toHaveLength(3);
    expect(recips().find((r) => r.contact_id === c1.id)).toMatchObject({ status: "failed", failure_reason: "recipient_opted_out", error_code: 131050 });
    expect(c1.consent_status).toBe("opted_out");
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
    expect(tables.whatsapp_opt_outs[0]).toMatchObject({ source: "meta_131050", scope: "marketing" });
    expect(tables.whatsapp_opt_outs[0].contact_key).toBe(c1.contact_key);
  });

  it("a restriction code pauses the CONNECTION, stops the batch, puts the unsent ones back untouched, and is never retried", async () => {
    standardWorld();
    const h = makeHttp(() => err(400, 131048));
    await cycle(h.http);
    expect(h.calls).toHaveLength(1);
    expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ social_account_id: SA, pause_reason: "quality", meta_error_code: 131048 });
    expect(byStatus()).toEqual({ queued: 3 });
    expect(recips().every((r) => r.attempt_count === 0 && r.claim_token == null)).toBe(true);
    await cycle(h.http, new Date(T0.getTime() + 10 * 60_000));
    await cycle(h.http, new Date(T0.getTime() + 60 * 60_000));
    expect(h.calls).toHaveLength(1);
  });

  it("a bad token (401) pauses the connection as a credentials problem", async () => {
    standardWorld();
    const h = makeHttp(() => err(401, 190));
    await cycle(h.http);
    expect(h.calls).toHaveLength(1);
    expect(tables.whatsapp_connection_send_state[0].pause_reason).toBe("credentials");
  });

  it("a template error pauses the BROADCAST, not every recipient one by one", async () => {
    standardWorld();
    const h = makeHttp(() => err(400, 132015));
    await cycle(h.http);
    expect(h.calls).toHaveLength(1);
    expect(bcast()).toMatchObject({ status: "paused", pause_reason: "template_unusable" });
    expect(byStatus()).toEqual({ queued: 3 });
  });

  it("a transient error is retried at most 3 times, with a growing delay, then failed (4 attempts in all)", async () => {
    addContact("+27821110001");
    addBroadcast();
    const h = makeHttp(() => ({ status: 503, json: null }));
    await cycle(h.http);
    expect(h.calls).toHaveLength(1);
    expect(recips()[0]).toMatchObject({ status: "queued", attempt_count: 1 });
    expect(new Date(recips()[0].next_attempt_at as string).getTime()).toBe(T0.getTime() + 60_000);

    await cycle(h.http, new Date(T0.getTime() + 30_000));
    expect(h.calls).toHaveLength(1); // not yet due

    await cycle(h.http, new Date(T0.getTime() + 61_000));
    expect(h.calls).toHaveLength(2);
    expect(recips()[0].attempt_count).toBe(2);
    await cycle(h.http, new Date(T0.getTime() + 61_000 + 5 * 60_000 + 1000));
    expect(h.calls).toHaveLength(3);
    await cycle(h.http, new Date(T0.getTime() + 61_000 + 5 * 60_000 + 15 * 60_000 + 2000));
    expect(h.calls).toHaveLength(4);
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "retries_exhausted", attempt_count: 4 });
    await cycle(h.http, new Date(T0.getTime() + 48 * 3_600_000));
    expect(h.calls).toHaveLength(4);
    expect(bcast().status).toBe("completed");
  });

  it("a request that got no answer is NOT retried (the message may have been sent): failed as unconfirmed", async () => {
    addContact("+27821110001");
    addBroadcast();
    const h = makeHttp(() => new Error("socket hang up"));
    await cycle(h.http);
    await cycle(h.http, new Date(T0.getTime() + 3_600_000));
    expect(h.calls).toHaveLength(1);
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "unconfirmed_no_response" });
  });

  it("an ordinary rejection fails only that recipient, with Meta's numeric code and no text", async () => {
    const [c1] = standardWorld();
    const h = makeHttp((to, n) => (to === "27821110001" ? err(400, 131026) : ok(n)));
    await cycle(h.http);
    expect(recips().find((r) => r.contact_id === c1.id)).toMatchObject({ status: "failed", failure_reason: "meta_error_131026", error_code: 131026 });
    expect(byStatus()).toEqual({ failed: 1, handed_off: 2 });
    expect(JSON.stringify(tables.whatsapp_broadcast_recipients)).not.toMatch(/must never be kept/);
  });

  it("a claim that was never answered (a crash mid-send) is failed as unconfirmed after 10 minutes, not sent again", async () => {
    const [c1] = standardWorld();
    bcast().status = "sending";
    tables.whatsapp_broadcast_recipients.push({ id: "stuck", account_id: ACC, broadcast_id: BID, contact_id: c1.id, status: "claimed", claim_token: "tok", claimed_at: new Date(T0.getTime() - STUCK_CLAIM_MS - 1000).toISOString(), attempt_count: 1, created_at: T0.toISOString() });
    const h = makeHttp();
    await cycle(h.http);
    expect(tables.whatsapp_broadcast_recipients.find((r) => r.id === "stuck")).toMatchObject({ status: "failed", failure_reason: "unconfirmed_after_crash" });
    expect(h.calls.map((c) => c.to)).not.toContain("27821110001");
  });

  it("an error in our own code for one recipient fails that recipient and shows the message, not a silent skip", async () => {
    addContact("+27821110001");
    addBroadcast();
    const bad: HttpClient = async () => {
      throw new TypeError("boom from the client");
    };
    // a thrown error from the client is 'no response'; a thrown error from OUR validation is internal
    tables.whatsapp_message_templates[0].name = "spring_offer";
    bcast().template_name = "Bad Name";
    await cycle(bad);
    expect(recips()[0]).toMatchObject({ status: "failed", failure_reason: "internal_error" });
    expect(logged.join("\n")).toMatch(/Refusing to send/);
  });
});
