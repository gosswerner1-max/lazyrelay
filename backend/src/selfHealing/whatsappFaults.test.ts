// WhatsApp fault tracking (whatsappFaults.ts): when a connection is having enough trouble to tell its owner once, and what an unknown
// Meta error code means. Pure: the clock is passed in. Only codes the repo already classifies are treated as known.

import { describe, it, expect, vi } from "vitest";
import { retryDelayMs } from "../whatsappBroadcast/metaErrors.js";
import {
  pushOutcome,
  assessFaults,
  cooldownElapsed,
  isUnknownMetaFailure,
  planUnknownFailure,
  FAULT_WINDOW_SIZE,
  FAULT_MIN_SENDS,
  FAULT_RATIO,
  FAULT_CONSECUTIVE,
  FAULT_ALERT_COOLDOWN_MS,
  UNKNOWN_MAX_ATTEMPTS,
  type SendOutcome,
} from "./whatsappFaults.js";

vi.mock("../supabase.js", () => ({ supabase: {} }));

const run = (...o: SendOutcome[]) => o.reduce<SendOutcome[]>((w, x) => pushOutcome(w, x), []);
const many = (n: number, o: SendOutcome): SendOutcome[] => Array.from({ length: n }, () => o);

describe("the agreed numbers", () => {
  it("5 in a row, or 20 percent of the last 50 with at least 10 sends, then 6 hours of quiet", () => {
    expect(FAULT_CONSECUTIVE).toBe(5);
    expect(FAULT_WINDOW_SIZE).toBe(50);
    expect(FAULT_MIN_SENDS).toBe(10);
    expect(FAULT_RATIO).toBe(0.2);
    expect(FAULT_ALERT_COOLDOWN_MS).toBe(6 * 60 * 60_000);
    expect(UNKNOWN_MAX_ATTEMPTS).toBe(3);
  });
});

describe("pushOutcome", () => {
  it("keeps only the last 50 and never changes the list it is given", () => {
    const w = many(50, "ok");
    const next = pushOutcome(w, "recipient_failed");
    expect(next).toHaveLength(50);
    expect(next[49]).toBe("recipient_failed");
    expect(w[49]).toBe("ok");
  });
});

describe("assessFaults", () => {
  it("5 failed sends in a row alert, whether they are per-recipient or account-level", () => {
    const a = assessFaults(run("ok", "recipient_failed", "recipient_failed", "recipient_failed", "recipient_failed", "account_fault"));
    expect(a).toMatchObject({ alert: true, trigger: "consecutive", recipientLevel: 4, accountLevel: 1 });
  });

  it("4 in a row do not", () => {
    expect(assessFaults(run("recipient_failed", "recipient_failed", "recipient_failed", "recipient_failed")).alert).toBe(false);
  });

  it("a success in the middle breaks the run", () => {
    expect(assessFaults(run("recipient_failed", "recipient_failed", "ok", "recipient_failed", "recipient_failed", "recipient_failed")).alert).toBe(false);
  });

  it("20 percent of at least 10 sends alerts, and the counts are those of the window", () => {
    const w = [...many(3, "ok"), "recipient_failed" as const, ...many(4, "ok"), "account_fault" as const, ...many(1, "ok")];
    expect(w).toHaveLength(10);
    expect(assessFaults(w)).toMatchObject({ alert: true, trigger: "ratio", failed: 2, recipientLevel: 1, accountLevel: 1, sends: 10 });
  });

  it("fewer than 10 sends never alert on the ratio, and under 20 percent does not alert", () => {
    expect(assessFaults([...many(7, "ok"), "recipient_failed", "account_fault"]).alert).toBe(false);
    expect(assessFaults([...many(41, "ok"), "recipient_failed", ...many(2, "ok"), "recipient_failed", ...many(5, "ok")]).alert).toBe(false); // 2 of 50
  });

  it("only the last 50 count", () => {
    const w = [...many(20, "recipient_failed"), ...many(50, "ok")].slice(-50);
    expect(assessFaults(w).alert).toBe(false);
  });
});

describe("cooldownElapsed", () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  it("is true with no earlier alert and once 6 hours have passed, false before", () => {
    expect(cooldownElapsed(null, now)).toBe(true);
    expect(cooldownElapsed(new Date(now - FAULT_ALERT_COOLDOWN_MS + 1).toISOString(), now)).toBe(false);
    expect(cooldownElapsed(new Date(now - FAULT_ALERT_COOLDOWN_MS).toISOString(), now)).toBe(true);
  });
  it("an unreadable stored time is treated as recent (fail closed: no second email)", () => {
    expect(cooldownElapsed("not a date", now)).toBe(false);
  });
});

describe("unknown Meta codes", () => {
  it("a code the repo already classifies as permanent is NOT unknown", () => {
    for (const code of [131026, 131021, 131047, 131045, 133010, 134011, 100, 3]) expect(isUnknownMetaFailure(code)).toBe(false);
  });
  it("a code the repo has never seen, or a rejection with no code at all, is unknown", () => {
    expect(isUnknownMetaFailure(999999)).toBe(true);
    expect(isUnknownMetaFailure(null)).toBe(true);
  });
  it("a code the repo calls transient but the sender did not retry is unknown, so it is retried within the cap", () => {
    expect(isUnknownMetaFailure(131056)).toBe(true);
  });

  it("is retried for attempts 1 and 2 and terminal unknown_error on attempt 3", () => {
    expect(planUnknownFailure({ attemptCount: 1, code: 999999, backoffMs: retryDelayMs(1) })).toEqual({ terminal: false, reason: null, delayMs: 60_000 });
    expect(planUnknownFailure({ attemptCount: 2, code: 999999, backoffMs: retryDelayMs(2) })).toEqual({ terminal: false, reason: null, delayMs: 5 * 60_000 });
    expect(planUnknownFailure({ attemptCount: 3, code: 999999, backoffMs: retryDelayMs(3) })).toEqual({ terminal: true, reason: "unknown_error", delayMs: null });
    expect(planUnknownFailure({ attemptCount: 4, code: 999999, backoffMs: retryDelayMs(4) }).terminal).toBe(true);
  });

  it("honours a wait the repo already knows for the code (131049: about 24 hours)", () => {
    const plan = planUnknownFailure({ attemptCount: 1, code: 131049, backoffMs: retryDelayMs(1) });
    expect(plan.terminal).toBe(false);
    expect(plan.delayMs).toBeGreaterThanOrEqual(23 * 60 * 60_000);
    expect(plan.delayMs).toBeLessThanOrEqual(24 * 60 * 60_000);
  });
});
