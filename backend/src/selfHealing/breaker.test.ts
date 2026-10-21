// The half-open circuit breaker state machine (policy.ts). Pure: every function takes the state and the time and returns a new state.

import { describe, it, expect } from "vitest";
import {
  newBreaker,
  breakerAdmit,
  breakerSuccess,
  breakerFailure,
  breakerReleaseProbe,
  SHARED_BREAKER,
  CUSTOMER_KEY_BREAKER,
  MAX_BREAKER_COOLDOWN_MS,
  PROBE_TIMEOUT_MS,
  type HealingBreaker,
} from "./policy.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

function trip(cfg = SHARED_BREAKER, at = T0): HealingBreaker {
  let s = newBreaker(cfg);
  for (let i = 0; i < cfg.threshold; i++) s = breakerFailure(s, cfg, at).state;
  return s;
}

describe("closed and open", () => {
  it("lets everything through while closed, and trips on the threshold", () => {
    let s = newBreaker(SHARED_BREAKER);
    for (let i = 0; i < 4; i++) {
      const r = breakerFailure(s, SHARED_BREAKER, T0);
      expect(r.event).toBe("none");
      s = r.state;
      expect(breakerAdmit(s, T0).verdict).toBe("go");
    }
    const tripped = breakerFailure(s, SHARED_BREAKER, T0);
    expect(tripped.event).toBe("tripped");
    expect(tripped.state.trippedUntil).toBe(T0 + 5 * MIN);
    expect(breakerAdmit(tripped.state, T0 + MIN).verdict).toBe("stop");
  });

  it("customer-owned connections use 3 failures and 15 minutes", () => {
    const s = trip(CUSTOMER_KEY_BREAKER);
    expect(s.trippedUntil).toBe(T0 + 15 * MIN);
  });

  it("a success while closed resets the failure count", () => {
    let s = newBreaker(SHARED_BREAKER);
    for (let i = 0; i < 4; i++) s = breakerFailure(s, SHARED_BREAKER, T0).state;
    s = breakerSuccess(s, SHARED_BREAKER);
    for (let i = 0; i < 4; i++) s = breakerFailure(s, SHARED_BREAKER, T0).state;
    expect(s.trippedUntil).toBeNull();
  });

  it("a failure that arrives while open changes nothing", () => {
    const s = trip();
    const r = breakerFailure(s, SHARED_BREAKER, T0 + MIN);
    expect(r.event).toBe("none");
    expect(r.state).toEqual(s);
  });
});

describe("half-open: exactly one probe", () => {
  it("allows one attempt when the cooldown ends and refuses the rest", () => {
    const s = trip();
    const first = breakerAdmit(s, T0 + 5 * MIN);
    expect(first.verdict).toBe("probe");
    const second = breakerAdmit(first.state, T0 + 5 * MIN);
    expect(second.verdict).toBe("stop");
    expect(breakerAdmit(second.state, T0 + 6 * MIN).verdict).toBe("stop");
  });

  it("a successful probe closes the breaker and resets the cooldown", () => {
    let s = trip();
    s = breakerAdmit(s, T0 + 5 * MIN).state;
    s = breakerFailure(s, SHARED_BREAKER, T0 + 5 * MIN).state; // first probe fails: cooldown doubles
    expect(s.cooldownMs).toBe(10 * MIN);
    s = breakerAdmit(s, T0 + 15 * MIN).state;
    s = breakerSuccess(s, SHARED_BREAKER);
    expect(s).toEqual(newBreaker(SHARED_BREAKER));
    expect(breakerAdmit(s, T0 + 15 * MIN).verdict).toBe("go");
    // and a later trip starts from the base cooldown again
    for (let i = 0; i < 5; i++) s = breakerFailure(s, SHARED_BREAKER, T0 + 20 * MIN).state;
    expect(s.trippedUntil).toBe(T0 + 25 * MIN);
  });

  it("a failed probe re-opens with the cooldown doubled, capped at 60 minutes", () => {
    let s = trip();
    let now = T0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      now = s.trippedUntil as number;
      const probe = breakerAdmit(s, now);
      expect(probe.verdict).toBe("probe");
      const failed = breakerFailure(probe.state, SHARED_BREAKER, now);
      expect(failed.event).toBe("reopened");
      s = failed.state;
      seen.push(s.cooldownMs / MIN);
      expect(s.trippedUntil).toBe(now + s.cooldownMs);
      expect(breakerAdmit(s, now).verdict).toBe("stop");
    }
    expect(seen).toEqual([10, 20, 40, 60, 60, 60]);
    expect(MAX_BREAKER_COOLDOWN_MS).toBe(60 * MIN);
  });

  it("the customer-key breaker doubles 15, 30, 60 and stays at 60", () => {
    let s = trip(CUSTOMER_KEY_BREAKER);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const now = s.trippedUntil as number;
      s = breakerFailure(breakerAdmit(s, now).state, CUSTOMER_KEY_BREAKER, now).state;
      seen.push(s.cooldownMs / MIN);
    }
    expect(seen).toEqual([30, 60, 60, 60]);
  });

  it("a probe that never reports back does not lock the platform for ever", () => {
    const s = trip();
    const probe = breakerAdmit(s, T0 + 5 * MIN);
    expect(breakerAdmit(probe.state, T0 + 5 * MIN + PROBE_TIMEOUT_MS - 1).verdict).toBe("stop");
    expect(breakerAdmit(probe.state, T0 + 5 * MIN + PROBE_TIMEOUT_MS).verdict).toBe("probe");
  });

  it("releasing a probe that had no outcome lets the next attempt be the probe", () => {
    const probe = breakerAdmit(trip(), T0 + 5 * MIN);
    const released = breakerReleaseProbe(probe.state);
    expect(breakerAdmit(released, T0 + 5 * MIN).verdict).toBe("probe");
    expect(released.trippedUntil).toBe(probe.state.trippedUntil);
  });
});

describe("purity", () => {
  it("never changes the state it is given", () => {
    const s = trip();
    const copy = JSON.stringify(s);
    breakerAdmit(s, T0 + 5 * MIN);
    breakerFailure(s, SHARED_BREAKER, T0 + 5 * MIN);
    breakerSuccess(s, SHARED_BREAKER);
    breakerReleaseProbe(s);
    expect(JSON.stringify(s)).toBe(copy);
  });
});
