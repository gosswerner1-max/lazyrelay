import { describe, expect, it, vi } from "vitest";
import { createPublishGate, INSUFFICIENT_CREDITS_REASON, holdKey } from "./publishGate.js";
import type { WalletMode } from "./mode.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOLD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const POST = { accountId: ACCOUNT, chargeGroupId: GROUP, postId: "p1", attempt: 1, platform: "mastodon" };

function build(mode: WalletMode, over: Partial<Record<"hold" | "commit" | "release" | "charge", unknown>> = {}, legacy = false) {
  const ledger = {
    hold: vi.fn(async () => ({ ok: true, replay: false, holdId: HOLD, heldMicro: 1_000_000 })),
    commit: vi.fn(async () => ({ ok: true, replay: false, committedMicro: 1_000_000, balanceMicro: 0 })),
    release: vi.fn(async () => ({ ok: true, replay: false })),
    charge: vi.fn(async () => ({ ok: true, replay: false, chargedMicro: 1_000_000, balanceMicro: 0 })),
    ...over,
  };
  const log = vi.fn();
  const findHold = vi.fn(async () => ({ id: HOLD, status: "held" }));
  const gate = createPublishGate({ ledger: ledger as never, mode, isLegacy: async () => legacy, findHold, log });
  return { gate, ledger, log, findHold };
}

describe("hold key", () => {
  it("is post:{group}:a{attempt}", () => {
    expect(holdKey(GROUP, 1)).toBe(`post:${GROUP}:a1`);
    expect(holdKey("p9", 3)).toBe("post:p9:a3");
  });
});

describe("off", () => {
  it("does not touch the wallet at all", async () => {
    const { gate, ledger } = build("off");
    const r = await gate.reserve(POST);
    expect(r).toEqual({ proceed: true, hold: null });
    await gate.commit(null);
    await gate.release(null);
    expect(Object.values(ledger).every((f) => f.mock.calls.length === 0)).toBe(true);
  });
});

describe("shadow", () => {
  it("only logs what it would charge, never blocks and never calls the wallet", async () => {
    const { gate, ledger, log } = build("shadow");
    const r = await gate.reserve(POST);
    expect(r.proceed).toBe(true);
    if (r.proceed) await gate.commit(r.hold);
    expect(Object.values(ledger).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[wallet-shadow\].*would charge 1 credit/));
  });
});

describe("on", () => {
  it("reserves one post credit with the group key, then commits the hold", async () => {
    const { gate, ledger } = build("on");
    const r = await gate.reserve(POST);
    expect(ledger.hold).toHaveBeenCalledWith({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: `post:${GROUP}:a1` });
    expect(r.proceed).toBe(true);
    if (!r.proceed) return;
    await gate.commit(r.hold);
    expect(ledger.commit).toHaveBeenCalledWith(HOLD);
    expect(ledger.charge).not.toHaveBeenCalled();
  });

  it("a legacy account is never held or charged", async () => {
    const { gate, ledger } = build("on", {}, true);
    expect(await gate.reserve(POST)).toEqual({ proceed: true, hold: null });
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it("an exempt answer from the database proceeds with no hold", async () => {
    const { gate } = build("on", { hold: vi.fn(async () => ({ ok: true, replay: false, exempt: true, heldMicro: 0 })) });
    expect(await gate.reserve(POST)).toEqual({ proceed: true, hold: null });
  });

  it("not enough credits: does not proceed, with a plain reason", async () => {
    const { gate } = build("on", { hold: vi.fn(async () => ({ ok: false, reason: "insufficient_credits", balanceMicro: 0, requiredMicro: 1_000_000 })) });
    expect(await gate.reserve(POST)).toEqual({ proceed: false, reason: INSUFFICIENT_CREDITS_REASON });
    expect(INSUFFICIENT_CREDITS_REASON).toMatch(/credits/i);
  });

  it("not enough credits for a post that is already live on the platform still proceeds (a late charge is tried at commit)", async () => {
    const { gate, ledger } = build("on", { hold: vi.fn(async () => ({ ok: false, reason: "insufficient_credits", balanceMicro: 0, requiredMicro: 1_000_000 })) });
    const r = await gate.reserve({ ...POST, alreadyPublished: true });
    expect(r.proceed).toBe(true);
    if (!r.proceed) return;
    await gate.commit(r.hold);
    expect(ledger.charge).toHaveBeenCalledWith({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: `post:${GROUP}:late` });
  });

  it("a wallet outage never stops a post: it proceeds and is logged without database text", async () => {
    const { gate, log } = build("on", { hold: vi.fn(async () => { throw new Error("boom 10.0.0.5"); }) });
    expect(await gate.reserve(POST)).toEqual({ proceed: true, hold: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain("10.0.0.5");
  });

  it("a hold that was released or expired in the meantime is replaced by one late charge at commit", async () => {
    const { gate, ledger } = build("on", { commit: vi.fn(async () => ({ ok: false, reason: "hold_not_held", status: "expired" })) });
    const r = await gate.reserve(POST);
    if (!r.proceed) throw new Error("should proceed");
    await gate.commit(r.hold);
    expect(ledger.charge).toHaveBeenCalledTimes(1);
  });

  it("a hold already committed by another post of the same group is not charged again", async () => {
    const { gate, ledger } = build("on", { commit: vi.fn(async () => ({ ok: false, reason: "hold_not_held", status: "committed" })) });
    const r = await gate.reserve(POST);
    if (!r.proceed) throw new Error("should proceed");
    await gate.commit(r.hold);
    expect(ledger.charge).not.toHaveBeenCalled();
  });

  it("commit and release never throw", async () => {
    const boom = vi.fn(async () => { throw new Error("down"); });
    const { gate } = build("on", { commit: boom, release: boom, charge: boom });
    const r = await gate.reserve(POST);
    if (!r.proceed) throw new Error("should proceed");
    await expect(gate.commit(r.hold)).resolves.toBeUndefined();
    await expect(gate.release(r.hold)).resolves.toBeUndefined();
  });

  it("release frees the hold", async () => {
    const { gate, ledger } = build("on");
    const r = await gate.reserve(POST);
    if (!r.proceed) throw new Error("should proceed");
    await gate.release(r.hold);
    expect(ledger.release).toHaveBeenCalledWith(HOLD);
  });

  it("releaseForPost (stuck sweep) finds the hold by its key and releases it; no hold means nothing to do", async () => {
    const a = build("on");
    await a.gate.releaseForPost(POST);
    expect(a.findHold).toHaveBeenCalledWith(ACCOUNT, `post:${GROUP}:a1`);
    expect(a.ledger.release).toHaveBeenCalledWith(HOLD);
    const b = build("on");
    b.findHold.mockResolvedValueOnce(null as never);
    await b.gate.releaseForPost(POST);
    expect(b.ledger.release).not.toHaveBeenCalled();
  });

  it("refuses to build a hold for an account id that is not a uuid, and lets the post go", async () => {
    const { gate, ledger } = build("on");
    expect(await gate.reserve({ ...POST, accountId: "nope" })).toEqual({ proceed: true, hold: null });
    expect(ledger.hold).not.toHaveBeenCalled();
  });
});
