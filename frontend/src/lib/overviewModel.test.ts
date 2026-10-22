import { describe, expect, it } from "vitest";
import type { ScheduledPost, SocialAccount } from "./api";
import { buildOverviewModel, untilText } from "./overviewModel";

const now = new Date("2026-10-22T12:00:00Z");
const acc = (id: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount =>
  ({ id, platform: "bluesky", platform_account_id: id, display_name: id, connected_at: "2026-09-01", brand_label: brand, brand_id: null, ...extra }) as SocialAccount;
const post = (id: string, accountId: string | null, status: ScheduledPost["status"], when: string | null, extra: Partial<ScheduledPost> = {}): ScheduledPost =>
  ({ id, social_account_id: accountId, content: `text ${id}`, status, scheduled_for: when, paused_at: null, post_results: [], ...extra }) as ScheduledPost;

const accounts = [acc("a1", "Alpha"), acc("a2", "Beta", { needs_reconnect_at: "2026-10-20T00:00:00Z" })];
const posts = [
  post("p1", "a1", "pending", "2026-10-22T14:00:00Z"),
  post("p2", "a1", "pending", "2026-10-22T13:00:00Z"),
  post("p3", "a1", "pending", "2026-10-25T13:00:00Z"),
  post("p4", "a1", "pending", "2026-10-22T15:00:00Z", { paused_at: "2026-10-20T00:00:00Z" }),
  post("p5", "a1", "posted", "2026-10-22T08:00:00Z", { post_results: [{ verified_live: true, platform_post_url: "https://x.test/1", error_message: null }] }),
  post("p6", "a1", "posted", "2026-10-21T08:00:00Z"),
  post("p7", "a2", "failed", "2026-10-22T09:00:00Z"),
  post("p8", null, "draft", null),
];

describe("buildOverviewModel", () => {
  const m = buildOverviewModel(posts, accounts, "", now);
  it("lists upcoming posts soonest first and ignores paused ones", () => {
    expect(m.upcoming.map((r) => r.id)).toEqual(["p2", "p1", "p3"]);
    expect(m.next?.id).toBe("p2");
    expect(m.scheduled).toBe(3);
    expect(m.paused).toBe(1);
  });
  it("lists the latest published first, with the link and verified flag", () => {
    expect(m.latest.map((r) => r.id)).toEqual(["p5", "p6"]);
    expect(m.latest[0]).toMatchObject({ url: "https://x.test/1", verified: true });
  });
  it("counts today, failed, drafts and accounts that need reconnecting", () => {
    expect(m.postedToday).toBe(1);
    expect(m.dueToday).toBe(2);
    expect(m.failed).toBe(1);
    expect(m.drafts).toBe(1);
    expect(m.needsReconnect).toBe(1);
    expect(m.allClear).toBe(false);
  });
  it("narrows to one brand", () => {
    const b = buildOverviewModel(posts, accounts, "Beta", now);
    expect(b.failed).toBe(1);
    expect(b.scheduled).toBe(0);
    expect(b.next).toBeNull();
    expect(b.needsReconnect).toBe(1);
  });
  it("is all clear when nothing failed, paused or needs reconnecting", () => {
    const clean = buildOverviewModel([post("x", "a1", "pending", "2026-10-23T10:00:00Z")], [acc("a1", "Alpha")], "", now);
    expect(clean.allClear).toBe(true);
  });
});

describe("untilText", () => {
  it("says it in words", () => {
    expect(untilText("2026-10-22T12:00:20Z", now)).toBe("now");
    expect(untilText("2026-10-22T12:25:00Z", now)).toBe("in 25 min");
    expect(untilText("2026-10-22T14:05:00Z", now)).toBe("in 2 h 5 min");
    expect(untilText("2026-10-22T16:00:00Z", now)).toBe("in 4 h");
    expect(untilText("2026-10-25T12:00:00Z", now)).toBe("in 3 days");
    expect(untilText(null, now)).toBe("");
  });
});
