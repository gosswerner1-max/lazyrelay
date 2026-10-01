// Delayed first comment through the real scheduler: the comment is held back until due, posted exactly once
// (also with two workers, and after a restart), never posted for a post that is not live, and marked failed
// when it is more than 24 hours late. supabase is an in-memory fake and the clock is faked, nothing real is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "token", error: null }) } };
});
vi.mock("./notify.js", () => ({ notifyOps: vi.fn(async () => {}) }));
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendPinterestPausedAlert: vi.fn(), sendReconnectNeededEmail: vi.fn() }));
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

const { runSchedulerCycle, runFirstCommentPass } = await import("./scheduler.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

let seq = 0;
function seed(platform: string, over: Record<string, unknown> = {}) {
  tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform, display_name: "Acct", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null }];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.post_results = [];
  seq += 1;
  tables.scheduled_posts = [
    { id: `p${seq}`, account_id: "acc1", social_account_id: "sa1", content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString(), first_comment: "great post", first_comment_delay_minutes: null, ...over },
  ];
  return `p${seq}`;
}

function adapterOf(platform: string, opts: { postOk?: boolean; verifyLive?: boolean; comment?: () => Promise<{ success: boolean; errorMessage: string | null }> } = {}) {
  return {
    platform,
    post: vi.fn(async () => (opts.postOk === false ? { success: false, platformPostId: null, errorMessage: "Content is a duplicate of a recent post" } : { success: true, platformPostId: "plat-1", errorMessage: null })),
    verifyPublished: vi.fn(async () => (opts.verifyLive === false ? { verifiedLive: false, platformPostUrl: null, errorMessage: "not visible yet" } : { verifiedLive: true, platformPostUrl: "https://x/p", errorMessage: null })),
    postComment: vi.fn(opts.comment ?? (async () => ({ success: true, errorMessage: null }))),
  };
}
const registryOf = (a: { platform: string }) => ({ get: (p: string) => (p === a.platform ? a : undefined) }) as never;
const result = () => tables.post_results[0];
const at = (ms: number) => vi.setSystemTime(new Date(T0 + ms));

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("delay 0 or none is exactly today's behaviour", () => {
  for (const delay of [null, 0]) {
    it(`first_comment_delay_minutes ${delay} posts the comment right after the post`, async () => {
      seed("facebook", { first_comment_delay_minutes: delay });
      const a = adapterOf("facebook");
      await runSchedulerCycle(registryOf(a));
      expect(a.postComment).toHaveBeenCalledTimes(1);
      expect(a.postComment).toHaveBeenCalledWith("plat-1", "great post", "token");
      expect(result()).toMatchObject({ first_comment_posted: true, first_comment_error: null });
      expect(result().first_comment_due_at).toBeUndefined();
      expect(tables.scheduled_posts[0].status).toBe("posted");
    });
  }
});

describe("a delayed comment", () => {
  it("is not posted with the post: the due time is set and the result stays unset", async () => {
    seed("facebook", { first_comment_delay_minutes: 30 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(a.postComment).not.toHaveBeenCalled();
    expect(result().first_comment_due_at).toBe(new Date(T0 + 30 * MIN).toISOString());
    expect(result().first_comment_posted).toBeUndefined();
  });

  it("is not posted before it is due, and is posted once at the due time", async () => {
    seed("instagram", { first_comment_delay_minutes: 30 });
    const a = adapterOf("instagram");
    await runSchedulerCycle(registryOf(a));

    at(30 * MIN - 1000);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();

    at(30 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).toHaveBeenCalledTimes(1);
    expect(a.postComment).toHaveBeenCalledWith("plat-1", "great post", "token");
    expect(result()).toMatchObject({ first_comment_posted: true, first_comment_error: null });

    // Later cycles never comment again.
    at(31 * MIN);
    await runSchedulerCycle(registryOf(a));
    at(2 * HOUR);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).toHaveBeenCalledTimes(1);
    expect(a.post).toHaveBeenCalledTimes(1);
  });

  it("still posts when the due time passed while the server was down (once, on the next pass)", async () => {
    seed("facebook", { first_comment_delay_minutes: 15 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    at(6 * HOUR); // the server was off for hours
    expect(await runFirstCommentPass(registryOf(a), Date.now())).toBe(1);
    expect(await runFirstCommentPass(registryOf(a), Date.now())).toBe(0);
    expect(a.postComment).toHaveBeenCalledTimes(1);
    expect(result().first_comment_posted).toBe(true);
  });

  it("is posted once even when two workers run the pass at the same moment", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook", {
      comment: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { success: true, errorMessage: null };
      },
    });
    await runSchedulerCycle(registryOf(a));
    at(6 * MIN);
    const counts = await Promise.all([runFirstCommentPass(registryOf(a), Date.now()), runFirstCommentPass(registryOf(a), Date.now()), runFirstCommentPass(registryOf(a), Date.now())]);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
    expect(a.postComment).toHaveBeenCalledTimes(1);
  });

  it("a comment that failed is recorded with its reason and never retried", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook", { comment: async () => ({ success: false, errorMessage: "Comments are turned off on this post" }) });
    await runSchedulerCycle(registryOf(a));
    at(6 * MIN);
    await runSchedulerCycle(registryOf(a));
    at(20 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).toHaveBeenCalledTimes(1);
    expect(result()).toMatchObject({ first_comment_posted: false, first_comment_error: "Comments are turned off on this post" });
  });

  it("a comment call that throws is recorded as failed, once", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook", { comment: async () => { throw new Error("socket hang up"); } });
    await runSchedulerCycle(registryOf(a));
    at(6 * MIN);
    await runSchedulerCycle(registryOf(a));
    at(10 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).toHaveBeenCalledTimes(1);
    expect(result().first_comment_posted).toBe(false);
    expect(String(result().first_comment_error)).not.toBe("");
  });

  it("more than 24 hours past due is marked failed with a clear reason, not posted", async () => {
    seed("facebook", { first_comment_delay_minutes: 60 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    at(60 * MIN + 24 * HOUR + 1000);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();
    expect(result().first_comment_posted).toBe(false);
    expect(String(result().first_comment_error)).toMatch(/more than 24 hours late/);
  });

  it("exactly 24 hours past due is still posted", async () => {
    seed("facebook", { first_comment_delay_minutes: 60 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    at(60 * MIN + 24 * HOUR);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).toHaveBeenCalledTimes(1);
  });

  it("carries the free-tier branding tag like an immediate comment does", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    tables.accounts[0].show_branding_tag = true; // no subscription row: free tier
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    at(6 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(String(a.postComment.mock.calls[0][1])).toMatch(/^great post\n\n.*scheduled via LazyRelay/);
  });
});

describe("a delayed comment never goes on a post that is not live", () => {
  it("a post whose publishing failed gets no due time and no comment", async () => {
    seed("instagram", { first_comment_delay_minutes: 5 });
    const a = adapterOf("instagram", { postOk: false });
    await runSchedulerCycle(registryOf(a));
    at(10 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();
    expect(tables.post_results.every((r) => r.first_comment_due_at === undefined)).toBe(true);
  });

  it("a post that could not be verified live gets no due time and no comment", async () => {
    seed("instagram", { first_comment_delay_minutes: 5 });
    const a = adapterOf("instagram", { verifyLive: false });
    await runSchedulerCycle(registryOf(a));
    at(10 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();
    expect(tables.post_results.every((r) => r.first_comment_due_at === undefined)).toBe(true);
  });

  it("a post deleted while the comment was waiting leaves nothing to comment on", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    tables.post_results = []; // the database removes a deleted post's results with it
    tables.scheduled_posts = [];
    at(10 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();
  });

  it("a post that is no longer marked posted is not commented on, and says why", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    tables.scheduled_posts[0].status = "failed";
    at(10 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();
    expect(result()).toMatchObject({ first_comment_posted: false });
    expect(String(result().first_comment_error)).toMatch(/no longer live/);
  });
});

describe("a held-up comment is not lost", () => {
  it("a paused connected account releases the comment, and it posts once the account is back", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    tables.social_accounts[0].paused_at = new Date(T0).toISOString();
    at(10 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();
    expect(result().first_comment_posted).toBeUndefined();
    expect(result().first_comment_claimed_at ?? null).toBeNull();

    tables.social_accounts[0].paused_at = null;
    at(HOUR);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).toHaveBeenCalledTimes(1);
    expect(result().first_comment_posted).toBe(true);
  });

  it("a platform that is not configured on this deploy releases the comment for later", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    at(10 * MIN);
    await runFirstCommentPass({ get: () => undefined } as never, Date.now());
    expect(result().first_comment_claimed_at ?? null).toBeNull();
    await runFirstCommentPass(registryOf(a), Date.now());
    expect(a.postComment).toHaveBeenCalledTimes(1);
  });

  it("a comment claimed by a process that died mid-send is marked unconfirmed, never sent again", async () => {
    seed("facebook", { first_comment_delay_minutes: 5 });
    const a = adapterOf("facebook");
    await runSchedulerCycle(registryOf(a));
    result().first_comment_claimed_at = new Date(T0 + 6 * MIN).toISOString(); // claimed, then the process died
    at(40 * MIN);
    await runSchedulerCycle(registryOf(a));
    expect(a.postComment).not.toHaveBeenCalled();
    expect(result().first_comment_posted).toBe(false);
    expect(String(result().first_comment_error)).toMatch(/interrupted/);
  });
});
