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
