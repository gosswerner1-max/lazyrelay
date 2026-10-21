import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({}));
import type { Brand, ScheduledPost, SocialAccount } from "./api";
import { BRAND_PALETTE, brandCards, brandCountLabel, publishedPerDay } from "./brandsModel";
import { queueStats } from "./postingChannels";

const acct = (id: string, platform: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null, ...extra,
});
const brand = (name: string): Brand => ({ id: "b-" + name, name, voice_profile: null, created_at: "2026-09-01T00:00:00Z" });
const posted = (id: string, accountId: string, when: string): ScheduledPost =>
  ({ id, status: "posted", social_account_id: accountId, scheduled_for: when, paused_at: null, content: "x" }) as unknown as ScheduledPost;
const NOW = new Date("2026-10-21T12:00:00Z");

describe("brandCards", () => {
  const accounts = [acct("a1", "tiktok", "Alpha"), acct("a2", "tiktok", "Alpha"), acct("a3", "facebook", "Alpha"), acct("a4", "x", "Alpha", { needs_reconnect_at: "2026-10-01T00:00:00Z" }), acct("b1", "x", "Beta")];
  it("counts accounts and connected channels per brand, keeping the brand order given", () => {
    const cards = brandCards([brand("Alpha"), brand("Beta"), brand("Gamma")], accounts);
    expect(cards.map((c) => c.brand.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(cards[0]).toMatchObject({ accountCount: 4, channelCount: 2 });
    expect(cards[1]).toMatchObject({ accountCount: 1, channelCount: 1 });
    expect(cards[2]).toMatchObject({ accountCount: 0, channelCount: 0 });
  });
  it("gives each brand a colour from the palette, wrapping around, and never purple or violet", () => {
    const many = Array.from({ length: 9 }, (_, i) => brand("B" + i));
    const cards = brandCards(many, []);
    expect(cards[0].color).toBe(BRAND_PALETTE[0]);
    expect(cards[BRAND_PALETTE.length].color).toBe(BRAND_PALETTE[0]);
    expect(BRAND_PALETTE).toHaveLength(6);
    for (const c of BRAND_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("brandCountLabel", () => {
  it("shows n of cap, or nothing when the plan limit is unknown", () => {
    expect(brandCountLabel(2, { totalLimit: 5 })).toBe("2 of 5 brands");
    expect(brandCountLabel(1, { totalLimit: 1 })).toBe("1 of 1 brand");
    expect(brandCountLabel(2, null)).toBeNull();
    expect(brandCountLabel(2, undefined)).toBeNull();
  });
});

describe("publishedPerDay", () => {
  const accounts = [acct("a1", "tiktok", "Alpha"), acct("b1", "tiktok", "Beta")];
  it("returns 30 daily buckets ending today, oldest first", () => {
    const days = publishedPerDay([], accounts, "Alpha", NOW);
    expect(days).toHaveLength(30);
    expect(days[29].date).toBe("2026-10-21");
    expect(days[0].date).toBe("2026-09-22");
    expect(days.every((d) => d.count === 0)).toBe(true);
  });
  it("counts only published posts of that brand's accounts inside the window", () => {
    const posts = [
      posted("p1", "a1", "2026-10-21T08:00:00Z"),
      posted("p2", "a1", "2026-10-21T01:00:00Z"),
      posted("p3", "a1", "2026-10-20T09:00:00Z"),
      posted("p4", "b1", "2026-10-21T08:00:00Z"),
      posted("p5", "a1", "2026-07-01T08:00:00Z"),
      { ...posted("p6", "a1", "2026-10-21T09:00:00Z"), status: "pending" } as ScheduledPost,
    ];
    const days = publishedPerDay(posts, accounts, "Alpha", NOW);
    expect(days[29].count).toBe(2);
    expect(days[28].count).toBe(1);
    expect(days.reduce((s, d) => s + d.count, 0)).toBe(3);
  });
  it("adds up to the same published-in-30-days number as the queue stats", () => {
    const posts = [posted("p1", "a1", "2026-10-21T08:00:00Z"), posted("p2", "a1", "2026-09-22T12:00:00Z"), posted("p3", "a1", "2026-09-22T11:59:00Z"), posted("p4", "a1", "2026-10-21T13:00:00Z")];
    const total = publishedPerDay(posts, accounts, "Alpha", NOW).reduce((s, d) => s + d.count, 0);
    expect(total).toBe(queueStats(posts, accounts, "Alpha", NOW).published30d);
  });
});
