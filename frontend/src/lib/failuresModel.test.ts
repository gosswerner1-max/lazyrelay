// Numbers and groups behind the Failures workspace. Pure functions, no network. Fixtures are made up.
import { describe, it, expect, vi } from "vitest";

vi.mock("./api", () => ({}));
import { brandLabels, buildFailuresModel, normaliseErrorKey, splitCorrectiveStep } from "./failuresModel";
import type { ScheduledPost, SocialAccount } from "./api";

const acct = (id: string, platform: string, brand: string | null): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null,
});
type R = { error_message: string | null; raw_error_message?: string | null };
const post = (id: string, status: ScheduledPost["status"], accountId: string | null, results: R[], when: string | null = "2026-10-20T10:00:00Z"): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: when, content: "x", post_results: results.map((r) => ({ verified_live: false, platform_post_url: null, ...r })) }) as unknown as ScheduledPost;

const ACCOUNTS = [acct("a1", "tiktok", "Alpha"), acct("a2", "pinterest", "Alpha"), acct("a3", "facebook", "Beta"), acct("a4", "x", null)];
const TOKEN = "Token expired for the account";

describe("normaliseErrorKey", () => {
  it("ignores case, extra spaces and the numbers in a message so the same fault groups together", () => {
    expect(normaliseErrorKey("Video is 6213844 bytes  too LARGE")).toBe(normaliseErrorKey("video is 5000001 bytes too large"));
  });
  it("gives an empty key for blank text", () => {
    expect(normaliseErrorKey("   ")).toBe("");
  });
});

describe("splitCorrectiveStep", () => {
  it("separates the 'Try ...' sentence from the explanation", () => {
    const r = splitCorrectiveStep("This file is too large for TikTok. Try a smaller file or compress it.");
    expect(r.message).toBe("This file is too large for TikTok.");
    expect(r.step).toBe("Try a smaller file or compress it.");
  });
  it("returns no step when the text has none", () => {
    const r = splitCorrectiveStep("This post to X didn't go through. Technical details are available below if you'd like them.");
    expect(r.step).toBeNull();
  });
});

describe("brandLabels", () => {
  it("lists each brand label once, sorted, skipping unbranded accounts", () => {
    expect(brandLabels(ACCOUNTS)).toEqual(["Alpha", "Beta"]);
  });
  it("returns an empty list for no accounts", () => {
    expect(brandLabels([])).toEqual([]);
  });
});

describe("buildFailuresModel", () => {
  it("is calm and NaN-free with no posts", () => {
    const m = buildFailuresModel([], ACCOUNTS, "");
    expect(m).toMatchObject({ failedCount: 0, recovered: 0, cleanSharePercent: null, groups: [], recent: [] });
  });
  it("counts failed posts and honours the brand filter", () => {
    const posts = [post("p1", "failed", "a1", [{ error_message: TOKEN }]), post("p2", "failed", "a3", [{ error_message: TOKEN }]), post("p3", "pending", "a1", [])];
    expect(buildFailuresModel(posts, ACCOUNTS, "").failedCount).toBe(2);
    expect(buildFailuresModel(posts, ACCOUNTS, "Alpha").failedCount).toBe(1);
    expect(buildFailuresModel(posts, ACCOUNTS, "Beta").failedCount).toBe(1);
  });
  it("counts retries that recovered: error attempts on posts that later went live", () => {
    const posts = [
      post("p1", "posted", "a1", [{ error_message: TOKEN }, { error_message: null }]),
      post("p2", "posted", "a1", [{ error_message: "Rate limit hit" }, { error_message: "Rate limit hit again" }, { error_message: null }]),
      post("p3", "failed", "a1", [{ error_message: TOKEN }]),
    ];
    expect(buildFailuresModel(posts, ACCOUNTS, "").recovered).toBe(3);
  });
  it("works out the share of attempts that were clean first time", () => {
    const posts = [
      post("p1", "posted", "a1", [{ error_message: null }]),
      post("p2", "posted", "a1", [{ error_message: null }]),
      post("p3", "posted", "a1", [{ error_message: null }]),
      post("p4", "failed", "a1", [{ error_message: TOKEN }]),
    ];
    expect(buildFailuresModel(posts, ACCOUNTS, "").cleanSharePercent).toBe(75);
  });
  it("gives no share (not NaN) when there are no attempts", () => {
    expect(buildFailuresModel([post("p1", "pending", "a1", [])], ACCOUNTS, "").cleanSharePercent).toBeNull();
  });
  it("groups the same error together with a count, plain-language message and corrective step", () => {
    const posts = [
      post("p1", "failed", "a1", [{ error_message: "Token has expired" }]),
      post("p2", "failed", "a1", [{ error_message: "token has expired" }]),
      post("p3", "posted", "a2", [{ error_message: "Sorry! We blocked this link because it may lead to spam." }]),
    ];
    const { groups } = buildFailuresModel(posts, ACCOUNTS, "");
    expect(groups).toHaveLength(2);
    expect(groups[0].count).toBe(2);
    expect(groups[0].message).toMatch(/needs to be refreshed/i);
    expect(groups[0].step).toMatch(/reconnecting/i);
    expect(groups[1].count).toBe(1);
    expect(groups[1].message).toMatch(/Pinterest decision/i);
    expect(groups[1].step).toMatch(/Help Center/);
  });
  it("uses the server's plain reason when the row has one (raw_error_message present)", () => {
    const posts = [post("p1", "failed", "a1", [{ error_message: "The video is longer than TikTok allows.", raw_error_message: "duration_exceeds 600" }])];
    expect(buildFailuresModel(posts, ACCOUNTS, "").groups[0].message).toBe("The video is longer than TikTok allows.");
  });
  it("says there is no step rather than guessing", () => {
    const posts = [post("p1", "failed", "a1", [{ error_message: "weird unknown thing" }])];
    expect(buildFailuresModel(posts, ACCOUNTS, "").groups[0].step).toBeNull();
  });
  it("sorts the biggest group first", () => {
    const posts = [post("p1", "failed", "a1", [{ error_message: "weird" }]), post("p2", "failed", "a1", [{ error_message: TOKEN }]), post("p3", "failed", "a1", [{ error_message: TOKEN }])];
    expect(buildFailuresModel(posts, ACCOUNTS, "").groups[0].count).toBe(2);
  });
  it("lists recent failures and recovered retries newest first, with failed ones flagged", () => {
    const posts = [
      post("old", "failed", "a1", [{ error_message: TOKEN }], "2026-10-01T10:00:00Z"),
      post("new", "posted", "a2", [{ error_message: "Rate limit" }, { error_message: null }], "2026-10-20T10:00:00Z"),
      post("none", "posted", "a2", [{ error_message: null }], "2026-10-21T10:00:00Z"),
    ];
    const { recent } = buildFailuresModel(posts, ACCOUNTS, "");
    expect(recent.map((r) => r.id)).toEqual(["new", "old"]);
    expect(recent[0]).toMatchObject({ platform: "pinterest", failed: false });
    expect(recent[1]).toMatchObject({ platform: "tiktok", failed: true });
    expect(recent[1].message).toMatch(/needs to be refreshed/i);
  });
  it("shows a safe message for a failed post that recorded no error text", () => {
    const { recent } = buildFailuresModel([post("p1", "failed", "a1", [])], ACCOUNTS, "");
    expect(recent[0].message).toMatch(/no further detail/i);
  });
  it("copes with posts that have no post_results or no account", () => {
    const bad = { id: "x", status: "failed", social_account_id: null, scheduled_for: null, content: "" } as unknown as ScheduledPost;
    const m = buildFailuresModel([bad], ACCOUNTS, "");
    expect(m.failedCount).toBe(1);
    expect(m.recent[0].platform).toBe("");
  });
});
