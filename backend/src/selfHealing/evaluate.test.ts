// Mapping the scheduler's existing error kinds onto the policy, and the pure side of shadow mode: what the old logic did, what the
// new policy would have done, and whether they differ.

import { describe, it, expect, vi } from "vitest";
import { errorClassOf, legacyOutcome, buildShadowEvent } from "./evaluate.js";
import { TOO_LATE_MESSAGE } from "./policy.js";

vi.mock("../supabase.js", () => ({ supabase: {} }));

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const post = (over: Record<string, unknown> = {}) => ({ id: "p1", social_account_id: "sa1", platform: "bluesky", retry_count: 0, scheduled_for: new Date(NOW - MIN).toISOString(), ...over });

describe("errorClassOf", () => {
  it("maps the existing kinds", () => {
    expect(errorClassOf("fatal")).toBe("fatal");
    expect(errorClassOf("reconnect")).toBe("auth");
    expect(errorClassOf("retry")).toBe("transient");
    expect(errorClassOf("ours")).toBe("transient");
  });
  it("a retry with a platform supplied wait is rate limited", () => {
    expect(errorClassOf("retry", { retryNotBefore: NOW + MIN })).toBe("rate_limited");
  });
  it("a retry on a post the platform may already hold is ambiguous, whatever else it says", () => {
    expect(errorClassOf("retry", { ambiguous: true })).toBe("ambiguous");
    expect(errorClassOf("retry", { ambiguous: true, retryNotBefore: NOW + MIN })).toBe("ambiguous");
  });
});

describe("legacyOutcome replays what the old logic does", () => {
  const base = { platform: "bluesky", now: NOW };
  it("retries at 2, 4 and 8 minutes, then fails", () => {
    expect([0, 1, 2].map((retryCount) => legacyOutcome({ ...base, kind: "retry", retryCount }).delayMs)).toEqual([2 * MIN, 4 * MIN, 8 * MIN]);
    expect(legacyOutcome({ ...base, kind: "retry", retryCount: 3 })).toEqual({ action: "fail", delayMs: null, reasonCode: "retries_exhausted" });
  });
  it("fatal fails at once and reconnect holds the connection", () => {
    expect(legacyOutcome({ ...base, kind: "fatal", retryCount: 0 })).toEqual({ action: "fail", delayMs: null, reasonCode: "fatal" });
    expect(legacyOutcome({ ...base, kind: "reconnect", retryCount: 0 })).toEqual({ action: "hold_connection", delayMs: null, reasonCode: "auth_rejected" });
  });
  it("waits for the platform, capped at 20 minutes (25 hours for WhatsApp)", () => {
    expect(legacyOutcome({ ...base, kind: "retry", retryCount: 0, retryNotBefore: NOW + 10 * MIN }).delayMs).toBe(10 * MIN);
    expect(legacyOutcome({ ...base, kind: "retry", retryCount: 0, retryNotBefore: NOW + 90 * MIN }).delayMs).toBe(20 * MIN);
    expect(legacyOutcome({ platform: "whatsapp", now: NOW, kind: "retry", retryCount: 0, retryNotBefore: NOW + 24 * 60 * MIN }).delayMs).toBe(24 * 60 * MIN);
    expect(legacyOutcome({ ...base, kind: "retry", retryCount: 1, retryNotBefore: NOW - MIN }).delayMs).toBe(4 * MIN);
  });
  it("a post the platform may hold is re-verified", () => {
    expect(legacyOutcome({ ...base, kind: "retry", retryCount: 0, ambiguous: true }).action).toBe("reverify");
  });
});

describe("buildShadowEvent", () => {
  const args = (over: Record<string, unknown> = {}) => ({ post: post(), kind: "retry" as const, message: "plain", now: NOW, random: () => 0.5, canRefresh: false, refreshTried: false, ...over });

  it("the first transient retry agrees with the old logic", () => {
    const e = buildShadowEvent(args());
    expect(e).toMatchObject({ source: "post", postId: "p1", socialAccountId: "sa1", platform: "bluesky", errorClass: "transient", legacyAction: "retry", legacyDelayMs: 2 * MIN, newAction: "retry", newDelayMs: 2 * MIN, diverged: false });
  });

  it("the second retry diverges (4 minutes before, 5 now)", () => {
    const e = buildShadowEvent(args({ post: post({ retry_count: 1 }) }));
    expect(e).toMatchObject({ legacyDelayMs: 4 * MIN, newDelayMs: 5 * MIN, diverged: true });
  });

  it("the fourth failure diverges: the old logic stops, the new one still retries", () => {
    const e = buildShadowEvent(args({ post: post({ retry_count: 3 }) }));
    expect(e).toMatchObject({ legacyAction: "fail", newAction: "retry", newDelayMs: 30 * MIN, diverged: true });
  });

  it("jitter alone is not a divergence", () => {
    expect(buildShadowEvent(args({ random: () => 0 })).diverged).toBe(false);
    expect(buildShadowEvent(args({ random: () => 0.99 })).diverged).toBe(false);
  });

  it("a retry that would run too late is a divergence with the too_late reason and the lateness at the moment of the decision", () => {
    const e = buildShadowEvent(args({ post: post({ retry_count: 3, scheduled_for: new Date(NOW - 100 * MIN).toISOString() }) }));
    expect(e).toMatchObject({ newAction: "fail", newReasonCode: "too_late", diverged: true, latenessMs: 100 * MIN });
  });

  it("an auth failure with a refresh path diverges, without one it agrees", () => {
    expect(buildShadowEvent(args({ kind: "reconnect", canRefresh: true })).diverged).toBe(true);
    const e = buildShadowEvent(args({ kind: "reconnect" }));
    expect(e).toMatchObject({ errorClass: "auth", legacyAction: "hold_connection", newAction: "hold_connection", newReasonCode: "auth_rejected", diverged: false });
  });

  it("fatal agrees", () => {
    expect(buildShadowEvent(args({ kind: "fatal" }))).toMatchObject({ errorClass: "fatal", legacyAction: "fail", newAction: "fail", newReasonCode: "fatal", diverged: false });
  });

  it("holds no content: only ids, fixed codes and numbers", () => {
    const e = buildShadowEvent(args({ message: "a customer's own words" }));
    expect(JSON.stringify(e)).not.toMatch(/customer|words|plain/);
    expect(TOO_LATE_MESSAGE).toBeTruthy();
  });
});
