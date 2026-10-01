// The real WhopAdapter driven by the real scheduler (supabase and Whop's API are stubs). Proves the proof-of-publish
// rule for Whop: a failed read-back after a successful create is "unconfirmed", the retry re-checks and NEVER calls
// POST /forum_posts again; a lost answer is retried with the same idempotency key; a removed app fails at once with a
// reason and flags the account for reconnect.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";
import { APP_ID, APP_PASS, createFakeWhop, freshCompany } from "./whopTestKit.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "whop-uses-the-lazyrelay-app-connection", error: null }) } };
});
vi.mock("../notify.js", () => ({ notifyOps: vi.fn(async () => {}) }));
vi.mock("../email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendPinterestPausedAlert: vi.fn(), sendReconnectNeededEmail: vi.fn() }));
vi.mock("../webhook.js", () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

const { runSchedulerCycle } = await import("../scheduler.js");
const { WhopAdapter } = await import("./whop.js");

const MIN = 60_000;
const ACCOUNT = "biz_TestCo12345:exp_ForumOne1234";
const registryOf = (adapter: unknown) => ({ get: (p: string) => (p === "whop" ? adapter : undefined) }) as never;
let whop: ReturnType<typeof createFakeWhop>;
let adapter: InstanceType<typeof WhopAdapter>;

function seed(content = "Launch day <@everyone>") {
  tables.social_accounts = [
    { id: "sa1", account_id: "acc1", platform: "whop", display_name: "Forums (Lazyrelay)", platform_account_id: ACCOUNT, paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null },
  ];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", social_account_id: "sa1", platform_account_id: ACCOUNT, content, media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString() },
  ];
  tables.post_results = [];
}
const due = () => (tables.scheduled_posts[0].scheduled_for = new Date(Date.now() - MIN).toISOString());
const creates = () => whop.callsTo("POST", "/forum_posts");

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  whop = createFakeWhop([freshCompany()]);
  vi.stubGlobal("fetch", vi.fn(whop.handler));
  adapter = new WhopAdapter(APP_PASS, APP_ID);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("Whop through the scheduler", () => {
  it("posts to the connected forum, reads it back, and stores the post link as the proof link", async () => {
    seed();
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.post_results).toHaveLength(1);
    const row = tables.post_results[0];
    expect(row.verified_live).toBe(true);
    expect(String(row.platform_post_url)).toMatch(/^https:\/\/whop\.com\/lazyrelay-test\/exp_ForumOne1234\/app\/posts\/post_Test\d+\/$/);
    expect(String(creates()[0].body?.content)).not.toContain("<@"); // the customer's text cannot mention anyone
    expect(creates()[0].headers["idempotency-key"]).toBe("lazyrelay-post-p1");
  });

  it("a failed read-back after a successful create is unconfirmed, and the retry re-checks WITHOUT posting again", async () => {
    seed();
    let reads = 0;
    whop.scripted.push({ match: (m, p) => m === "GET" && p.startsWith("/forum_posts/") && ++reads === 1, status: 404, body: { error: { message: "nope" } } });
    await runSchedulerCycle(registryOf(adapter));
    expect(creates()).toHaveLength(1);
    expect(tables.scheduled_posts[0].status).toBe("pending"); // reset for a retry, not failed
    expect(tables.post_results).toHaveLength(1);
    expect(tables.post_results[0].verified_live).toBe(false);
    expect(String(tables.post_results[0].error_message)).toMatch(/will not post it twice/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull(); // a 404 on the read-back is never a reconnect

    due();
    await runSchedulerCycle(registryOf(adapter));
    expect(creates()).toHaveLength(1); // NOT posted a second time
    expect(whop.posts.get("exp_ForumOne1234")).toHaveLength(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.post_results).toHaveLength(1); // the same proof row, updated
    expect(tables.post_results[0].verified_live).toBe(true);
  });

  it("an answer lost after Whop created the post is retried with the same key and ends with ONE post", async () => {
    seed();
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status: 0, afterEffect: true });
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.post_results.filter((r) => r.platform_post_id)).toHaveLength(0); // no id came back, so the scheduler will call post() again
    due();
    await runSchedulerCycle(registryOf(adapter));
    expect(creates()).toHaveLength(2);
    expect(new Set(creates().map((c) => c.headers["idempotency-key"])).size).toBe(1);
    expect(whop.posts.get("exp_ForumOne1234")).toHaveLength(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
  });

  it("a removed app (403) fails at once, flags the account for reconnect, and tells the customer what to do", async () => {
    seed();
    whop.setInstalled("biz_TestCo12345", false);
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status: 403, body: { error: { message: "no" } } });
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toMatch(/Reinstall the LazyRelay app/);
    expect(tables.post_results[0].raw_error_message).toMatch(/whop_forbidden/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(creates()).toHaveLength(1);
  });

  it("a rate limit is retried later, not failed", async () => {
    seed();
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status: 429, body: { error: { type: "rate_limit_exceeded", message: "Try again in 12 seconds." } } });
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.scheduled_posts[0].retry_count).toBe(1);
  });

  it("a verification-required answer (422) fails at once and shows Whop's message", async () => {
    seed();
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status: 422, body: { error: { message: "Verification required." } } });
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toMatch(/Verification required/);
  });
});
