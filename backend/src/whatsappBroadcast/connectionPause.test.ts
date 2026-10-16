// The per-connection pause, which exists only because META reported a problem with the customer's own number (a restriction, quality
// limit, rejected credential or policy block). It is not a LazyRelay limit or kill switch. Supabase is the in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { getConnectionPause, pauseConnection, resumeConnection } = await import("./connectionPause.js");
const { ACC, ACC_OTHER, SA, seedWorld, resetTables } = await import("./testKit.js");

const NOW = new Date("2026-10-16T12:00:00.000Z");

beforeEach(() => {
  resetTables();
  seedWorld();
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

  it("a row that says paused without a reason is still paused", async () => {
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: NOW.toISOString(), pause_reason: null }];
    expect(await getConnectionPause(SA)).toMatchObject({ paused: true });
  });

  it("resumeConnection clears the pause for the owning account only (the customer's own choice)", async () => {
    await pauseConnection(ACC, SA, "credentials", null, NOW);
    expect(await resumeConnection(ACC_OTHER, SA, NOW)).toBe(false);
    expect(await getConnectionPause(SA)).toMatchObject({ paused: true });
    expect(await resumeConnection(ACC, SA, NOW)).toBe(true);
    expect(await getConnectionPause(SA)).toEqual({ paused: false });
    expect(tables.whatsapp_connection_send_state[0].resumed_at).toBe(NOW.toISOString());
  });

  it("resuming a connection that is not paused is false", async () => {
    expect(await resumeConnection(ACC, SA, NOW)).toBe(false);
  });
});
