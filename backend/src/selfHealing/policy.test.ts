// The self-healing retry policy (policy.ts) is pure: every input, including the clock and the random source, is passed in.

import { describe, it, expect } from "vitest";
import { selfHealingMode } from "./mode.js";
import {
  decideRetry,
  checkFreshness,
  FRESHNESS_LIMIT_MS,
  TOO_LATE_MESSAGE,
  TRANSIENT_RETRY_BASE_MS,
  MAX_RETRIES,
  type RetryInput,
} from "./policy.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const MID = () => 0.5; // jitter factor exactly 1.0

function input(over: Partial<RetryInput> = {}): RetryInput {
  return {
    errorClass: "transient",
    platform: "bluesky",
    retryCount: 0,
    now: NOW,
    random: MID,
    scheduledFor: NOW - MIN,
    message: "Bluesky had a temporary problem. LazyRelay will try again automatically.",
    ...over,
  };
}

describe("SELF_HEALING_MODE", () => {
  it("is off when unset or anything other than the exact words shadow or on", () => {
    expect(selfHealingMode({})).toBe("off");
    expect(selfHealingMode({ SELF_HEALING_MODE: "" })).toBe("off");
    expect(selfHealingMode({ SELF_HEALING_MODE: "ON" })).toBe("off");
    expect(selfHealingMode({ SELF_HEALING_MODE: "true" })).toBe("off");
    expect(selfHealingMode({ SELF_HEALING_MODE: " on" })).toBe("off");
    expect(selfHealingMode({ SELF_HEALING_MODE: "off" })).toBe("off");
  });
  it("reads shadow and on exactly", () => {
    expect(selfHealingMode({ SELF_HEALING_MODE: "shadow" })).toBe("shadow");
    expect(selfHealingMode({ SELF_HEALING_MODE: "on" })).toBe("on");
  });
});

describe("transient errors: 4 retries at 2, 5, 15 and 30 minutes", () => {
  it("uses the agreed base delays", () => {
    expect(TRANSIENT_RETRY_BASE_MS).toEqual([2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN]);
    expect(MAX_RETRIES).toBe(4);
  });

  it("retries after each base delay when the jitter factor is exactly 1", () => {
    TRANSIENT_RETRY_BASE_MS.forEach((base, i) => {
      const d = decideRetry(input({ retryCount: i }));
      expect(d).toMatchObject({ action: "retry", delayMs: base, runAt: NOW + base, baseDelayMs: base });
    });
  });

  it("about 52 minutes in all", () => {
    const total = TRANSIENT_RETRY_BASE_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(52 * MIN);
  });

  it("multiplies each delay by a factor between 0.8 and 1.2 taken from the random source", () => {
    const low = decideRetry(input({ retryCount: 2, random: () => 0 }));
    const high = decideRetry(input({ retryCount: 2, random: () => 0.999999 }));
    expect(low).toMatchObject({ action: "retry", delayMs: Math.round(15 * MIN * 0.8) });
    expect(high.action).toBe("retry");
    if (high.action === "retry") {
      expect(high.delayMs).toBeGreaterThan(15 * MIN * 1.19);
      expect(high.delayMs).toBeLessThanOrEqual(15 * MIN * 1.2);
    }
  });

  it("does not use the same delay for two different random values (the jitter is real)", () => {
    const a = decideRetry(input({ random: () => 0.1 }));
    const b = decideRetry(input({ random: () => 0.9 }));
    expect(a.action === "retry" && b.action === "retry" && a.delayMs !== b.delayMs).toBe(true);
  });

  it("the fifth failure is terminal retries_exhausted and keeps the plain sentence", () => {
    const d = decideRetry(input({ retryCount: 4 }));
    expect(d).toEqual({ action: "fail", reason: "retries_exhausted", message: input().message });
  });
});

describe("rate limited errors honour the platform wait and count toward the 4", () => {
  it("waits exactly as long as the platform said when that is longer than the backoff", () => {
    const d = decideRetry(input({ errorClass: "rate_limited", platformWaitUntil: NOW + 10 * MIN, random: () => 0.99 }));
    expect(d).toMatchObject({ action: "retry", delayMs: 10 * MIN });
  });

  it("never waits more than 20 minutes for a platform asking for longer", () => {
    const d = decideRetry(input({ errorClass: "rate_limited", platformWaitUntil: NOW + 3 * 60 * MIN }));
    expect(d).toMatchObject({ action: "retry", delayMs: 20 * MIN });
  });

  it("WhatsApp keeps its 25 hour cap", () => {
    const d = decideRetry(input({ errorClass: "rate_limited", platform: "whatsapp", platformWaitUntil: NOW + 24 * 60 * MIN }));
    expect(d).toMatchObject({ action: "retry", delayMs: 24 * 60 * MIN });
    const capped = decideRetry(input({ errorClass: "rate_limited", platform: "whatsapp", platformWaitUntil: NOW + 40 * 60 * MIN }));
    expect(capped).toMatchObject({ action: "retry", delayMs: 25 * 60 * MIN });
  });

  it("uses the backoff when it is longer than the platform wait", () => {
    const d = decideRetry(input({ errorClass: "rate_limited", retryCount: 3, platformWaitUntil: NOW + 5 * MIN }));
    expect(d).toMatchObject({ action: "retry", delayMs: 30 * MIN });
  });

  it("is terminal on the fifth failure like any other retry", () => {
    expect(decideRetry(input({ errorClass: "rate_limited", retryCount: 4, platformWaitUntil: NOW + MIN }))).toMatchObject({ action: "fail", reason: "retries_exhausted" });
  });
});

describe("auth errors: no blind retries", () => {
  it("tries one token refresh when the platform has a refresh path", () => {
    const d = decideRetry(input({ errorClass: "auth", auth: { canRefresh: true, refreshTried: false } }));
    expect(d).toMatchObject({ action: "retry", delayMs: 0, refreshFirst: true });
  });
  it("holds the connection when the refresh was already tried", () => {
    expect(decideRetry(input({ errorClass: "auth", auth: { canRefresh: true, refreshTried: true } })).action).toBe("hold_connection");
  });
  it("holds the connection when there is no refresh path", () => {
    expect(decideRetry(input({ errorClass: "auth", auth: { canRefresh: false, refreshTried: false } })).action).toBe("hold_connection");
    expect(decideRetry(input({ errorClass: "auth" })).action).toBe("hold_connection");
  });
  it("never returns a plain retry for auth", () => {
    for (const canRefresh of [true, false]) {
      for (const refreshTried of [true, false]) {
        for (const retryCount of [0, 1, 4, 9]) {
          const d = decideRetry(input({ errorClass: "auth", retryCount, auth: { canRefresh, refreshTried } }));
          expect(d.action === "retry" ? d.refreshFirst === true : true).toBe(true);
        }
      }
    }
  });
});

describe("fatal errors fail at once with the plain reason", () => {
  it("fails with the given sentence", () => {
    expect(decideRetry(input({ errorClass: "fatal", message: "Pinterest blocked the link." }))).toEqual({ action: "fail", reason: "fatal", message: "Pinterest blocked the link." });
  });
});

describe("ambiguous errors only re-verify", () => {
  it("never retries a publish: the decision is reverify", () => {
    const d = decideRetry(input({ errorClass: "ambiguous", retryCount: 1 }));
    expect(d).toMatchObject({ action: "reverify", delayMs: 5 * MIN });
  });
  it("is not failed as too_late: re-checking a post is not publishing it again", () => {
    const d = decideRetry(input({ errorClass: "ambiguous", scheduledFor: NOW - 5 * 60 * MIN }));
    expect(d.action).toBe("reverify");
  });
  it("gives up as retries_exhausted after the schedule is used up", () => {
    expect(decideRetry(input({ errorClass: "ambiguous", retryCount: 4 }))).toMatchObject({ action: "fail", reason: "retries_exhausted" });
  });
});

describe("freshness: never published more than 2 hours after its time", () => {
  it("the limit is 2 hours and the sentence is the approved one", () => {
    expect(FRESHNESS_LIMIT_MS).toBe(2 * 60 * MIN);
    expect(TOO_LATE_MESSAGE).toBe("This post was not sent because it was more than 2 hours past its time. Reschedule it if you still want it out.");
  });

  it("a retry that would run more than 2 hours after scheduled_for fails as too_late", () => {
    const d = decideRetry(input({ retryCount: 3, scheduledFor: NOW - 100 * MIN })); // runs at 130 minutes late
    expect(d).toEqual({ action: "fail", reason: "too_late", message: TOO_LATE_MESSAGE });
  });

  it("a retry that would run exactly 2 hours after is still allowed", () => {
    const d = decideRetry(input({ retryCount: 3, scheduledFor: NOW - 90 * MIN }));
    expect(d).toMatchObject({ action: "retry", runAt: NOW + 30 * MIN });
  });

  it("does not apply to WhatsApp", () => {
    const d = decideRetry(input({ platform: "whatsapp", retryCount: 3, scheduledFor: NOW - 10 * 60 * MIN }));
    expect(d.action).toBe("retry");
  });

  it("does not apply when scheduled_for is unknown (fails open for the old rule, never invents a time)", () => {
    expect(decideRetry(input({ scheduledFor: null })).action).toBe("retry");
  });

  it("checkFreshness at claim time: late posts are too late, WhatsApp and on-time posts are not", () => {
    expect(checkFreshness({ platform: "x", scheduledFor: NOW - 2 * 60 * MIN - 1, now: NOW })).toEqual({ action: "fail", reason: "too_late", message: TOO_LATE_MESSAGE });
    expect(checkFreshness({ platform: "x", scheduledFor: NOW - 2 * 60 * MIN, now: NOW })).toBeNull();
    expect(checkFreshness({ platform: "whatsapp", scheduledFor: NOW - 24 * 60 * MIN, now: NOW })).toBeNull();
    expect(checkFreshness({ platform: "x", scheduledFor: null, now: NOW })).toBeNull();
  });
});

describe("purity", () => {
  it("gives the same answer for the same input and does not change it", () => {
    const i = input({ retryCount: 2, random: () => 0.3 });
    const copy = JSON.stringify({ ...i, random: undefined });
    const a = decideRetry(i);
    const b = decideRetry(i);
    expect(a).toEqual(b);
    expect(JSON.stringify({ ...i, random: undefined })).toBe(copy);
  });
});
