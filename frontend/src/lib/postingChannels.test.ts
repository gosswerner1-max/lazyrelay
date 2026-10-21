// Channel logic behind the Posting workspace: which channels are connected for the selected brand, what stays ticked when the brand changes,
// the tightest character limit, and the queue numbers shown next to the composer. Pure functions, no network.
import { describe, it, expect, vi } from "vitest";

// dashboardHelpers pulls in the API client, which needs a database address to start; the logic under test never calls it.
vi.mock("./api", () => ({}));
import { COMPOSER_CHANNELS, channelStates, reconcileSelection, tightestLimit, queueStats } from "./postingChannels";
import { UNBRANDED_FILTER_VALUE } from "../pages/dashboard/dashboardHelpers";
import type { ScheduledPost, SocialAccount } from "./api";

const acct = (id: string, platform: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null, ...extra,
});
const ACCOUNTS: SocialAccount[] = [
  acct("a1", "tiktok", "LazyRelay"),
  acct("a2", "facebook", "LazyRelay"),
  acct("a3", "facebook", "LazyRelay"),
  acct("a4", "whatsapp", "LazyRelay"),
  acct("a5", "pinterest", "LazyRelay", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
  acct("a6", "facebook", "TimeAJob"),
  acct("a7", "linkedin", null),
];

describe("COMPOSER_CHANNELS", () => {
  it("is the 18 distribution platforms plus WhatsApp, in one fixed order, with no repeats", () => {
    expect(COMPOSER_CHANNELS).toHaveLength(19);
    expect(COMPOSER_CHANNELS[COMPOSER_CHANNELS.length - 1].id).toBe("whatsapp");
    expect(new Set(COMPOSER_CHANNELS.map((c) => c.id)).size).toBe(19);
    for (const id of ["tiktok", "instagram", "facebook", "youtube", "linkedin", "pinterest", "mastodon", "bluesky", "threads", "x", "telegram", "discord", "wordpress", "devto", "hashnode", "lemmy", "slack", "tumblr"]) {
      expect(COMPOSER_CHANNELS.map((c) => c.id)).toContain(id);
    }
  });
});

describe("channelStates", () => {
  it("always returns all 19 channels in the same order, whatever the brand", () => {
    for (const brand of ["", "LazyRelay", "TimeAJob", UNBRANDED_FILTER_VALUE]) {
      expect(channelStates(ACCOUNTS, brand).map((c) => c.id)).toEqual(COMPOSER_CHANNELS.map((c) => c.id));
    }
  });
  it("marks a channel connected only when the selected brand has a usable account on it", () => {
    const lr = Object.fromEntries(channelStates(ACCOUNTS, "LazyRelay").map((c) => [c.id, c]));
    expect(lr.tiktok.connected).toBe(true);
    expect(lr.facebook.accounts.map((a) => a.id)).toEqual(["a2", "a3"]);
    expect(lr.whatsapp.connected).toBe(true);
    expect(lr.youtube.connected).toBe(false);
    const tj = Object.fromEntries(channelStates(ACCOUNTS, "TimeAJob").map((c) => [c.id, c]));
    expect(tj.facebook.connected).toBe(true);
    expect(tj.facebook.accounts.map((a) => a.id)).toEqual(["a6"]);
    expect(tj.tiktok.connected).toBe(false);
    expect(tj.whatsapp.connected).toBe(false);
  });
  it("an account that needs reconnecting does not count as connected, and says so", () => {
    const pin = channelStates(ACCOUNTS, "LazyRelay").find((c) => c.id === "pinterest")!;
    expect(pin.connected).toBe(false);
    expect(pin.needsReconnect).toBe(true);
    expect(channelStates(ACCOUNTS, "TimeAJob").find((c) => c.id === "pinterest")!.needsReconnect).toBe(false);
  });
  it("an empty brand filter means every account, and the unbranded filter means accounts with no brand", () => {
    const all = Object.fromEntries(channelStates(ACCOUNTS, "").map((c) => [c.id, c]));
    expect(all.facebook.accounts).toHaveLength(3);
    expect(all.linkedin.connected).toBe(true);
    const un = channelStates(ACCOUNTS, UNBRANDED_FILTER_VALUE).filter((c) => c.connected).map((c) => c.id);
    expect(un).toEqual(["linkedin"]);
  });
});

describe("reconcileSelection", () => {
  const lr = channelStates(ACCOUNTS, "LazyRelay");
  it("keeps the ticks that are still connected and drops the rest", () => {
    expect(reconcileSelection(["tiktok", "youtube", "facebook"], lr)).toEqual(["tiktok", "facebook"]);
  });
  it("never leaves nothing ticked: it falls back to the first three connected channels", () => {
    expect(reconcileSelection(["youtube"], lr)).toEqual(["tiktok", "facebook", "whatsapp"]);
    expect(reconcileSelection([], lr)).toEqual(["tiktok", "facebook", "whatsapp"]);
  });
  it("returns nothing when no channel is connected", () => {
    expect(reconcileSelection(["tiktok"], channelStates([], ""))).toEqual([]);
  });
});

describe("tightestLimit", () => {
  it("is the smallest character limit among the ticked channels", () => {
    expect(tightestLimit(["tiktok", "x", "facebook"])).toMatchObject({ id: "x", limit: 280 });
    expect(tightestLimit(["tiktok", "instagram"])?.limit).toBe(2200);
  });
  it("is null when nothing is ticked", () => {
    expect(tightestLimit([])).toBeNull();
  });
});

describe("queueStats", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const post = (id: string, status: ScheduledPost["status"], accountId: string | null, when: string | null, paused: string | null = null): ScheduledPost =>
    ({ id, status, social_account_id: accountId, scheduled_for: when, paused_at: paused, content: "x" }) as unknown as ScheduledPost;
  const POSTS = [
    post("p1", "pending", "a1", "2026-10-22T08:00:00Z", "2026-10-20T00:00:00Z"),
    post("p2", "pending", "a2", "2026-10-22T09:00:00Z", "2026-10-20T00:00:00Z"),
    post("p3", "pending", "a6", "2026-10-22T10:00:00Z"),
    post("p4", "posted", "a1", "2026-10-10T08:00:00Z"),
    post("p5", "posted", "a1", "2026-08-01T08:00:00Z"),
    post("p6", "draft", null, null),
    post("p7", "posted", "a6", "2026-10-19T08:00:00Z"),
  ];
  it("counts the paused queue, scheduled posts and published in the last 30 days for one brand; drafts have no account yet, so they are always all counted", () => {
    expect(queueStats(POSTS, ACCOUNTS, "LazyRelay", now)).toEqual({ paused: 2, scheduled: 0, published30d: 1, drafts: 1 });
    expect(queueStats(POSTS, ACCOUNTS, "TimeAJob", now)).toEqual({ paused: 0, scheduled: 1, published30d: 1, drafts: 1 });
  });
  it("counts everything for an empty brand filter", () => {
    expect(queueStats(POSTS, ACCOUNTS, "", now)).toEqual({ paused: 2, scheduled: 1, published30d: 2, drafts: 1 });
  });
});
