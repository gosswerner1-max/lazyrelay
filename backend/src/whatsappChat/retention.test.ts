// Retention: conversations and chat messages 30 days after the last message, and the per-person delivery rows of finished broadcasts
// 30 days after they last changed (decision D3's default, the same window as the rest of the feature). Run by the 6 hourly privacy
// sweep. Does nothing unless the feature is on. The database is a fake rpc: nothing is deleted anywhere.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { purgeWhatsappHistory } from "./retention.js";

const SAVED = { ...process.env };
const NOW = new Date("2026-10-16T12:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - 30 * 24 * 3_600_000).toISOString();

function fakeDb(handlers: Record<string, () => { data: unknown; error: { message: string } | null }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return { calls, db: { rpc: (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), Promise.resolve(handlers[fn]())) } as never };
}

beforeEach(() => {
  process.env.WHATSAPP_BYOK_ENABLED = "true";
  process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("purgeWhatsappHistory", () => {
  it("purges chat and broadcast history with a cutoff 30 days back and reports the counts", async () => {
    const f = fakeDb({ purge_whatsapp_chat: () => ({ data: 4, error: null }), purge_whatsapp_broadcast_history: () => ({ data: 120, error: null }) });
    expect(await purgeWhatsappHistory(f.db, NOW)).toEqual({ chatDeleted: 4, broadcastRowsDeleted: 120, failed: false });
    expect(f.calls).toEqual([
      { fn: "purge_whatsapp_chat", args: { p_cutoff: CUTOFF } },
      { fn: "purge_whatsapp_broadcast_history", args: { p_cutoff: CUTOFF } },
    ]);
  });

  it("does nothing while the feature is off (a database without migration 0131 is never asked)", async () => {
    process.env.WHATSAPP_BROADCASTS_ENABLED = "false";
    const f = fakeDb({});
    expect(await purgeWhatsappHistory(f.db, NOW)).toEqual({ chatDeleted: 0, broadcastRowsDeleted: 0, failed: false });
    expect(f.calls).toHaveLength(0);
  });

  it("a failure is shown (the message only), flagged, and never stops the other purge", async () => {
    const f = fakeDb({ purge_whatsapp_chat: () => ({ data: null, error: { message: "function does not exist" } }), purge_whatsapp_broadcast_history: () => ({ data: 7, error: null }) });
    expect(await purgeWhatsappHistory(f.db, NOW)).toEqual({ chatDeleted: 0, broadcastRowsDeleted: 7, failed: true });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("function does not exist"));
  });
});
