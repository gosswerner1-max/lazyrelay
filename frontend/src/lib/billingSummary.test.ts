import { describe, expect, it } from "vitest";
import {
  balanceStatus,
  buildAllocation,
  describeCountdown,
  expirationNotice,
  formatCredits,
  statusLabel,
  statusMark,
  totalCredits,
  wholeDaysLeft,
  type CreditLot,
} from "./billingSummary";

const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const after = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const sub = (remaining: number, ms: number | null, over: Partial<CreditLot> = {}): CreditLot => ({
  kind: "subscription",
  remaining,
  expiresAt: ms === null ? null : after(ms),
  autoRenew: true,
  planName: "Pro",
  ...over,
});
const topup = (remaining: number, ms: number | null, over: Partial<CreditLot> = {}): CreditLot => ({
  kind: "topup",
  remaining,
  expiresAt: ms === null ? null : after(ms),
  boundPlan: "pro",
  ...over,
});
const pack = (remaining: number): CreditLot => ({ kind: "pack", remaining, expiresAt: null });
const signup = (remaining: number): CreditLot => ({ kind: "signup", remaining, expiresAt: null });

describe("totalCredits", () => {
  it("is 0 for an empty wallet", () => {
    expect(totalCredits([], NOW)).toBe(0);
  });
  it("adds every active lot", () => {
    expect(totalCredits([sub(100, 5 * DAY), topup(50, 5 * DAY), pack(7), signup(3)], NOW)).toBe(160);
  });
  it("leaves out a lot whose expiry has passed or is exactly now", () => {
    expect(totalCredits([sub(100, -1), topup(50, 0), pack(7)], NOW)).toBe(7);
  });
});

describe("balanceStatus (thresholds)", () => {
  it.each([
    [0, "low"],
    [20, "low"],
    [21, "medium"],
    [99, "medium"],
    [100, "high"],
    [5000, "high"],
  ] as const)("%i credits is %s", (total, status) => {
    expect(balanceStatus(total)).toBe(status);
  });
  it("states the status in words and with a visible mark that is not only a colour", () => {
    expect(statusLabel("high")).toBe("Balance is high");
    expect(statusLabel("medium")).toBe("Balance is getting low");
    expect(statusLabel("low")).toBe("Balance is critically low");
    expect(statusMark("high")).toBe("");
    expect(statusMark("medium")).toBe("Low");
    expect(statusMark("low")).toBe("Critical");
  });
});

describe("formatCredits", () => {
  it("uses a thousands separator and whole numbers", () => {
    expect(formatCredits(0)).toBe("0");
    expect(formatCredits(999)).toBe("999");
    expect(formatCredits(1234567)).toBe("1,234,567");
  });
});

describe("countdown", () => {
  it("rounds the remaining time up to whole days", () => {
    expect(wholeDaysLeft(after(DAY + 1), NOW)).toBe(2);
    expect(wholeDaysLeft(after(DAY), NOW)).toBe(1);
    expect(wholeDaysLeft(after(3 * DAY), NOW)).toBe(3);
    expect(wholeDaysLeft(after(2.5 * DAY), NOW)).toBe(3);
  });
  it("says today when under a day (and when already past)", () => {
    expect(describeCountdown(after(DAY - 1), NOW)).toBe("today");
    expect(describeCountdown(after(HOUR), NOW)).toBe("today");
    expect(describeCountdown(after(-DAY), NOW)).toBe("today");
    expect(wholeDaysLeft(after(-DAY), NOW)).toBe(0);
  });
  it("is singular for exactly one day and plural otherwise", () => {
    expect(describeCountdown(after(DAY), NOW)).toBe("1 day");
    expect(describeCountdown(after(DAY + 1), NOW)).toBe("2 days");
    expect(describeCountdown(after(12 * DAY), NOW)).toBe("12 days");
  });
});

describe("expirationNotice (banner rule)", () => {
  it("is null for an empty wallet and for lots that never expire", () => {
    expect(expirationNotice([], NOW)).toBeNull();
    expect(expirationNotice([pack(10), signup(5)], NOW)).toBeNull();
    expect(expirationNotice([sub(10, null)], NOW)).toBeNull();
  });
  it("is null at exactly 7 days and shows below it", () => {
    expect(expirationNotice([sub(100, 7 * DAY)], NOW)).toBeNull();
    expect(expirationNotice([sub(100, 7 * DAY - 1)], NOW)).not.toBeNull();
    expect(expirationNotice([sub(100, 6.5 * DAY)], NOW)).not.toBeNull();
  });
  it("ignores an empty or already expired lot", () => {
    expect(expirationNotice([sub(0, 2 * DAY)], NOW)).toBeNull();
    expect(expirationNotice([sub(100, -DAY)], NOW)).toBeNull();
  });
  it("names the plan, the day count and the date", () => {
    const n = expirationNotice([sub(100, 3 * DAY)], NOW);
    expect(n?.message).toBe("Your Pro Plan credits expire in 3 days (2026-10-23). Unused plan credits do not roll over.");
  });
  it("uses singular and today wording", () => {
    expect(expirationNotice([sub(100, DAY)], NOW)?.message).toBe("Your Pro Plan credits expire in 1 day (2026-10-21). Unused plan credits do not roll over.");
    expect(expirationNotice([sub(100, 3 * HOUR)], NOW)?.message).toBe("Your Pro Plan credits expire today (2026-10-20). Unused plan credits do not roll over.");
  });
  it("names the soonest lot, and the plan before the top-up on a tie", () => {
    expect(expirationNotice([sub(100, 5 * DAY), topup(40, 2 * DAY)], NOW)?.message).toBe("Your Pro Top-Up credits expire in 2 days (2026-10-22).");
    expect(expirationNotice([topup(40, 3 * DAY), sub(100, 3 * DAY)], NOW)?.kind).toBe("subscription");
  });
  it("falls back to a generic plan name", () => {
    expect(expirationNotice([sub(5, 2 * DAY, { planName: undefined })], NOW)?.message).toContain("Your Plan credits expire in 2 days");
  });
});

describe("buildAllocation", () => {
  it("is honest for an empty wallet", () => {
    const a = buildAllocation([], NOW);
    expect(a.subscription).toBeNull();
    expect(a.topup).toBeNull();
    expect(a.payg).toEqual({ remaining: 0, freeSignup: 0 });
  });
  it("says Resets in X days on DATE for a renewing plan", () => {
    const a = buildAllocation([sub(800, 21 * DAY)], NOW);
    expect(a.subscription).toEqual({ remaining: 800, planName: "Pro", countdown: "Resets in 21 days on 2026-11-10", rolloverNote: "Unused plan credits do not roll over." });
  });
  it("says Ends in X days on DATE for a cancelled plan", () => {
    const a = buildAllocation([sub(600, 12 * DAY, { autoRenew: false })], NOW);
    expect(a.subscription?.countdown).toBe("Ends in 12 days on 2026-11-01");
  });
  it("handles the singular and today forms of the plan line", () => {
    expect(buildAllocation([sub(1, DAY)], NOW).subscription?.countdown).toBe("Resets in 1 day on 2026-10-21");
    expect(buildAllocation([sub(1, HOUR, { autoRenew: false })], NOW).subscription?.countdown).toBe("Ends today on 2026-10-20");
  });
  it("has no countdown for a plan lot with no end date", () => {
    expect(buildAllocation([sub(50, null)], NOW).subscription?.countdown).toBeNull();
  });
  it("shows no top-up block without a top-up lot", () => {
    expect(buildAllocation([sub(800, 21 * DAY), pack(5)], NOW).topup).toBeNull();
  });
  it("links the top-up to a renewing Pro plan and uses the plan end date", () => {
    const a = buildAllocation([sub(800, 21 * DAY), topup(500, 40 * DAY)], NOW);
    expect(a.topup).toEqual({ remaining: 500, lapse: "Linked to active Pro Plan. Lapses in 21 days." });
  });
  it("adds the date to the top-up line when the plan is cancelled", () => {
    const a = buildAllocation([sub(600, 12 * DAY, { autoRenew: false }), topup(100, 12 * DAY)], NOW);
    expect(a.topup?.lapse).toBe("Linked to active Pro Plan. Lapses in 12 days on 2026-11-01.");
  });
  it("uses the top-up's own end date when there is no plan lot", () => {
    expect(buildAllocation([topup(100, 4 * DAY)], NOW).topup?.lapse).toBe("Linked to active Pro Plan. Lapses in 4 days.");
  });
  it("sums packs and sign-up credits, and counts the free ones", () => {
    const a = buildAllocation([pack(300), signup(30), pack(20)], NOW);
    expect(a.payg).toEqual({ remaining: 350, freeSignup: 30 });
  });
  it("leaves free credits at 0 when there are none", () => {
    expect(buildAllocation([pack(10)], NOW).payg.freeSignup).toBe(0);
  });
  it("leaves an expired plan lot out of the grid", () => {
    expect(buildAllocation([sub(800, -DAY)], NOW).subscription).toBeNull();
  });
});
