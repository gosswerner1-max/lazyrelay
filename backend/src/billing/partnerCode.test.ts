// resolveApprovedPartnerCode: turns whatever the browser sent into the partner's real code, or null. Never throws for a bad code.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});

const { tables } = await import("../testFakeSupabase.js");
const { resolveApprovedPartnerCode } = await import("./partnerCode.js");

beforeEach(() => {
  tables.referral_partners = [
    { id: "p1", code: "Sarah", status: "approved" },
    { id: "p2", code: "paused-one", status: "paused" },
  ];
});

describe("resolveApprovedPartnerCode", () => {
  it("finds an approved partner whatever the letter case and returns the stored spelling", async () => {
    expect(await resolveApprovedPartnerCode("sarah")).toBe("Sarah");
    expect(await resolveApprovedPartnerCode("  SARAH ")).toBe("Sarah");
  });

  it("an unknown code, a paused partner, or an empty value is null", async () => {
    expect(await resolveApprovedPartnerCode("nobody")).toBeNull();
    expect(await resolveApprovedPartnerCode("paused-one")).toBeNull();
    expect(await resolveApprovedPartnerCode("")).toBeNull();
  });

  it("anything that is not a plain code is null without asking the database", async () => {
    for (const bad of [undefined, null, 7, {}, ["sarah"], "sa%", "sa_ah", "a".repeat(41), "x y", "x;drop"]) {
      expect(await resolveApprovedPartnerCode(bad)).toBeNull();
    }
  });
});

describe("resolveApprovedPartnerCode: a partner cannot earn on their own purchase", () => {
  beforeEach(() => {
    tables.referral_partners = [{ id: "p1", code: "Sarah", status: "approved", email: "Sarah@Example.org" }];
    tables.accounts = [
      { id: "acc-self", email: "sarah@example.org" },
      { id: "acc-other", email: "buyer@example.org" },
    ];
  });

  it("the partner's own account (matched by the registered email, any letter case) gets null", async () => {
    expect(await resolveApprovedPartnerCode("sarah", "acc-self")).toBeNull();
  });

  it("any other account gets the code", async () => {
    expect(await resolveApprovedPartnerCode("sarah", "acc-other")).toBe("Sarah");
  });

  it("with no account given (no self check possible) the code resolves as before", async () => {
    expect(await resolveApprovedPartnerCode("sarah")).toBe("Sarah");
  });
});
