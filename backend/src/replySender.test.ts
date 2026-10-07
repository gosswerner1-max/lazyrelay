// The reply sender: which approved drafts are sent, what is retried (only what provably posted nothing), what is
// never retried (anything uncertain), and every way a send can be blocked. The platform, the login loader and the
// database are fakes; nothing here can post anything or reach a database.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeBuilder, tables } from "./testFakeSupabase.js";
import {
  MAX_APPROVED_AGE_MS,
  MAX_SENDS_PER_ACCOUNT_PER_CYCLE,
  MAX_SEND_ATTEMPTS,
  SENDER_BATCH_SIZE,
  STUCK_SENDING_MS,
  classifyFailure,
  retryDelayMs,
  runReplySenderCycle,
  type SenderAdapter,
  type SenderDeps,
} from "./replySender.js";
import { UNCONFIRMED_SEND_MESSAGE } from "./replyDrafts.js";

const ON = { REPLY_DRAFTS_ENABLED: "true" };
const T0 = new Date("2026-10-20T12:00:00.000Z");
const minutes = (n: number) => n * 60_000;
const rows = () => tables.reply_drafts;
const byId = (id: string) => rows().find((r) => r.id === id)!;

const seed = (id: string, over: Record<string, unknown> = {}) =>
  rows().push({
    id, account_id: "acc1", social_account_id: "sa1", scheduled_post_id: "p1", platform_comment_id: `c-${id}`,
    status: "approved", draft_text: "Thanks for asking!", edited_text: null, decided_by: "user1",
    decided_at: new Date(T0.getTime() - minutes(5)).toISOString(), send_attempts: 0, next_attempt_at: null,
    created_at: "2026-10-20T11:00:00.000Z", updated_at: "2026-10-20T11:55:00.000Z", error: null, platform_reply_id: null, sent_at: null,
    ...over,
  });

const social = (over: Record<string, unknown> = {}) => ({
  id: "sa1", account_id: "acc1", platform: "bluesky", disconnected_at: null, paused_at: null, needs_reconnect_at: null, needs_reconnect_reason: null, ...over,
});

type Reply = (commentId: string, text: string, token: string) => Promise<{ success: boolean; errorMessage: string | null; platformReplyId?: string | null }>;
let reply: ReturnType<typeof vi.fn<Reply>>;
let getToken: ReturnType<typeof vi.fn<SenderDeps["getToken"]>>;
let now: Date;

const deps = (over: Partial<SenderDeps> = {}): SenderDeps => ({
  db: { from: (t: string) => makeBuilder(t) } as never,
  getAdapter: () => ({ replyToComment: reply }) as SenderAdapter,
  getToken,
  env: ON,
  now: () => now,
  ...over,
});
const run = (over: Partial<SenderDeps> = {}) => runReplySenderCycle(deps(over));

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.reply_drafts = [];
  tables.social_accounts = [social()];
  now = new Date(T0);
  reply = vi.fn<Reply>(async () => ({ success: true, errorMessage: null, platformReplyId: "reply-1" }));
  getToken = vi.fn<SenderDeps["getToken"]>(async () => "token-abc");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("classifyFailure: what a failure means", () => {
  it.each([
    "Mastodon is rate limiting this account. Try again in a minute or two.",
    "Mastodon reply failed (HTTP 429)",
    "Mastodon reply failed (HTTP 503)",
    "Service unavailable",
    "Could not reach Mastodon. Try again in a few minutes.",
    "connect ECONNREFUSED 10.0.0.1:443",
    "getaddrinfo ENOTFOUND mastodon.example",
    "getaddrinfo EAI_AGAIN mastodon.example",
  ])("during the send, %j is safe to retry (nothing was posted)", (m) => expect(classifyFailure(m, "during_send").kind).toBe("retry"));

  it.each([
    "The request timed out",
    "fetch failed",
    "socket hang up",
    "read ECONNRESET",
    "Mastodon reply failed (HTTP 500)",
    "Bluesky reply failed (HTTP 502)",
    "Mastodon reply failed (HTTP 504)",
    "Mastodon reply failed (HTTP 408)",
    "Bluesky did not confirm the reply",
  ])("during the send, %j is uncertain: never retried by itself", (m) => {
    const c = classifyFailure(m, "during_send");
    expect(c.kind).toBe("unconfirmed");
    expect(c.reason).toMatch(/could not confirm whether this reply was posted/);
    expect(c.reason).toMatch(/Check your account before trying again/);
    expect(c.reason).toContain(m.replace(/[.\s]+$/, ""));
  });

  it.each([
    "Mastodon reply failed (HTTP 401)",
    "Mastodon reply failed (HTTP 403)",
    "Mastodon reply failed (HTTP 404)",
    "Bluesky reply failed (HTTP 422)",
    "Could not resolve the comment being replied to",
    "The Bluesky login was refused. Reconnect this account.",
  ])("%j is a refusal: shown to the owner, not retried", (m) => {
    expect(classifyFailure(m, "during_send")).toEqual({ kind: "permanent", reason: m });
  });

  it("before anything was sent, a timeout or a server error is safe to retry, a refusal is still final", () => {
    for (const m of ["The request timed out", "fetch failed", "Something failed (HTTP 500)", "Something failed (HTTP 408)"]) {
      expect(classifyFailure(m, "before_send").kind, m).toBe("retry");
    }
    expect(classifyFailure("The Bluesky connection expired. Reconnect it in Social Platforms.", "before_send").kind).toBe("permanent");
  });

  it("an empty message still gives the owner something to read", () => {
    expect(classifyFailure("  ", "during_send")).toEqual({ kind: "permanent", reason: "The reply could not be sent." });
  });

  it("waits 1, 5, 15 and then 60 minutes", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000]);
    expect(retryDelayMs(0)).toBe(60_000);
  });
});

describe("the cycle: what is sent", () => {
  it("does nothing, and posts nothing, while the kill switch is off", async () => {
    seed("a");
    for (const env of [{}, { REPLY_DRAFTS_ENABLED: "false" }, { REPLY_DRAFTS_ENABLED: "TRUE" }]) {
      const s = await run({ env });
      expect(s.disabled).toBe(true);
    }
    expect(reply).not.toHaveBeenCalled();
    expect(byId("a").status).toBe("approved");
  });

  it("sends an approved reply once, with exactly the comment id, the text and the login, and records the proof", async () => {
    seed("a");
    const s = await run();
    expect(s.counts).toEqual({ sent: 1 });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("c-a", "Thanks for asking!", "token-abc");
    expect(getToken).toHaveBeenCalledWith("sa1", expect.objectContaining({ replyToComment: reply }));
    expect(byId("a")).toMatchObject({ status: "sent", platform_reply_id: "reply-1", send_attempts: 1, error: null, next_attempt_at: null });
    expect(typeof byId("a").sent_at).toBe("string");
  });

  it("sends the owner's own wording when there is one", async () => {
    seed("a", { edited_text: "Our own words" });
    await run();
    expect(reply).toHaveBeenCalledWith("c-a", "Our own words", "token-abc");
  });

  it("a platform that gives no reply id is still sent, with the id left empty", async () => {
    reply.mockResolvedValue({ success: true, errorMessage: null });
    seed("a");
    await run();
    expect(byId("a")).toMatchObject({ status: "sent", platform_reply_id: null });
  });

  it("sends nothing that is not approved", async () => {
    for (const status of ["pending_review", "needs_input", "sending", "sent", "failed", "discarded", "expired"]) seed(`s-${status}`, { status, sent_at: "x" });
    const s = await run({ now: () => new Date(T0.getTime() + minutes(1)) });
    expect(reply).not.toHaveBeenCalled();
    expect(s.counts).toEqual({});
  });

  it("the same draft is never sent twice, however many cycles run", async () => {
    seed("a");
    await run();
    await run();
    await run();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("two cycles at the same moment: only one wins the draft", async () => {
    seed("a");
    const [one, two] = await Promise.all([run(), run()]);
    expect(reply).toHaveBeenCalledTimes(1);
    const all = [...one.outcomes, ...two.outcomes].map((o) => o.outcome).sort();
    expect(all.filter((o) => o === "sent")).toHaveLength(1);
  });

  it("a draft that is taken away between the lookup and the claim is not sent", async () => {
    seed("a");
    const racing = {
      from: (t: string) => {
        const b = makeBuilder(t) as Record<string, unknown>;
        if (t === "reply_drafts") {
          const realUpdate = b.update as (p: Record<string, unknown>) => unknown;
          b.update = (p: Record<string, unknown>) => {
            if (p.status === "sending") byId("a").status = "discarded"; // a person discards it at the very moment of the claim
            return realUpdate(p);
          };
        }
        return b;
      },
    } as never;
    const s = await run({ db: racing });
    expect(s.counts).toEqual({ lost_race: 1 });
    expect(reply).not.toHaveBeenCalled();
    expect(byId("a").status).toBe("discarded");
  });

  it("one draft failing does not stop the next one", async () => {
    seed("a", { decided_at: new Date(T0.getTime() - minutes(10)).toISOString() });
    seed("b");
    reply.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce({ success: true, errorMessage: null, platformReplyId: "r2" });
    const s = await run();
    expect(s.counts).toEqual({ failed_unconfirmed: 1, sent: 1 });
    expect(byId("a").status).toBe("failed");
    expect(byId("b").status).toBe("sent");
  });
});

describe("the cycle: what it writes to the server log", () => {
  it("writes one line when it sent something, with the counts and the draft ids, and never the reply text", async () => {
    seed("a", { draft_text: "PRIVATE-REPLY-TEXT" });
    await run();
    expect(console.log).toHaveBeenCalledTimes(1);
    const line = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(line).toBe('[replySender] cycle: {"sent":1} drafts=a:sent');
    expect(line).not.toContain("PRIVATE-REPLY-TEXT");
  });

  it("writes the failure outcomes too, one line per cycle", async () => {
    seed("a");
    seed("b", { decided_at: new Date(T0.getTime() - minutes(1)).toISOString() });
    reply.mockResolvedValueOnce({ success: false, errorMessage: "Mastodon reply failed (HTTP 429)" }).mockResolvedValueOnce({ success: false, errorMessage: "Mastodon reply failed (HTTP 401)" });
    await run();
    expect(console.log).toHaveBeenCalledTimes(1);
    expect((console.log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toBe('[replySender] cycle: {"retry_scheduled":1,"failed":1} drafts=a:retry_scheduled,b:failed');
  });

  it("notes stuck sends cleaned up in the line", async () => {
    seed("stuck", { status: "sending", updated_at: new Date(T0.getTime() - STUCK_SENDING_MS - minutes(1)).toISOString() });
    await run();
    expect((console.log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toBe("[replySender] cycle: {} stuckFailed=1 drafts=");
  });

  it("an idle cycle, or one that is switched off, writes nothing", async () => {
    await run();
    await run({ env: {} });
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe("the cycle: retries that are safe", () => {
  it("a rate limit puts the draft back to wait one minute, keeping the reason and counting the try", async () => {
    seed("a");
    reply.mockResolvedValue({ success: false, errorMessage: "Mastodon is rate limiting this account. Try again in a minute or two." });
    const s = await run();
    expect(s.counts).toEqual({ retry_scheduled: 1 });
    expect(byId("a")).toMatchObject({ status: "approved", send_attempts: 1, next_attempt_at: new Date(T0.getTime() + minutes(1)).toISOString() });
    expect(byId("a").error).toMatch(/rate limiting/);
  });

  it("it is not tried again before its time, and is sent when its time comes", async () => {
    seed("a", { send_attempts: 1, next_attempt_at: new Date(T0.getTime() + minutes(1)).toISOString() });
    await run({ now: () => new Date(T0.getTime() + minutes(0.5)) });
    expect(reply).not.toHaveBeenCalled();
    await run({ now: () => new Date(T0.getTime() + minutes(1)) });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(byId("a")).toMatchObject({ status: "sent", send_attempts: 2, error: null, next_attempt_at: null });
  });

  it("keeps waiting 1, 5, 15 and 60 minutes, then gives up after 5 tries with the last reason", async () => {
    seed("a");
    reply.mockResolvedValue({ success: false, errorMessage: "Mastodon reply failed (HTTP 429)" });
    const waits: number[] = [];
    let clock = T0.getTime();
    for (let i = 1; i <= MAX_SEND_ATTEMPTS; i++) {
      now = new Date(clock);
      await run();
      if (byId("a").status === "approved") {
        const wait = Date.parse(byId("a").next_attempt_at as string) - clock;
        waits.push(wait / 60_000);
        clock += wait;
      }
    }
    expect(waits).toEqual([1, 5, 15, 60]);
    expect(reply).toHaveBeenCalledTimes(5);
    expect(byId("a")).toMatchObject({ status: "failed", send_attempts: 5, next_attempt_at: null });
    expect(byId("a").error).toMatch(/Could not send after 5 tries/);
    expect(byId("a").error).toMatch(/HTTP 429/);
    now = new Date(clock + minutes(500));
    await run();
    expect(reply).toHaveBeenCalledTimes(5); // a failed draft is never picked up again by itself
  });

  it("a server that cannot be reached is retried, a login that cannot be loaded because of the network is retried", async () => {
    seed("a");
    seed("b", { decided_at: new Date(T0.getTime() - minutes(1)).toISOString() });
    reply.mockResolvedValueOnce({ success: false, errorMessage: "Could not reach Mastodon. Try again in a few minutes." });
    getToken.mockImplementationOnce(async () => "t").mockRejectedValueOnce(new Error("fetch failed"));
    const s = await run();
    expect(s.counts).toEqual({ retry_scheduled: 2 });
    expect(byId("a").status).toBe("approved");
    expect(byId("b").status).toBe("approved");
  });

  it("a thrown connection refusal is retried (the request never went out)", async () => {
    seed("a");
    reply.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:443"));
    expect((await run()).counts).toEqual({ retry_scheduled: 1 });
  });
});

describe("the cycle: what is never retried by itself", () => {
  it("a timeout during the send is marked failed with a note to check the account, and never sent again", async () => {
    seed("a");
    reply.mockResolvedValue({ success: false, errorMessage: "The request timed out" });
    const s = await run();
    expect(s.counts).toEqual({ failed_unconfirmed: 1 });
    expect(byId("a")).toMatchObject({ status: "failed", send_attempts: 1, next_attempt_at: null });
    expect(byId("a").error).toMatch(/Check your account before trying again/);
    for (let i = 1; i <= 5; i++) {
      now = new Date(T0.getTime() + minutes(100 * i));
      await run();
    }
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("a server error during the send is uncertain too", async () => {
    seed("a");
    reply.mockResolvedValue({ success: false, errorMessage: "Mastodon reply failed (HTTP 500)" });
    expect((await run()).counts).toEqual({ failed_unconfirmed: 1 });
  });

  it("an error nobody recognised, thrown during the send, is uncertain: it could be a bug after the reply was posted", async () => {
    seed("a");
    reply.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const s = await run();
    expect(s.counts).toEqual({ failed_unconfirmed: 1 });
    expect(byId("a").error).toMatch(/could not confirm whether this reply was posted/);
  });

  it("a plain refusal is final and shown as the platform said it", async () => {
    seed("a");
    reply.mockResolvedValue({ success: false, errorMessage: "Mastodon reply failed (HTTP 401)" });
    const s = await run();
    expect(s.counts).toEqual({ failed: 1 });
    expect(byId("a")).toMatchObject({ status: "failed", error: "Mastodon reply failed (HTTP 401)", send_attempts: 1 });
    now = new Date(T0.getTime() + minutes(600));
    await run();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("a login that cannot be loaded for a real reason (expired, revoked) is final and the platform is never called", async () => {
    seed("a");
    getToken.mockRejectedValue(new Error("The Bluesky connection expired on 2026-10-01. Reconnect it in Social Platforms."));
    const s = await run();
    expect(s.counts).toEqual({ failed: 1 });
    expect(byId("a").error).toMatch(/Reconnect it in Social Platforms/);
    expect(reply).not.toHaveBeenCalled();
  });

  it("a send that was started but never finished is marked uncertain, never sent again", async () => {
    seed("stuck", { status: "sending", updated_at: new Date(T0.getTime() - STUCK_SENDING_MS - minutes(1)).toISOString() });
    seed("busy", { status: "sending", updated_at: new Date(T0.getTime() - minutes(1)).toISOString() });
    const s = await run();
    expect(s.stuckFailed).toBe(1);
    expect(byId("stuck")).toMatchObject({ status: "failed", error: UNCONFIRMED_SEND_MESSAGE });
    expect(byId("busy").status).toBe("sending");
    await run({ now: () => new Date(T0.getTime() + minutes(60)) });
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("the cycle: a send is blocked before anything is posted", () => {
  const blocked = async (message: RegExp) => {
    const s = await run();
    expect(s.counts).toEqual({ failed: 1 });
    expect(byId("a")).toMatchObject({ status: "failed", send_attempts: 1 });
    expect(byId("a").error).toMatch(message);
    expect(reply).not.toHaveBeenCalled();
  };

  it("a draft with no text", async () => {
    seed("a", { draft_text: null, edited_text: null });
    await blocked(/no text/);
  });

  it("a reply longer than the platform allows (Bluesky 300)", async () => {
    seed("a", { draft_text: "x".repeat(301) });
    await blocked(/longer than bluesky allows \(300 characters\)/);
  });

  it("exactly at the limit is fine", async () => {
    seed("a", { draft_text: "x".repeat(300) });
    expect((await run()).counts).toEqual({ sent: 1 });
  });

  it("an account that was disconnected", async () => {
    tables.social_accounts = [social({ disconnected_at: "2026-10-01T00:00:00Z" })];
    seed("a");
    await blocked(/no longer connected/);
  });

  it("an account that is gone", async () => {
    tables.social_accounts = [];
    seed("a");
    await blocked(/no longer connected/);
  });

  it("another account's connection is never used", async () => {
    tables.social_accounts = [social({ account_id: "acc2" })];
    seed("a");
    await blocked(/no longer connected/);
  });

  it("an account that needs reconnecting, with the reason it gave", async () => {
    tables.social_accounts = [social({ needs_reconnect_at: "2026-10-01T00:00:00Z", needs_reconnect_reason: "The Bluesky login was revoked." })];
    seed("a");
    await blocked(/login was revoked/);
  });

  it("a paused account", async () => {
    tables.social_accounts = [social({ paused_at: "2026-10-01T00:00:00Z" })];
    seed("a");
    await blocked(/paused/);
  });

  it("a platform that is not switched on for replies", async () => {
    tables.social_accounts = [social({ platform: "facebook" })];
    seed("a");
    await blocked(/not switched on/);
  });

  it("an adapter that cannot reply", async () => {
    seed("a");
    const s = await run({ getAdapter: () => ({}) });
    expect(s.counts).toEqual({ failed: 1 });
    expect(byId("a").error).toMatch(/not supported/);
  });

  it("no adapter at all", async () => {
    seed("a");
    expect((await run({ getAdapter: () => undefined })).counts).toEqual({ failed: 1 });
  });

  it("an approval that is more than a day old", async () => {
    seed("a", { decided_at: new Date(T0.getTime() - MAX_APPROVED_AGE_MS - minutes(1)).toISOString() });
    await blocked(/too long ago/);
  });

  it("an approval just inside the day is still sent", async () => {
    seed("a", { decided_at: new Date(T0.getTime() - MAX_APPROVED_AGE_MS + minutes(1)).toISOString() });
    expect((await run()).counts).toEqual({ sent: 1 });
  });
});

describe("the cycle: pace", () => {
  it("sends at most 3 per account per cycle and leaves the rest for the next one", async () => {
    for (let i = 0; i < 5; i++) seed(`a${i}`, { decided_at: new Date(T0.getTime() - minutes(10 - i)).toISOString() });
    const s = await run();
    expect(MAX_SENDS_PER_ACCOUNT_PER_CYCLE).toBe(3);
    expect(s.counts).toEqual({ sent: 3, skipped_account_cap: 2 });
    expect(rows().filter((r) => r.status === "sent").map((r) => r.id)).toEqual(["a0", "a1", "a2"]); // oldest decision first
    expect(rows().filter((r) => r.status === "approved").map((r) => r.id).sort()).toEqual(["a3", "a4"]);
    await run();
    expect(rows().every((r) => r.status === "sent")).toBe(true);
  });

  it("handles at most 10 drafts in one cycle, across accounts", async () => {
    tables.social_accounts = [];
    for (let a = 0; a < 4; a++) {
      tables.social_accounts.push(social({ id: `sa${a}`, account_id: `acc${a}` }));
      for (let i = 0; i < 3; i++) seed(`d${a}-${i}`, { account_id: `acc${a}`, social_account_id: `sa${a}`, decided_at: new Date(T0.getTime() - minutes(60 - a * 3 - i)).toISOString() });
    }
    const s = await run();
    expect(SENDER_BATCH_SIZE).toBe(10);
    expect(reply).toHaveBeenCalledTimes(10);
    expect(s.counts.sent).toBe(10);
    expect(rows().filter((r) => r.status === "approved")).toHaveLength(2);
  });

  it("one account's backlog does not starve another account", async () => {
    tables.social_accounts = [social(), social({ id: "sa2", account_id: "acc2" })];
    for (let i = 0; i < 6; i++) seed(`busy${i}`, { decided_at: new Date(T0.getTime() - minutes(100 - i)).toISOString() });
    seed("quiet", { account_id: "acc2", social_account_id: "sa2", decided_at: new Date(T0.getTime() - minutes(1)).toISOString() });
    await run();
    expect(byId("quiet").status).toBe("sent");
  });
});

describe("recording a posted reply", () => {
  const failingSent = (failures: number) => {
    let left = failures;
    return {
      from: (t: string) => {
        const b = makeBuilder(t) as Record<string, unknown>;
        if (t === "reply_drafts") {
          const realUpdate = b.update as (p: Record<string, unknown>) => unknown;
          b.update = (p: Record<string, unknown>) => {
            if (p.status === "sent" && left > 0) {
              left -= 1;
              throw new Error("connection lost");
            }
            return realUpdate(p);
          };
        }
        return b;
      },
    } as never;
  };

  it("if saving 'sent' fails once, it is saved on the next try and the reply is still sent only once", async () => {
    seed("a");
    const s = await run({ db: failingSent(1) });
    expect(s.counts).toEqual({ sent: 1 });
    expect(byId("a").status).toBe("sent");
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("if saving keeps failing, it says so loudly, and the reply is never sent again", async () => {
    seed("a");
    const s = await run({ db: failingSent(99) });
    expect(s.counts).toEqual({ sent_unrecorded: 1 });
    expect(byId("a").status).toBe("sending");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("WAS POSTED"));
    now = new Date(T0.getTime() + minutes(30));
    await run();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(byId("a").status).toBe("failed"); // the stuck-send sweep: uncertain, a person looks
  });
});
