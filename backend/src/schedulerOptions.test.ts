// Through the real scheduler: a post's platform options reach the adapter, and a thread
// chain runs only after the main post is confirmed live, records how far it got, and
// can never change the main post's own status. supabase is an in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "token", error: null }) } };
});
vi.mock("./notify.js", () => ({ notifyOps: async () => {} }));
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendReconnectNeededEmail: vi.fn() }));
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: async () => {} }));

const { runSchedulerCycle } = await import("./scheduler.js");

let n = 0;
function setup(platform: string, over: Record<string, unknown> = {}) {
  n += 1;
  tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform, display_name: "Acct", platform_account_id: "pa1", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null }];
  tables.accounts = [{ id: "acc1", email: "a@b.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.post_results = [];
  tables.scheduled_posts = [{ id: `p${n}`, account_id: "acc1", social_account_id: "sa1", content: "main", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date().toISOString(), ...over }];
}
const ok = (id: string) => ({ success: true, platformPostId: id, errorMessage: null });
const registryOf = (a: { platform: string }) => ({ get: (p: string) => (p === a.platform ? a : undefined) }) as never;
const live = { verifiedLive: true, platformPostUrl: "https://x/p", errorMessage: null };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("options reach the adapter", () => {
  it("passes the stored options, and an empty object when there are none", async () => {
    setup("optplat1", { options: { tiktok: { aiGenerated: true } } });
    const adapter = { platform: "optplat1", post: vi.fn(async () => ok("m1")), verifyPublished: vi.fn(async () => live) };
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledWith(expect.objectContaining({ options: { tiktok: { aiGenerated: true } } }));

    setup("optplat2");
    const plain = { platform: "optplat2", post: vi.fn(async () => ok("m2")), verifyPublished: vi.fn(async () => live) };
    await runSchedulerCycle(registryOf(plain));
    expect(plain.post).toHaveBeenCalledWith(expect.objectContaining({ options: {} }));
  });
});

describe("thread chain", () => {
  it("posts the follow-ups in order after the main post is verified, and records the result", async () => {
    setup("chainplat1", { options: { chain: ["two", "three"] } });
    const replies: Array<{ parent: string; text: string }> = [];
    const adapter = {
      platform: "chainplat1",
      post: vi.fn(async () => ok("main-id")),
      verifyPublished: vi.fn(async () => live),
      postChainReply: vi.fn(async (i: { parentPostId: string; text: string }) => {
        replies.push({ parent: i.parentPostId, text: i.text });
        return ok(`r${replies.length}`);
      }),
    };
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(replies).toEqual([
      { parent: "main-id", text: "two" },
      { parent: "r1", text: "three" },
    ]);
    expect(tables.post_results[0]).toMatchObject({ chain_posted: 2, chain_error: null });
  });

  it("a refused follow-up stops the thread, is recorded, and never touches the main post's status", async () => {
    setup("chainplat2", { options: { chain: ["two", "three"] } });
    let calls = 0;
    const adapter = {
      platform: "chainplat2",
      post: vi.fn(async () => ok("main-id")),
      verifyPublished: vi.fn(async () => live),
      postChainReply: vi.fn(async () => (++calls === 2 ? { success: false, platformPostId: null, errorMessage: "Duplicate content" } : ok("r1"))),
    };
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.scheduled_posts[0].retry_count).toBe(0);
    expect(tables.post_results[0]).toMatchObject({ chain_posted: 1, chain_error: "Duplicate content" });
    expect(adapter.post).toHaveBeenCalledTimes(1); // the main post is never re-run because a follow-up failed
  });

  it("no thread is started when the main post is not confirmed live", async () => {
    setup("chainplat3", { options: { chain: ["two"] } });
    const adapter = {
      platform: "chainplat3",
      post: vi.fn(async () => ok("main-id")),
      verifyPublished: vi.fn(async () => ({ verifiedLive: false, platformPostUrl: null, errorMessage: "not there" })),
      postChainReply: vi.fn(async () => ok("r1")),
    };
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.postChainReply).not.toHaveBeenCalled();
  });

  it("a post with no chain never calls postChainReply", async () => {
    setup("chainplat4");
    const adapter = { platform: "chainplat4", post: vi.fn(async () => ok("m")), verifyPublished: vi.fn(async () => live), postChainReply: vi.fn(async () => ok("r")) };
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.postChainReply).not.toHaveBeenCalled();
    expect(tables.post_results[0].chain_posted ?? null).toBeNull();
  });
});

describe("saved as a draft on the platform", () => {
  it("ends cleanly: posted, recorded as a draft, no retry, no follow-ups, not counted as verified", async () => {
    setup("draftplat1", { options: { chain: ["two"] } });
    const adapter = {
      platform: "draftplat1",
      post: vi.fn(async () => ok("d1")),
      verifyPublished: vi.fn(async () => ({ verifiedLive: false, platformPostUrl: "https://x/draft", errorMessage: "Saved as a draft on X as you chose, not published.", savedAsDraft: true })),
      postChainReply: vi.fn(async () => ok("never")),
    };
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.scheduled_posts[0].retry_count).toBe(0);
    expect(tables.post_results).toHaveLength(1);
    expect(tables.post_results[0]).toMatchObject({ verified_live: false, saved_as_draft: true, platform_post_id: "d1", error_message: "Saved as a draft on X as you chose, not published." });
    expect(adapter.postChainReply).not.toHaveBeenCalled();
    // A second cycle must not post it again.
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
  });

  it("an ordinary unverified post still retries (only a deliberate draft is exempt)", async () => {
    setup("draftplat2");
    const adapter = { platform: "draftplat2", post: vi.fn(async () => ok("u1")), verifyPublished: vi.fn(async () => ({ verifiedLive: false, platformPostUrl: null, errorMessage: "not there yet" })) };
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).not.toBe("posted");
    expect(tables.post_results[0]).not.toMatchObject({ saved_as_draft: true });
  });
});
