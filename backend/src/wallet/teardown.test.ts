import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runTeardown, type TeardownDeps } from "./teardown.js";
import { EngineError } from "./engineClient.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const HOLD = "33333333-3333-4333-8333-333333333333";
const input = { accountId: ACCOUNT, userId: "user-1", tier: "free" as const, idempotencyKey: "click-abc123", input: "https://rival.example" };

function make(over: Partial<TeardownDeps> = {}) {
  const hold = vi.fn(async (_i: unknown): Promise<any> => ({ ok: true, replay: false, holdId: HOLD, heldMicro: 10_000_000 }));
  const commit = vi.fn(async (_id: string): Promise<any> => ({ ok: true, replay: false, committedMicro: 10_000_000, balanceMicro: 20_000_000 }));
  const release = vi.fn(async (_id: string): Promise<any> => ({ ok: true, replay: false }));
  const analyze = vi.fn(async () => ({ analysis: "a" }));
  const blueprint = vi.fn(async () => ({ blueprint: "b" }));
  const deps: TeardownDeps = { ledger: { hold, commit, release }, isLegacy: async () => false, engine: { analyze, blueprint }, ...over };
  return { deps, hold, commit, release, analyze, blueprint };
}

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("runTeardown", () => {
  it("holds 10 credits under the key teardown:{key}, calls the engine, then commits the hold", async () => {
    const m = make();
    const out = await runTeardown(m.deps, input);
    expect(m.hold).toHaveBeenCalledWith({ accountId: ACCOUNT, action: "competitor_teardown", idempotencyKey: "teardown:click-abc123" });
    expect(m.analyze).toHaveBeenCalledWith({ userId: "user-1", accountId: ACCOUNT, tier: "free" }, "https://rival.example");
    expect(m.blueprint).toHaveBeenCalledTimes(1);
    expect(m.commit).toHaveBeenCalledWith(HOLD);
    expect(m.release).not.toHaveBeenCalled();
    expect(out).toEqual({ status: 200, body: { analysis: { analysis: "a" }, blueprint: { blueprint: "b" }, charged: true } });
    // the engine is only reached after the hold exists
    expect(m.hold.mock.invocationCallOrder[0]).toBeLessThan(m.analyze.mock.invocationCallOrder[0]);
  });

  it("releases the hold and reports the raw engine error when the engine fails, and never commits", async () => {
    const m = make();
    m.blueprint.mockRejectedValueOnce(new EngineError("engine said no", { status: 503, code: "competitor_mode_unavailable" }));
    const out = await runTeardown(m.deps, input);
    expect(m.release).toHaveBeenCalledWith(HOLD);
    expect(m.commit).not.toHaveBeenCalled();
    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ error: "engine_failed", engineStatus: 503, engineCode: "competitor_mode_unavailable", charged: false });
    expect(console.error).toHaveBeenCalled();
  });

  it("releases on a timeout too", async () => {
    const m = make();
    m.analyze.mockRejectedValueOnce(new EngineError("timed out", { code: "timeout" }));
    const out = await runTeardown(m.deps, input);
    expect(m.release).toHaveBeenCalledWith(HOLD);
    expect(m.blueprint).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ error: "engine_failed", engineCode: "timeout" });
  });

  it("releases and rethrows an unexpected crash so nothing is swallowed", async () => {
    const m = make();
    m.analyze.mockRejectedValueOnce(new TypeError("boom"));
    await expect(runTeardown(m.deps, input)).rejects.toThrow("boom");
    expect(m.release).toHaveBeenCalledWith(HOLD);
  });

  it("answers 402 and never calls the engine when the balance is short", async () => {
    const m = make();
    m.hold.mockResolvedValueOnce({ ok: false, reason: "insufficient_credits", balanceMicro: 3_000_000, requiredMicro: 10_000_000 });
    const out = await runTeardown(m.deps, input);
    expect(out).toEqual({ status: 402, body: { error: "insufficient_credits", balanceMicro: 3_000_000, requiredMicro: 10_000_000 } });
    expect(m.analyze).not.toHaveBeenCalled();
  });

  it("does not double charge when the same key is replayed after a commit: no engine call, no second commit", async () => {
    const m = make();
    m.hold.mockResolvedValueOnce({ ok: true, replay: true, holdId: HOLD, heldMicro: 10_000_000, status: "committed" });
    const out = await runTeardown(m.deps, input);
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "already_processed" });
    expect(m.analyze).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });

  it("answers 409 for a replay while the first call is still running", async () => {
    const m = make();
    m.hold.mockResolvedValueOnce({ ok: true, replay: true, holdId: HOLD, heldMicro: 10_000_000, status: "held" });
    const out = await runTeardown(m.deps, input);
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "in_progress" });
    expect(m.analyze).not.toHaveBeenCalled();
  });

  it("answers 409 for a replay of a key whose hold was released, telling the client to use a new key", async () => {
    const m = make();
    m.hold.mockResolvedValueOnce({ ok: true, replay: true, holdId: HOLD, heldMicro: 10_000_000, status: "released" });
    const out = await runTeardown(m.deps, input);
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "key_already_used" });
    expect(m.analyze).not.toHaveBeenCalled();
  });

  it("lets a legacy account through the engine without any hold or charge", async () => {
    const m = make({ isLegacy: async () => true });
    const out = await runTeardown(m.deps, input);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.analyze).toHaveBeenCalled();
    expect(out).toEqual({ status: 200, body: { analysis: { analysis: "a" }, blueprint: { blueprint: "b" }, charged: false } });
  });

  it("treats an exempt hold answer the same way: engine runs, nothing to commit", async () => {
    const m = make();
    m.hold.mockResolvedValueOnce({ ok: true, replay: false, exempt: true, heldMicro: 0 });
    const out = await runTeardown(m.deps, input);
    expect(m.commit).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ charged: false });
  });

  it("still delivers the blueprint when the commit cannot be made, and says so loudly", async () => {
    const m = make();
    m.commit.mockResolvedValueOnce({ ok: false, reason: "hold_not_held", status: "expired" });
    const out = await runTeardown(m.deps, input);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ charged: false });
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps the engine error as the answer even if the release itself fails", async () => {
    const m = make();
    m.blueprint.mockRejectedValueOnce(new EngineError("bad", { status: 500, code: "x" }));
    m.release.mockRejectedValueOnce(new Error("wallet down"));
    const out = await runTeardown(m.deps, input);
    expect(out.status).toBe(502);
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});
