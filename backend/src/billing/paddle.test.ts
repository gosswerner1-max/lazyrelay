import { describe, it, expect } from "vitest";
import { deriveCancelAtPeriodEnd } from "./paddle.js";

// Regression test for the webhook race: cancelSubscription() cancels with
// effectiveFrom "next_billing_period", which makes Paddle fire a
// subscription.updated for the SCHEDULING of that cancellation (status
// still "active"/"trialing", scheduledChange.action === "cancel") before
// the eventual terminal subscription.canceled at period end. The old code
// hardcoded cancel_at_period_end to false on every tier/add-on-event
// upsert in sync.ts, so if that update webhook landed, it silently
// un-cancelled the subscription in our DB while the customer stayed
// billed. deriveCancelAtPeriodEnd is the fix: read the flag straight from
// Paddle's own scheduledChange field instead. Mirrors TimeAJob's identical
// fix for the identical bug (that repo's paddle.test.ts, commit c077ce4).
describe("deriveCancelAtPeriodEnd", () => {
  it("is true when Paddle has a scheduled cancellation (the exact race payload)", () => {
    expect(deriveCancelAtPeriodEnd({ scheduledChange: { action: "cancel" } })).toBe(true);
  });

  it("is false when nothing is scheduled (fresh subscription, or a genuine resubscribe)", () => {
    expect(deriveCancelAtPeriodEnd({ scheduledChange: null })).toBe(false);
  });

  it("is false for a scheduled pause/resume, not just any scheduledChange", () => {
    expect(deriveCancelAtPeriodEnd({ scheduledChange: { action: "pause" } })).toBe(false);
    expect(deriveCancelAtPeriodEnd({ scheduledChange: { action: "resume" } })).toBe(false);
  });
});
