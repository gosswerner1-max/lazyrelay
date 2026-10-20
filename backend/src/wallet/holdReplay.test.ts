import { describe, expect, it } from "vitest";
import { createWalletLedger, type WalletRpc } from "./ledger.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rpc = (data: unknown): WalletRpc => ({ rpc: async () => ({ data, error: null }) });

describe("hold replay reports the status of the original hold", () => {
  it("keeps the database status on a replay so a caller can tell committed from held", async () => {
    for (const status of ["held", "committed", "released", "expired"]) {
      const out = await createWalletLedger(rpc({ ok: true, replay: true, hold_id: HOLD, held_micro: 10_000_000, status })).hold({ accountId: ACCOUNT, action: "competitor_teardown", idempotencyKey: "k" });
      expect(out).toEqual({ ok: true, replay: true, holdId: HOLD, heldMicro: 10_000_000, status });
    }
  });

  it("a first time hold carries no status, and an unknown status is refused", async () => {
    const first = await createWalletLedger(rpc({ ok: true, replay: false, hold_id: HOLD, held_micro: 10_000_000 })).hold({ accountId: ACCOUNT, action: "competitor_teardown", idempotencyKey: "k" });
    expect(first).toEqual({ ok: true, replay: false, holdId: HOLD, heldMicro: 10_000_000 });
    await expect(createWalletLedger(rpc({ ok: true, replay: true, hold_id: HOLD, held_micro: 10_000_000, status: "weird" })).hold({ accountId: ACCOUNT, action: "competitor_teardown", idempotencyKey: "k" })).rejects.toMatchObject({ code: "bad_answer" });
  });
});
