// GET /mentions: the platform filter runs inside the query and the limit of 15 is
// applied after it. Pure unit tests against an in-memory fake (testMentionsFakeDb.ts).

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parsePlatformsParam,
  fetchMentionPosts,
  fetchOtherPlatformCounts,
  MENTIONS_POST_LIMIT,
  OTHER_PLATFORMS_SCAN_LIMIT,
} from "./mentionsQuery.js";
import { makeMentionsFakeDb, crowdedAccount, type FakePost } from "./testMentionsFakeDb.js";

const LIVE = ["devto", "hashnode", "mastodon", "bluesky", "youtube"];
const platformsOf = (rows: { social_accounts: unknown }[] | null) =>
  (rows ?? []).map((r) => (r.social_accounts as { platform: string }).platform);

afterEach(() => vi.restoreAllMocks());

describe("parsePlatformsParam", () => {
  it("no parameter, an empty one: no filter", () => {
    expect(parsePlatformsParam(undefined)).toEqual({ ok: true, platforms: null });
    expect(parsePlatformsParam("")).toEqual({ ok: true, platforms: null });
  });

  it("a comma list becomes a clean list: trimmed, lower case, no duplicates, order kept", () => {
    expect(parsePlatformsParam("devto, Hashnode ,devto,mastodon")).toEqual({ ok: true, platforms: ["devto", "hashnode", "mastodon"] });
  });

  it("a repeated parameter works the same way", () => {
    expect(parsePlatformsParam(["devto", "bluesky,youtube"])).toEqual({ ok: true, platforms: ["devto", "bluesky", "youtube"] });
  });

  it.each([
    ["a space inside a name", "dev to"],
    ["a filter-breaking character", "devto),social_accounts.platform.eq.(x"],
    ["a semicolon", "a;b"],
    ["an empty item", "devto,,bluesky"],
    ["only a comma", ","],
    ["a name that is too long", "x".repeat(31)],
    ["a dash", "dev-to"],
    ["a number instead of text", 5],
    ["an object", { a: 1 }],
  ])("refuses %s", (_label, value) => {
    expect(parsePlatformsParam(value)).toEqual({ ok: false });
  });

  it("refuses more than 30 platforms", () => {
    const many = Array.from({ length: 31 }, (_, i) => `p${i}`).join(",");
    expect(parsePlatformsParam(many)).toEqual({ ok: false });
    expect(parsePlatformsParam(many.split(",").slice(0, 30).join(",")).ok).toBe(true);
  });
});

describe("fetchMentionPosts without a platform list (public API, MCP, SDK, Zapier)", () => {
  it("is exactly the old query: newest 15 of every platform, no inner join, no platform filter", async () => {
    const { db, calls } = makeMentionsFakeDb(crowdedAccount());
    const { data, error } = await fetchMentionPosts(db, "acc1", null);
    expect(error).toBeNull();
    expect(data).toHaveLength(MENTIONS_POST_LIMIT);
    expect(platformsOf(data).every((p) => p === "facebook")).toBe(true); // the starvation, kept for callers that send no list
    const select = calls.find((c) => c.op === "select")!.args[0] as string;
    expect(select).toContain("social_accounts(platform)");
    expect(select).not.toContain("!inner");
    expect(calls.some((c) => c.op === "in")).toBe(false);
  });
});

describe("fetchMentionPosts with a platform list (the dashboard)", () => {
  it("finds the dev.to and Hashnode posts even when 20 newer Facebook posts exist", async () => {
    const { db } = makeMentionsFakeDb(crowdedAccount());
    const { data } = await fetchMentionPosts(db, "acc1", LIVE);
    expect((data ?? []).map((r) => r.id)).toEqual(["dev1", "dev2", "hn1"]); // newest first, nothing starved
    expect(platformsOf(data)).toEqual(["devto", "devto", "hashnode"]);
  });

  it("takes the 15 newest AFTER filtering, not before", async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n)).toISOString();
    const posts: FakePost[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `dev${i}`, account_id: "acc1", status: "posted", scheduled_for: day(i), platform: "devto", verified: true })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `ig${i}`, account_id: "acc1", status: "posted", scheduled_for: day(100 + i), platform: "instagram", verified: true })),
    ];
    const { db } = makeMentionsFakeDb(posts);
    const { data } = await fetchMentionPosts(db, "acc1", LIVE);
    expect(data).toHaveLength(15);
    expect((data ?? []).map((r) => r.id)).toEqual(Array.from({ length: 15 }, (_, i) => `dev${19 - i}`)); // dev19 .. dev5
    expect(platformsOf(data).every((p) => p === "devto")).toBe(true);
  });

  it("builds the query the database needs: inner join, the exact list, the limit of 15, own account, posted only", async () => {
    const { db, calls } = makeMentionsFakeDb(crowdedAccount());
    await fetchMentionPosts(db, "acc1", ["devto", "hashnode"]);
    const select = calls.find((c) => c.op === "select")!.args[0] as string;
    expect(select).toContain("social_accounts!inner(platform)");
    expect(calls).toContainEqual({ op: "in", args: ["social_accounts.platform", ["devto", "hashnode"]] });
    expect(calls).toContainEqual({ op: "limit", args: [15] });
    expect(calls).toContainEqual({ op: "eq", args: ["account_id", "acc1"] });
    expect(calls).toContainEqual({ op: "eq", args: ["status", "posted"] });
    expect(calls).toContainEqual({ op: "order", args: ["scheduled_for", { ascending: false }] });
    expect(calls.filter((c) => c.op === "from")).toEqual([{ op: "from", args: ["scheduled_posts"] }]);
  });

  it("never returns another account's posts or posts that are not posted", async () => {
    const posts = crowdedAccount();
    posts.push({ id: "other", account_id: "acc2", status: "posted", scheduled_for: new Date(Date.UTC(2027, 0, 1)).toISOString(), platform: "devto", verified: true });
    posts.push({ id: "pending", account_id: "acc1", status: "pending", scheduled_for: new Date(Date.UTC(2027, 0, 2)).toISOString(), platform: "devto", verified: true });
    const { db } = makeMentionsFakeDb(posts);
    const { data } = await fetchMentionPosts(db, "acc1", LIVE);
    expect((data ?? []).map((r) => r.id)).not.toContain("other");
    expect((data ?? []).map((r) => r.id)).not.toContain("pending");
  });

  it("a list with no matching posts gives an empty list, not an error", async () => {
    const { db } = makeMentionsFakeDb(crowdedAccount());
    const { data, error } = await fetchMentionPosts(db, "acc1", ["youtube"]);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("passes a database error through", async () => {
    const { db } = makeMentionsFakeDb(crowdedAccount(), { failWith: "boom" });
    const { data, error } = await fetchMentionPosts(db, "acc1", LIVE);
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: "boom" });
  });

  it("the fake really would catch a missing inner join (guards the test itself)", async () => {
    // Same filter, plain embed: PostgREST keeps the posts and blanks the platform.
    const { db } = makeMentionsFakeDb(crowdedAccount());
    const rows = (await (db as never as { from: (t: string) => any }).from("scheduled_posts")
      .select("id, social_accounts(platform)")
      .in("social_accounts.platform", LIVE)
      .eq("account_id", "acc1")
      .eq("status", "posted")
      .order("scheduled_for", { ascending: false })
      .limit(15)).data as { social_accounts: unknown }[];
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.social_accounts === null)).toBe(true);
  });
});

describe("fetchOtherPlatformCounts (the 'Coming soon' rows)", () => {
  it("counts the live posts of the platforms that were left out, most first", async () => {
    const posts = crowdedAccount();
    posts.push({ id: "ig1", account_id: "acc1", status: "posted", scheduled_for: new Date(Date.UTC(2026, 9, 5)).toISOString(), platform: "instagram", verified: true });
    posts.push({ id: "ig2", account_id: "acc1", status: "posted", scheduled_for: new Date(Date.UTC(2026, 9, 6)).toISOString(), platform: "instagram", verified: true });
    const { db } = makeMentionsFakeDb(posts);
    expect(await fetchOtherPlatformCounts(db, "acc1", LIVE)).toEqual([
      { platform: "facebook", count: 20 },
      { platform: "instagram", count: 2 },
    ]);
  });

  it("ignores posts that were never confirmed live, posts of live platforms and other accounts", async () => {
    const posts: FakePost[] = [
      { id: "a", account_id: "acc1", status: "posted", scheduled_for: "2026-10-01T00:00:00Z", platform: "facebook", verified: false },
      { id: "b", account_id: "acc1", status: "posted", scheduled_for: "2026-10-02T00:00:00Z", platform: "devto", verified: true },
      { id: "c", account_id: "acc2", status: "posted", scheduled_for: "2026-10-03T00:00:00Z", platform: "facebook", verified: true },
    ];
    const { db } = makeMentionsFakeDb(posts);
    expect(await fetchOtherPlatformCounts(db, "acc1", LIVE)).toEqual([]);
  });

  it("builds the query the database needs and scans at most 200 posts", async () => {
    const { db, calls } = makeMentionsFakeDb(crowdedAccount());
    await fetchOtherPlatformCounts(db, "acc1", ["devto", "hashnode"]);
    const select = calls.find((c) => c.op === "select")!.args[0] as string;
    expect(select).toContain("social_accounts!inner(platform)");
    expect(select).toContain("post_results!inner(verified_live)");
    expect(calls).toContainEqual({ op: "not", args: ["social_accounts.platform", "in", "(devto,hashnode)"] });
    expect(calls).toContainEqual({ op: "eq", args: ["post_results.verified_live", true] });
    expect(calls).toContainEqual({ op: "limit", args: [OTHER_PLATFORMS_SCAN_LIMIT] });
  });

  it("a database error gives an empty list and never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeMentionsFakeDb(crowdedAccount(), { failWith: "boom" });
    expect(await fetchOtherPlatformCounts(db, "acc1", LIVE)).toEqual([]);
  });

  it("an exception gives an empty list and never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { from: () => { throw new Error("connection lost"); } } as never;
    expect(await fetchOtherPlatformCounts(broken, "acc1", LIVE)).toEqual([]);
  });
});
