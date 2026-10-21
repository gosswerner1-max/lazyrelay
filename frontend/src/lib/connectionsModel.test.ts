import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({}));
import { connectionSummary, integrationStates, tileText } from "./connectionsModel";
import { channelStates } from "./postingChannels";
import type { ScheduledPost, SocialAccount } from "./api";

const acct = (id: string, platform: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null, ...extra,
});
const ACCOUNTS = [
  acct("a1", "tiktok", "Alpha Brand"), acct("a2", "tiktok", "Alpha Brand"), acct("a3", "facebook", "Alpha Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
  acct("a4", "whatsapp", "Alpha Brand"), acct("b1", "tiktok", "Beta Brand"), acct("b2", "x", "Beta Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
];
const post = (id: string, accountId: string, paused: string | null, status = "pending") => ({ id, social_account_id: accountId, status, paused_at: paused }) as unknown as ScheduledPost;
const POSTS = [post("p1", "a1", "2026-10-20T00:00:00Z"), post("p2", "a1", "2026-10-20T00:00:00Z"), post("p3", "b1", "2026-10-20T00:00:00Z"), post("p4", "a2", null), post("p5", "a2", "2026-10-20T00:00:00Z", "posted")];

describe("connectionSummary", () => {
  it("counts platforms, accounts, reconnects and paused queues across all brands", () => {
    const s = connectionSummary(ACCOUNTS, POSTS, "");
    expect(s).toEqual({ connectedPlatforms: 2, totalPlatforms: 19, accounts: 6, needReconnect: 2, pausedAccounts: 2 });
  });
  it("follows the brand switch", () => {
    expect(connectionSummary(ACCOUNTS, POSTS, "Alpha Brand")).toEqual({ connectedPlatforms: 2, totalPlatforms: 19, accounts: 4, needReconnect: 1, pausedAccounts: 1 });
    expect(connectionSummary(ACCOUNTS, POSTS, "Beta Brand")).toEqual({ connectedPlatforms: 1, totalPlatforms: 19, accounts: 2, needReconnect: 1, pausedAccounts: 1 });
  });
  it("is all zeros for no accounts", () => {
    expect(connectionSummary([], [], "")).toEqual({ connectedPlatforms: 0, totalPlatforms: 19, accounts: 0, needReconnect: 0, pausedAccounts: 0 });
  });
});

describe("tileText", () => {
  const find = (id: string, brand: string) => channelStates(ACCOUNTS, brand).find((s) => s.id === id)!;
  it("says how many accounts when connected", () => {
    expect(tileText(find("tiktok", "Alpha Brand"))).toBe("2 accounts");
    expect(tileText(find("whatsapp", "Alpha Brand"))).toBe("1 account");
  });
  it("invites a connection when not connected", () => {
    expect(tileText(find("youtube", "Alpha Brand"))).toBe("Click to Connect API");
  });
  it("says reconnecting is needed", () => {
    expect(tileText(find("facebook", "Alpha Brand"))).toBe("Needs reconnecting. Click to Connect API");
  });
});

describe("integrationStates", () => {
  it("reads calendar and sheets status and WhatsApp from accounts", () => {
    const r = integrationStates({ gcal: { last_synced_at: "2026-10-20T10:00:00Z" }, gsheet: null, accounts: ACCOUNTS });
    expect(r.map((i) => [i.id, i.state])).toEqual([["gcal", "connected"], ["gsheet", "not-connected"], ["whatsapp", "connected"]]);
    expect(r[0].lastSyncedAt).toBe("2026-10-20T10:00:00Z");
  });
  it("shows checking while status has not loaded and not connected without WhatsApp", () => {
    const r = integrationStates({ gcal: undefined, gsheet: undefined, accounts: [] });
    expect(r.map((i) => i.state)).toEqual(["checking", "checking", "not-connected"]);
  });
  it("flags a WhatsApp number that needs reconnecting", () => {
    const r = integrationStates({ gcal: null, gsheet: null, accounts: [acct("w", "whatsapp", null, { needs_reconnect_at: "2026-10-01T00:00:00Z" })] });
    expect(r[2].state).toBe("needs-reconnect");
  });
});
