// DB-backed kill switches and caps, and the per-connection pause. Supabase is the in-memory fake. The cap numbers used here are
// the migration's PLACEHOLDERS; nothing in the code decides them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { loadControls, getConnectionPause, pauseConnection, resumeConnection, countMessagesAcceptedSince, countBroadcastsSince } = await import("./controls.js");
const { ACC, ACC_OTHER, SA, seedWorld, resetTables } = await import("./testKit.js");

const NOW = new Date("2026-10-16T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;

beforeEach(() => {
  resetTables();
  seedWorld();
});

describe("loadControls", () => {
  it("fails closed: no global row means no sending (null), never 'unlimited'", async () => {
    tables.whatsapp_send_controls = [];
    expect(await loadControls(ACC)).toBeNull();
  });

  it("the global kill switch stops everyone", async () => {
    tables.whatsapp_send_controls[0].kill_switch = true;
    expect(await loadControls(ACC)).toMatchObject({ killed: true, killedBy: "global" });
  });

  it("reads the caps from the global row", async () => {
    expect(await loadControls(ACC)).toEqual({ killed: false, killedBy: null, maxRecipientsPerBroadcast: 250, maxBroadcastsPerDay: 2, maxMessagesPerDay: 250 });
  });

  it("an account row can stop one account without touching the others", async () => {
    tables.whatsapp_send_controls.push({ id: "ctl-a", scope: "account", account_id: ACC, kill_switch: true, max_recipients_per_broadcast: null, max_broadcasts_per_day: null, max_messages_per_day: null });
    expect(await loadControls(ACC)).toMatchObject({ killed: true, killedBy: "account" });
    expect(await loadControls(ACC_OTHER)).toMatchObject({ killed: false });
  });

  it("an account row's own caps win; a null cap falls back to the global number", async () => {
    tables.whatsapp_send_controls.push({ id: "ctl-a", scope: "account", account_id: ACC, kill_switch: false, max_recipients_per_broadcast: 2000, max_broadcasts_per_day: null, max_messages_per_day: 100 });
    expect(await loadControls(ACC)).toEqual({ killed: false, killedBy: null, maxRecipientsPerBroadcast: 2000, maxBroadcastsPerDay: 2, maxMessagesPerDay: 100 });
  });

  it("a damaged global row (a missing or non-positive cap) fails closed", async () => {
    tables.whatsapp_send_controls[0].max_messages_per_day = 0;
    expect(await loadControls(ACC)).toBeNull();
    tables.whatsapp_send_controls[0].max_messages_per_day = null;
    expect(await loadControls(ACC)).toBeNull();
  });

  it("a read error fails closed", async () => {
    const real = tables.whatsapp_send_controls;
    Object.defineProperty(tables, "whatsapp_send_controls", { get() { throw new Error("db down"); }, configurable: true });
    await expect(loadControls(ACC)).rejects.toThrow("db down");
    Object.defineProperty(tables, "whatsapp_send_controls", { value: real, writable: true, configurable: true, enumerable: true });
  });
});

describe("connection pause", () => {
  it("a connection with no state row is not paused", async () => {
    expect(await getConnectionPause(SA)).toEqual({ paused: false });
  });

  it("pauseConnection records why, with Meta's numeric code only, and is visible at once", async () => {
    await pauseConnection(ACC, SA, "quality", 131048, NOW);
    expect(await getConnectionPause(SA)).toEqual({ paused: true, reason: "quality" });
    expect(tables.whatsapp_connection_send_state[0]).toMatchObject({ social_account_id: SA, account_id: ACC, pause_reason: "quality", meta_error_code: 131048, paused_at: NOW.toISOString() });
  });

  it("pausing twice keeps one row (idempotent) and keeps the most recent reason", async () => {
    await pauseConnection(ACC, SA, "quality", 131048, NOW);
    await pauseConnection(ACC, SA, "restricted", 131031, new Date(NOW.getTime() + 1000));
    expect(tables.whatsapp_connection_send_state).toHaveLength(1);
    expect(await getConnectionPause(SA)).toEqual({ paused: true, reason: "restricted" });
  });

  it("resumeConnection clears the pause for the owning account only", async () => {
    await pauseConnection(ACC, SA, "credentials", null, NOW);
    expect(await resumeConnection(ACC_OTHER, SA, NOW)).toBe(false);
    expect(await getConnectionPause(SA)).toMatchObject({ paused: true });
    expect(await resumeConnection(ACC, SA, NOW)).toBe(true);
    expect(await getConnectionPause(SA)).toEqual({ paused: false });
    expect(tables.whatsapp_connection_send_state[0].resumed_at).toBe(NOW.toISOString());
  });
});

describe("usage counters", () => {
  it("countMessagesAcceptedSince counts only this account's messages Meta accepted inside the window", async () => {
    tables.whatsapp_broadcast_recipients = [
      { id: "r1", account_id: ACC, handed_off_at: ago(1 * HOUR) },
      { id: "r2", account_id: ACC, handed_off_at: ago(23 * HOUR) },
      { id: "r3", account_id: ACC, handed_off_at: ago(25 * HOUR) },
      { id: "r4", account_id: ACC, handed_off_at: null },
      { id: "r5", account_id: ACC_OTHER, handed_off_at: ago(1 * HOUR) },
    ];
    expect(await countMessagesAcceptedSince(ACC, new Date(NOW.getTime() - 24 * HOUR))).toBe(2);
  });

  it("countMessagesAcceptedSince also counts chat messages Meta accepted (one daily cap for everything this number sends)", async () => {
    tables.whatsapp_broadcast_recipients = [{ id: "r1", account_id: ACC, handed_off_at: ago(1 * HOUR) }];
    tables.whatsapp_chat_messages = [
      { id: "m1", account_id: ACC, direction: "outbound", handed_off_at: ago(2 * HOUR) },
      { id: "m2", account_id: ACC, direction: "outbound", handed_off_at: ago(30 * HOUR) },
      { id: "m3", account_id: ACC, direction: "inbound", handed_off_at: null },
      { id: "m4", account_id: ACC_OTHER, direction: "outbound", handed_off_at: ago(1 * HOUR) },
    ];
    expect(await countMessagesAcceptedSince(ACC, new Date(NOW.getTime() - 24 * HOUR))).toBe(2);
  });

  it("countBroadcastsSince ignores cancelled broadcasts and other accounts", async () => {
    tables.whatsapp_broadcasts = [
      { id: "b1", account_id: ACC, status: "completed", created_at: ago(2 * HOUR) },
      { id: "b2", account_id: ACC, status: "cancelled", created_at: ago(2 * HOUR) },
      { id: "b3", account_id: ACC, status: "scheduled", created_at: ago(30 * HOUR) },
      { id: "b4", account_id: ACC_OTHER, status: "scheduled", created_at: ago(2 * HOUR) },
    ];
    expect(await countBroadcastsSince(ACC, new Date(NOW.getTime() - 24 * HOUR))).toBe(1);
  });
});
