// The privacy sweep: which cutoff it sends, how it reads the answer, and that a failed purge never stops the token wipe.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables, vault, makeBuilder, fakeRpc } from "./testFakeSupabase.js";
import { runPrivacySweep, retentionCutoff, MESSAGE_RETENTION_DAYS } from "./privacySweep.js";
import { WIPED_TOKEN_MARKER } from "./tokenWipe.js";

let purge: (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
const purgeCalls: Array<Record<string, unknown>> = [];
const db = {
  from: (t: string) => makeBuilder(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === "purge_stored_messages") {
      purgeCalls.push(args);
      return purge(args);
    }
    return fakeRpc(fn, args);
  },
} as never;

const NOW = new Date("2026-10-07T12:00:00.000Z");

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  purgeCalls.length = 0;
  purge = () => ({ data: [{ comments_deleted: 4, dms_deleted: "2", messages_deleted: "7" }], error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the retention window", () => {
  it("is 30 days, the same window the Mentions poller reads", () => {
    expect(MESSAGE_RETENTION_DAYS).toBe(30);
    expect(retentionCutoff(NOW)).toBe("2026-09-07T12:00:00.000Z");
  });
});

describe("runPrivacySweep", () => {
  it("asks the database to delete everything older than 30 days and reports the counts", async () => {
    const r = await runPrivacySweep(db, NOW);
    expect(purgeCalls).toEqual([{ p_cutoff: "2026-09-07T12:00:00.000Z" }]);
    expect(r).toMatchObject({ commentsDeleted: 4, dmsDeleted: 2, messagesDeleted: 7, purgeFailed: false });
  });

  it("reads a single-object answer as well as a one-row array", async () => {
    purge = () => ({ data: { comments_deleted: 1, dms_deleted: 0 }, error: null });
    expect(await runPrivacySweep(db, NOW)).toMatchObject({ commentsDeleted: 1, dmsDeleted: 0 });
  });

  it("a database without the messages column yet (migration 0127 not applied) still parses: no messages deleted", async () => {
    purge = () => ({ data: [{ comments_deleted: 1, dms_deleted: 1 }], error: null });
    expect(await runPrivacySweep(db, NOW)).toMatchObject({ commentsDeleted: 1, dmsDeleted: 1, messagesDeleted: 0, purgeFailed: false });
  });

  it("wipes disconnected logins in the same pass", async () => {
    vault.set("v1", "REAL-TOKEN");
    tables.social_accounts = [{ id: "sa1", access_token_vault_id: "v1", refresh_token_vault_id: null, disconnected_at: NOW.toISOString(), tokens_wiped_at: null }];
    const r = await runPrivacySweep(db, NOW);
    expect(r.tokensWiped).toBe(1);
    expect(vault.get("v1")).toBe(WIPED_TOKEN_MARKER);
  });

  it("a failed purge is reported, does not throw, and the token wipe still happened", async () => {
    purge = () => ({ data: null, error: { message: "boom" } });
    vault.set("v1", "REAL-TOKEN");
    tables.social_accounts = [{ id: "sa1", access_token_vault_id: "v1", refresh_token_vault_id: null, disconnected_at: NOW.toISOString(), tokens_wiped_at: null }];
    const r = await runPrivacySweep(db, NOW);
    expect(r).toMatchObject({ purgeFailed: true, commentsDeleted: 0, dmsDeleted: 0, messagesDeleted: 0, tokensWiped: 1 });
    expect(vault.get("v1")).toBe(WIPED_TOKEN_MARKER);
  });
});
