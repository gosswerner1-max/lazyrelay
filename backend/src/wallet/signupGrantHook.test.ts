import { describe, it, expect, vi } from "vitest";
import { createSignupGrantTrigger } from "./signupGrantHook.js";
import type { SignupGrantOutcome } from "./service.js";

function setup(opts: { mode?: "off" | "shadow" | "on"; outcome?: SignupGrantOutcome; fail?: Error } = {}) {
  let t = 1_000_000;
  const grant = vi.fn(async (_id: string): Promise<SignupGrantOutcome> => {
    if (opts.fail) throw opts.fail;
    return opts.outcome ?? { granted: true, reason: "granted" };
  });
  const log = vi.fn();
  const trigger = createSignupGrantTrigger({ mode: () => opts.mode ?? "on", grant, now: () => t, log });
  return { trigger, grant, log, advance: (ms: number) => (t += ms) };
}

describe("signup grant trigger (called from the authenticated request path)", () => {
  it("does nothing when the wallet is off or in shadow", async () => {
    for (const mode of ["off", "shadow"] as const) {
      const s = setup({ mode });
      await s.trigger("a1");
      expect(s.grant).not.toHaveBeenCalled();
    }
  });

  it("grants once when on, then skips the account for the rest of the process", async () => {
    const s = setup();
    await s.trigger("a1");
    await s.trigger("a1");
    expect(s.grant).toHaveBeenCalledTimes(1);
  });

  it("settles on replay and legacy too", async () => {
    for (const reason of ["replay", "legacy"] as const) {
      const s = setup({ outcome: { granted: false, reason } });
      await s.trigger("a1");
      await s.trigger("a1");
      expect(s.grant).toHaveBeenCalledTimes(1);
    }
  });

  it("asks again after 60 seconds while the e-mail is still unconfirmed, not before", async () => {
    const s = setup({ outcome: { granted: false, reason: "email_unconfirmed" } });
    await s.trigger("a1");
    s.advance(30_000);
    await s.trigger("a1");
    expect(s.grant).toHaveBeenCalledTimes(1);
    s.advance(31_000);
    await s.trigger("a1");
    expect(s.grant).toHaveBeenCalledTimes(2);
  });

  it("never throws, logs the raw error loudly, and retries after 60 seconds", async () => {
    const boom = new Error("ledger down");
    const s = setup({ fail: boom });
    await expect(s.trigger("a1")).resolves.toBeUndefined();
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("a1"), boom);
    await s.trigger("a1");
    expect(s.grant).toHaveBeenCalledTimes(1);
    s.advance(61_000);
    await s.trigger("a1");
    expect(s.grant).toHaveBeenCalledTimes(2);
  });

  it("does not run two grants for the same account at once", async () => {
    const s = setup();
    await Promise.all([s.trigger("a1"), s.trigger("a1")]);
    expect(s.grant).toHaveBeenCalledTimes(1);
  });
});
