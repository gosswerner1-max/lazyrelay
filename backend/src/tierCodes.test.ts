import { describe, it, expect, vi, beforeEach } from "vitest";

// Migration 0119 renamed the internal tier codes to match the public plan
// names. This file pins the whole limits table for the six new codes to the
// values the corresponding OLD codes had (the customer-facing limits must not
// move), and drives every limit hook through the real resolveTier() so a code
// that falls out of any Record<Tier, ...> table is caught here.
//
//   old code     -> new code   (public name)
//   free         -> free       Free
//   pro          -> starter    Starter
//   business     -> pro        Pro
//   enterprise   -> business   Business
//   agency       -> agency     Agency
//   agency_plus  -> agency_plus Agency Plus

const db = vi.hoisted(() => ({
  tier: "free" as string,
  status: "active" as string,
  counts: {} as Record<string, number>,
  aiUsed: 0,
}));

vi.mock("./supabase.js", () => {
  function from(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => b,
      is: () => b,
      neq: () => b,
      gte: () => b,
      maybeSingle: async () => {
        if (table === "subscriptions") return { data: { tier: db.tier, status: db.status }, error: null };
        if (table === "ai_generation_usage") return { data: { generation_count: db.aiUsed }, error: null };
        return { data: null, error: null };
      },
      // Awaiting the builder directly = a count query or a list query.
      then: (resolve: (v: unknown) => void) => resolve({ data: [], count: db.counts[table] ?? 0, error: null }),
    };
    return b;
  }
  return { supabase: { from } };
});

import { resolveTier, TIER_DISPLAY_NAMES, RECURRING_SCHEDULE_SLOT_LIMITS, RSS_FEED_LIMITS, REVIEW_LINK_LIMITS, type Tier } from "./tier.js";
import { ACCOUNT_LIMITS, checkAccountLimit, checkNewDistinctAccountLimit } from "./accountLimits.js";
import { BRAND_LIMITS, checkBrandLimit, getBrandCapacity } from "./brandLimits.js";
import { SEAT_LIMITS, checkSeatLimit, getSeatCapacity } from "./seatLimits.js";
import { STORAGE_QUOTA_BYTES, getStorageUsage } from "./storageQuota.js";
import { AI_GENERATION_DAILY_LIMIT, checkGenerationLimit } from "./aiUsage.js";
import { TIER_LIMITS } from "./http/rateLimit.js";
import { shouldShowBrandingTag } from "./scheduler.js";
import { PAID_TIERS } from "./billing/tierResolution.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const NEW_CODES: Tier[] = ["free", "starter", "pro", "business", "agency", "agency_plus"];

// Order: free, starter, pro, business, agency, agency_plus. Values are the
// pre-rename values of the old codes free, pro, business, enterprise, agency,
// agency_plus respectively.
const EXPECTED = {
  accounts: [3, 20, 30, 50, 100, 150],
  brands: [1, 2, 4, 7, 12, 20],
  seats: [0, 0, 0, 2, 3, 6],
  storage: [250 * MB, 5 * GB, 10 * GB, 20 * GB, 20 * GB, 20 * GB],
  aiPerDay: [5, 20, 50, 100, 100, 100],
  requestsPerMinute: [60, 300, 450, 600, 600, 600],
  recurring: [0, 3, 5, null, null, null],
  rssFeeds: [0, 1, 3, 5, 5, 5],
  reviewLinks: [0, 4, 8, 14, 24, 40],
} as const;

const TABLES: Record<keyof typeof EXPECTED, Record<string, unknown>> = {
  accounts: ACCOUNT_LIMITS,
  brands: BRAND_LIMITS,
  seats: SEAT_LIMITS,
  storage: STORAGE_QUOTA_BYTES,
  aiPerDay: AI_GENERATION_DAILY_LIMIT,
  requestsPerMinute: TIER_LIMITS,
  recurring: RECURRING_SCHEDULE_SLOT_LIMITS,
  rssFeeds: RSS_FEED_LIMITS,
  reviewLinks: REVIEW_LINK_LIMITS,
};

beforeEach(() => {
  db.tier = "free";
  db.status = "active";
  db.counts = {};
  db.aiUsed = 0;
});

describe("limits tables for the renamed tier codes", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name}: exactly the six new codes, with the old per-plan values`, () => {
      const table = TABLES[name as keyof typeof EXPECTED];
      expect(Object.keys(table).sort()).toEqual([...NEW_CODES].sort());
      expect(NEW_CODES.map((code) => table[code])).toEqual([...expected]);
    });
  }

  it("display names are the public plan names", () => {
    expect(TIER_DISPLAY_NAMES).toEqual({ free: "Free", starter: "Starter", pro: "Pro", business: "Business", agency: "Agency", agency_plus: "Agency Plus" });
  });

  it("no old-only code survives as a key anywhere", () => {
    for (const table of Object.values(TABLES)) expect(table).not.toHaveProperty("enterprise");
  });

  it("paid tiers are exactly the five non-free codes", () => {
    expect([...PAID_TIERS]).toEqual(NEW_CODES.filter((c) => c !== "free"));
  });
});

describe("resolveTier (good-standing logic) with the new codes", () => {
  for (const code of NEW_CODES.filter((c) => c !== "free")) {
    it(`${code}: active and trialing keep the tier, anything else is Free`, async () => {
      db.tier = code;
      for (const status of ["active", "trialing"]) {
        db.status = status;
        expect(await resolveTier("acct")).toBe(code);
      }
      for (const status of ["past_due", "cancelled"]) {
        db.status = status;
        expect(await resolveTier("acct")).toBe("free");
      }
    });
  }

  it("a stored free row is Free even when active", async () => {
    db.tier = "free";
    expect(await resolveTier("acct")).toBe("free");
  });
});

describe("every limit hook enforces the new codes at the old numbers", () => {
  NEW_CODES.forEach((code, i) => {
    describe(code, () => {
      beforeEach(() => {
        db.tier = code;
      });

      it("connected accounts: room below the cap, blocked at it", async () => {
        const cap = EXPECTED.accounts[i];
        db.counts.social_accounts = cap - 1;
        expect(await checkAccountLimit("acct")).toBeNull();
        expect(await checkNewDistinctAccountLimit("acct")).toBeNull();
        db.counts.social_accounts = cap;
        expect(await checkAccountLimit("acct")).toContain(`limit of ${cap} connected accounts`);
        expect(await checkNewDistinctAccountLimit("acct")).toContain(`${cap} different accounts`);
      });

      it("brands (base + add-on slots)", async () => {
        const cap = EXPECTED.brands[i];
        db.counts.brands = cap - 1;
        expect(await checkBrandLimit("acct")).toBeNull();
        db.counts.brands = cap;
        expect(await checkBrandLimit("acct")).toContain(`limit of ${cap} brand`);
        db.counts.brand_addons = 2;
        expect(await getBrandCapacity("acct")).toMatchObject({ tier: code, baseLimit: cap, addonSlots: 2, totalLimit: cap + 2 });
      });

      it("team seats (base + add-on slots)", async () => {
        const cap = EXPECTED.seats[i];
        if (cap === 0) {
          expect(await checkSeatLimit("acct")).toContain("aren't available on your plan");
        } else {
          db.counts.account_members = cap - 1;
          expect(await checkSeatLimit("acct")).toBeNull();
          db.counts.account_members = cap;
          expect(await checkSeatLimit("acct")).toContain(`limit of ${cap} team`);
        }
        db.counts.seat_addons = 1;
        expect(await getSeatCapacity("acct")).toMatchObject({ tier: code, baseLimit: cap, addonSlots: 1, totalLimit: cap + 1 });
      });

      it("storage quota", async () => {
        const usage = await getStorageUsage("acct");
        expect(usage.tier).toBe(code);
        expect(usage.quotaBytes).toBe(EXPECTED.storage[i]);
      });

      it("AI generations per day", async () => {
        const cap = EXPECTED.aiPerDay[i];
        db.aiUsed = cap - 1;
        expect(await checkGenerationLimit("acct")).toBeNull();
        db.aiUsed = cap;
        expect(await checkGenerationLimit("acct")).toContain(`all ${cap} AI generations`);
      });

      it("branding tag shows on Free only", () => {
        expect(shouldShowBrandingTag(code, true)).toBe(code === "free");
      });
    });
  });
});
