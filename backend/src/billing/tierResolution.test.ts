import { describe, it, expect, vi, afterEach } from "vitest";
import { buildEventFromCustomData } from "./paddle.js";
import { resolveWebhookTier, tierForPriceId, priceIdForTier, TIER_PRICE_ID_ENV_VARS, PAID_TIERS } from "./tierResolution.js";

// Migration 0119 renamed the stored tier codes (pro -> starter, business ->
// pro, enterprise -> business). Paddle echoes the customData we embedded at
// checkout for the whole life of a subscription, so subscriptions created
// before the rename keep sending the OLD codes, and old "pro"/"business"
// collide with the new codes of the same name. The price id is the authority.
const ENV = {
  PADDLE_PRICE_ID_STARTER: "pri_starter",
  PADDLE_PRICE_ID_PRO: "pri_pro",
  PADDLE_PRICE_ID_BUSINESS: "pri_business",
  PADDLE_PRICE_ID_AGENCY: "pri_agency",
  PADDLE_PRICE_ID_AGENCY_PLUS: "pri_agency_plus",
};

function sub(customData: Record<string, unknown>, priceIds: string[]) {
  return {
    id: "sub_1",
    status: "active",
    customData: { accountEmail: "a@example.com", accountId: "acct_1", kind: "tier", ...customData },
    currentBillingPeriod: { endsAt: "2026-11-10T00:00:00.000Z" },
    scheduledChange: null,
    items: priceIds.map((id) => ({ price: { id } })),
  };
}
const tierOf = (event: unknown) => (event as { tier?: string }).tier;

afterEach(() => vi.restoreAllMocks());

describe("price id <-> tier mapping", () => {
  it("maps every paid tier to its env var and back, and the env var names did not change", () => {
    expect(TIER_PRICE_ID_ENV_VARS).toEqual({
      starter: "PADDLE_PRICE_ID_STARTER",
      pro: "PADDLE_PRICE_ID_PRO",
      business: "PADDLE_PRICE_ID_BUSINESS",
      agency: "PADDLE_PRICE_ID_AGENCY",
      agency_plus: "PADDLE_PRICE_ID_AGENCY_PLUS",
    });
    for (const tier of PAID_TIERS) {
      const id = priceIdForTier(tier, ENV)!;
      expect(tierForPriceId(id, ENV)).toBe(tier);
    }
  });

  it("returns null for an unknown price id, an empty one, and an unset env var", () => {
    expect(tierForPriceId("pri_unknown", ENV)).toBeNull();
    expect(tierForPriceId("", ENV)).toBeNull();
    expect(tierForPriceId("pri_starter", {})).toBeNull();
  });
});

describe("resolveWebhookTier", () => {
  it("late webhook: legacy custom_data pro + Starter price id -> starter", () => {
    expect(resolveWebhookTier("pro", ["pri_starter"], ENV)).toEqual({ tier: "starter", source: "price_id" });
  });

  it("late webhook: legacy custom_data business + Pro price id -> pro", () => {
    expect(resolveWebhookTier("business", ["pri_pro"], ENV)).toEqual({ tier: "pro", source: "price_id" });
  });

  it("legacy enterprise + Business price id -> business", () => {
    expect(resolveWebhookTier("enterprise", ["pri_business"], ENV)).toEqual({ tier: "business", source: "price_id" });
  });

  it("legacy enterprise with no resolvable price id -> business (unambiguous)", () => {
    expect(resolveWebhookTier("enterprise", [], ENV)).toEqual({ tier: "business", source: "custom_data" });
  });

  it("the price id wins over a contradicting custom_data tier", () => {
    expect(resolveWebhookTier("business", ["pri_starter"], ENV)).toEqual({ tier: "starter", source: "price_id" });
  });

  it("new-style codes pass through when there is no price id match", () => {
    for (const tier of ["starter", "agency", "agency_plus", "free"]) {
      expect(resolveWebhookTier(tier, [], ENV)).toEqual({ tier, source: "custom_data" });
    }
  });

  it("new-style codes agree with their own price ids", () => {
    expect(resolveWebhookTier("pro", ["pri_pro"], ENV)).toEqual({ tier: "pro", source: "price_id" });
    expect(resolveWebhookTier("business", ["pri_business"], ENV)).toEqual({ tier: "business", source: "price_id" });
  });

  it("ambiguous pro/business with an unresolvable price id fails closed (tier null)", () => {
    for (const legacy of ["pro", "business"]) {
      const result = resolveWebhookTier(legacy, ["pri_retired_old_price"], ENV);
      expect(result.tier).toBeNull();
      expect(result).toHaveProperty("reason");
    }
    expect(resolveWebhookTier("pro", [], ENV).tier).toBeNull();
    // env var missing entirely: the same payload that resolved above is now unresolvable
    expect(resolveWebhookTier("pro", ["pri_starter"], {}).tier).toBeNull();
  });

  it("items that map to two different tiers are treated as unresolved", () => {
    expect(resolveWebhookTier("pro", ["pri_starter", "pri_pro"], ENV).tier).toBeNull();
  });

  it("a malformed tier with no price id match still throws, like before the rename", () => {
    expect(() => resolveWebhookTier(undefined, [], ENV)).toThrow(/invalid\/missing/);
    expect(() => resolveWebhookTier("platinum", [], ENV)).toThrow(/invalid\/missing/);
  });
});

describe("buildEventFromCustomData (what the webhook hands to the sync)", () => {
  it("legacy pro + Starter price id -> starter", () => {
    expect(tierOf(buildEventFromCustomData(sub({ tier: "pro" }, ["pri_starter"]), "active", "2026-10-10T00:00:00Z", ENV))).toBe("starter");
  });

  it("legacy business + Pro price id -> pro", () => {
    expect(tierOf(buildEventFromCustomData(sub({ tier: "business" }, ["pri_pro"]), "active", "2026-10-10T00:00:00Z", ENV))).toBe("pro");
  });

  it("legacy enterprise -> business", () => {
    expect(tierOf(buildEventFromCustomData(sub({ tier: "enterprise" }, ["pri_business"]), "active", "2026-10-10T00:00:00Z", ENV))).toBe("business");
    expect(tierOf(buildEventFromCustomData(sub({ tier: "enterprise" }, []), "active", "2026-10-10T00:00:00Z", ENV))).toBe("business");
  });

  it("new-style codes pass through", () => {
    expect(tierOf(buildEventFromCustomData(sub({ tier: "starter" }, []), "active", "2026-10-10T00:00:00Z", ENV))).toBe("starter");
    expect(tierOf(buildEventFromCustomData(sub({ tier: "agency_plus" }, ["pri_agency_plus"]), "active", "2026-10-10T00:00:00Z", ENV))).toBe("agency_plus");
  });

  it("unresolvable: tier is left undefined (stored tier unchanged), a clear warning is logged, and the rest of the event is intact", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = buildEventFromCustomData(sub({ tier: "pro" }, ["pri_retired_old_price"]), "past_due", "2026-10-10T00:00:00Z", ENV) as unknown as Record<string, unknown>;
    expect(event.kind).toBe("tier");
    expect(event.tier).toBeUndefined();
    expect(event.status).toBe("past_due");
    expect(event.morSubscriptionId).toBe("sub_1");
    expect(event.accountId).toBe("acct_1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/WARNING.*sub_1.*ambiguous.*unchanged/s);
  });

  it("stays quiet for a legacy spelling of the same tier, warns when custom_data genuinely disagrees with the price id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildEventFromCustomData(sub({ tier: "pro" }, ["pri_starter"]), "active", "2026-10-10T00:00:00Z", ENV);
    buildEventFromCustomData(sub({ tier: "enterprise" }, ["pri_business"]), "active", "2026-10-10T00:00:00Z", ENV);
    expect(warn).not.toHaveBeenCalled();
    buildEventFromCustomData(sub({ tier: "agency" }, ["pri_starter"]), "active", "2026-10-10T00:00:00Z", ENV);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("add-on subscriptions are untouched by tier resolution", () => {
    const event = buildEventFromCustomData(sub({ kind: "brand_addon" }, ["pri_brand_addon"]), "active", "2026-10-10T00:00:00Z", ENV);
    expect(event.kind).toBe("brand_addon");
  });
});
