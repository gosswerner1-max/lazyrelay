// resolveTier must tell "no paid subscription" (free) apart from "the database
// could not answer" (throws). A paying customer must never come out as free
// because a lookup failed.

import { describe, it, expect, vi } from "vitest";

let next: { data: unknown; error: unknown; status?: number } = { data: null, error: null };
vi.mock("./supabase.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => next }) }),
    }),
  },
}));

const { resolveTier } = await import("./tier.js");
const { UpstreamUnavailableError } = await import("./db/upstream.js");

describe("resolveTier", () => {
  it("returns the paid tier for an active subscription", async () => {
    next = { data: { tier: "pro", status: "active" }, error: null };
    expect(await resolveTier("a1")).toBe("pro");
  });

  it("returns the paid tier while trialing", async () => {
    next = { data: { tier: "business", status: "trialing" }, error: null };
    expect(await resolveTier("a1")).toBe("business");
  });

  it("returns free when there is genuinely no subscription row", async () => {
    next = { data: null, error: null };
    expect(await resolveTier("a1")).toBe("free");
  });

  it("returns free for a cancelled or past-due subscription (the database answered)", async () => {
    next = { data: { tier: "pro", status: "cancelled" }, error: null };
    expect(await resolveTier("a1")).toBe("free");
    next = { data: { tier: "pro", status: "past_due" }, error: null };
    expect(await resolveTier("a1")).toBe("free");
  });

  it("THROWS on a 522 instead of returning free", async () => {
    next = { data: null, error: { message: "<html>522</html>" }, status: 522 };
    await expect(resolveTier("a1")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await expect(resolveTier("a1")).rejects.toThrow("Database unavailable - Retry pending");
  });

  it("THROWS on a network failure (status 0) instead of returning free", async () => {
    next = { data: null, error: { message: "TypeError: fetch failed" }, status: 0 };
    await expect(resolveTier("a1")).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it("THROWS on any other database error too: an unknown answer is never free", async () => {
    next = { data: null, error: { message: "permission denied for table subscriptions", code: "42501" }, status: 403 };
    await expect(resolveTier("a1")).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });
});
