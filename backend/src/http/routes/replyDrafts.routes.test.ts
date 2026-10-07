// The review routes for suggested replies, through the real router. Login is a fake that can act as
// another account or as an API key; the database is the in-memory fake. Nothing here can reach a real
// database or send anything.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = req.headers["x-test-account"] ?? "acc1";
    req.authMethod = req.headers["x-test-auth"] === "apikey" ? "apiKey" : "jwt";
    next();
  },
  // Same rule as the real one: an API key never reaches a human-only route.
  requireHumanAuth: (req: any, res: any, next: any) => (req.authMethod === "apiKey" ? res.status(403).json({ error: "human only" }) : next()),
  requireJwtUser: (req: any, _res: any, next: any) => {
    req.jwtUser = { id: "user1", email: "owner@example.com" };
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});

const { buildReplyDraftsRouter } = await import("./replyDrafts.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildReplyDraftsRouter());
  return a;
};

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const ID4 = "44444444-4444-4444-8444-444444444444";
const rows = () => tables.reply_drafts;
const byId = (id: string) => rows().find((r) => r.id === id)!;

const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id, account_id: "acc1", scheduled_post_id: "p1", social_account_id: "sa1", platform_comment_id: `c-${id.slice(0, 2)}`, source_signature: "x",
  triage_category: "question", status: "pending_review", draft_text: "Thanks for asking!", edited_text: null,
  created_at: "2026-10-07T08:00:00.000Z", expires_at: "2026-10-14T08:00:00.000Z", ...over,
});

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.REPLY_DRAFTS_ENABLED;
  process.env.REPLY_DRAFTS_ENABLED = "true";
  for (const k of Object.keys(tables)) delete tables[k];
  tables.reply_drafts = [];
  tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform: "bluesky" }];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", social_account_id: "sa1", content: "We open at 9am", post_results: [{ platform_post_url: "https://bsky.app/post/1", verified_live: true }] },
    { id: "p9", account_id: "acc2", social_account_id: "sa1", content: "Other account's post", post_results: [] },
  ];
  tables.mention_comments_cache = [
    { account_id: "acc1", scheduled_post_id: "p1", platform_comment_id: "c-11", author: "maria", text: "What time do you open?", url: null, comment_created_at: "2026-10-07T07:00:00.000Z" },
    { account_id: "acc1", scheduled_post_id: "p1", platform_comment_id: "c-22", author: "tom", text: "Do you do gift wrapping?", url: "https://bsky.app/c/2", comment_created_at: "2026-10-07T07:30:00.000Z" },
    { account_id: "acc2", scheduled_post_id: "p9", platform_comment_id: "c-11", author: "SOMEONE ELSE", text: "private to acc2", url: null, comment_created_at: null },
  ];
});
afterEach(() => {
  if (saved === undefined) delete process.env.REPLY_DRAFTS_ENABLED;
  else process.env.REPLY_DRAFTS_ENABLED = saved;
});

describe("while the kill switch is off", () => {
  beforeEach(() => {
    process.env.REPLY_DRAFTS_ENABLED = "false";
    rows().push(draft(ID1));
  });

  it("the list is empty and says drafts are off, even though a draft exists", async () => {
    const r = await request(app()).get("/mentions/drafts");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, drafts: [], failed: [], waitingToSend: 0 });
  });

  it("approve and discard answer 404 and change nothing", async () => {
    expect((await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({})).status).toBe(404);
    expect((await request(app()).post(`/mentions/drafts/${ID1}/discard`).send({})).status).toBe(404);
    expect((await request(app()).post(`/mentions/drafts/${ID1}/retry`).send({})).status).toBe(404);
    expect(byId(ID1).status).toBe("pending_review");
  });
});

describe("GET /mentions/drafts", () => {
  it("lists only this account's drafts that still need a decision, newest first, with the comment and the post", async () => {
    rows().push(
      draft(ID1, { created_at: "2026-10-07T08:00:00.000Z" }),
      draft(ID2, { platform_comment_id: "c-22", status: "needs_input", draft_text: null, created_at: "2026-10-07T09:00:00.000Z" }),
      draft(ID3, { status: "approved", platform_comment_id: "c-33" }),
      draft(ID4, { account_id: "acc2", scheduled_post_id: "p9", platform_comment_id: "c-11" }),
    );
    const r = await request(app()).get("/mentions/drafts");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.drafts.map((d: any) => d.id)).toEqual([ID2, ID1]);
    expect(r.body.drafts[1]).toEqual({
      id: ID1, status: "pending_review", triageCategory: "question", draftText: "Thanks for asking!", replyLimit: 300,
      createdAt: "2026-10-07T08:00:00.000Z", expiresAt: "2026-10-14T08:00:00.000Z",
      post: { id: "p1", platform: "bluesky", content: "We open at 9am", url: "https://bsky.app/post/1" },
      comment: { id: "c-11", author: "maria", text: "What time do you open?", url: null, createdAt: "2026-10-07T07:00:00.000Z" },
    });
    expect(r.body.drafts[0]).toMatchObject({ status: "needs_input", draftText: null, comment: { author: "tom", text: "Do you do gift wrapping?" } });
  });

  it("never shows another account's post or comment text", async () => {
    rows().push(draft(ID1), draft(ID4, { account_id: "acc2", scheduled_post_id: "p9", platform_comment_id: "c-11" }));
    const r = await request(app()).get("/mentions/drafts");
    expect(JSON.stringify(r.body)).not.toMatch(/SOMEONE ELSE|private to acc2|Other account's post/);
    const as2 = await request(app()).get("/mentions/drafts").set("x-test-account", "acc2");
    expect(as2.body.drafts.map((d: any) => d.id)).toEqual([ID4]);
    expect(JSON.stringify(as2.body)).not.toContain("maria");
  });

  it("even rows of another account that carry the SAME ids never mix in (the account filter is a second lock)", async () => {
    rows().push(draft(ID1));
    tables.scheduled_posts.push({ id: "p1", account_id: "acc2", social_account_id: "sa1", content: "INTRUDER POST", post_results: [{ platform_post_url: "https://evil.example.net", verified_live: true }] });
    tables.mention_comments_cache.push({ account_id: "acc2", scheduled_post_id: "p1", platform_comment_id: "c-11", author: "INTRUDER", text: "INTRUDER COMMENT", url: null, comment_created_at: null });
    const r = await request(app()).get("/mentions/drafts");
    expect(r.body.drafts).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toMatch(/INTRUDER|evil\.example/);
    expect(r.body.drafts[0].comment.author).toBe("maria");
    expect(r.body.drafts[0].post.content).toBe("We open at 9am");
  });

  it("a draft whose comment is no longer in the cache still shows, with the comment blank", async () => {
    rows().push(draft(ID1, { platform_comment_id: "gone" }));
    const r = await request(app()).get("/mentions/drafts");
    expect(r.body.drafts[0].comment).toEqual({ id: "gone", author: "", text: "", url: null, createdAt: null });
    expect(r.body.drafts[0].draftText).toBe("Thanks for asking!");
  });

  it("an empty list is fine", async () => {
    expect((await request(app()).get("/mentions/drafts")).body).toEqual({ enabled: true, drafts: [], failed: [], waitingToSend: 0 });
  });

  it("uses the platform's own reply limit", async () => {
    tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform: "mastodon" }];
    rows().push(draft(ID1));
    expect((await request(app()).get("/mentions/drafts")).body.drafts[0].replyLimit).toBe(500);
  });
});

describe("POST /mentions/drafts/:id/approve", () => {
  it("approves a draft as it is and records who decided", async () => {
    rows().push(draft(ID1));
    const r = await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, status: "approved" });
    expect(byId(ID1)).toMatchObject({ status: "approved", decided_by: "user1", edited_text: null });
  });

  it("keeps the owner's own wording, trimmed", async () => {
    rows().push(draft(ID1));
    await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({ editedText: "  My own words  " });
    expect(byId(ID1)).toMatchObject({ status: "approved", edited_text: "My own words", draft_text: "Thanks for asking!" });
  });

  it.each([["empty", ""], ["spaces", "   "], ["too long", "x".repeat(2001)]])("refuses edited text that is %s and leaves the draft waiting", async (_l, text) => {
    rows().push(draft(ID1));
    const r = await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({ editedText: text });
    expect(r.status).toBe(400);
    expect(byId(ID1).status).toBe("pending_review");
  });

  it("refuses edited text that is not text", async () => {
    rows().push(draft(ID1));
    expect((await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({ editedText: 5 })).status).toBe(400);
    expect((await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({ editedText: { a: 1 } })).status).toBe(400);
    expect(byId(ID1).status).toBe("pending_review");
  });

  it("a 'needs input' draft needs the owner's reply: 400 without it, approved with it", async () => {
    rows().push(draft(ID2, { status: "needs_input", draft_text: null }));
    const none = await request(app()).post(`/mentions/drafts/${ID2}/approve`).send({});
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/write the reply/i);
    expect(byId(ID2).status).toBe("needs_input");
    const ok = await request(app()).post(`/mentions/drafts/${ID2}/approve`).send({ editedText: "Yes, we gift wrap for free." });
    expect(ok.status).toBe(200);
    expect(byId(ID2)).toMatchObject({ status: "approved", edited_text: "Yes, we gift wrap for free." });
  });

  it("the second approval of the same draft is a 409, not a second approval", async () => {
    rows().push(draft(ID1));
    expect((await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({})).status).toBe(200);
    const again = await request(app()).post(`/mentions/drafts/${ID1}/approve`).send({ editedText: "different" });
    expect(again.status).toBe(409);
    expect(byId(ID1).edited_text).toBeNull();
  });

  it("drafts that already moved on cannot be approved", async () => {
    for (const [i, status] of (["approved", "sending", "sent", "failed", "discarded", "expired"] as const).entries()) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa0${i}`;
      rows().push(draft(id, { status, sent_at: "x" }));
      expect((await request(app()).post(`/mentions/drafts/${id}/approve`).send({})).status, status).toBe(409);
      expect(byId(id).status).toBe(status);
    }
  });

  it("another account cannot approve it", async () => {
    rows().push(draft(ID1));
    const r = await request(app()).post(`/mentions/drafts/${ID1}/approve`).set("x-test-account", "acc2").send({});
    expect(r.status).toBe(409);
    expect(byId(ID1)).toMatchObject({ status: "pending_review" });
    expect(byId(ID1).decided_by).toBeUndefined();
  });

  it("an API key can never approve, only a signed-in person", async () => {
    rows().push(draft(ID1));
    const r = await request(app()).post(`/mentions/drafts/${ID1}/approve`).set("x-test-auth", "apikey").send({});
    expect(r.status).toBe(403);
    expect(byId(ID1).status).toBe("pending_review");
  });

  it("an id that is not a real id is a 404", async () => {
    for (const bad of ["abc", "1", "not-a-uuid", "11111111-1111-1111-1111-11111111111Z"]) {
      expect((await request(app()).post(`/mentions/drafts/${bad}/approve`).send({})).status, bad).toBe(404);
    }
  });
});

describe("POST /mentions/drafts/:id/discard", () => {
  it("discards a waiting draft and records who", async () => {
    rows().push(draft(ID1));
    const r = await request(app()).post(`/mentions/drafts/${ID1}/discard`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, status: "discarded" });
    expect(byId(ID1)).toMatchObject({ status: "discarded", decided_by: "user1" });
  });

  it("can discard a 'needs input' prompt too", async () => {
    rows().push(draft(ID2, { status: "needs_input", draft_text: null }));
    expect((await request(app()).post(`/mentions/drafts/${ID2}/discard`).send({})).status).toBe(200);
  });

  it("a draft that is already approved or sent cannot be discarded this way", async () => {
    rows().push(draft(ID1, { status: "approved" }), draft(ID2, { status: "sent", sent_at: "x" }));
    expect((await request(app()).post(`/mentions/drafts/${ID1}/discard`).send({})).status).toBe(409);
    expect((await request(app()).post(`/mentions/drafts/${ID2}/discard`).send({})).status).toBe(409);
    expect(byId(ID1).status).toBe("approved");
  });

  it("another account cannot discard it, and an API key cannot either", async () => {
    rows().push(draft(ID1));
    expect((await request(app()).post(`/mentions/drafts/${ID1}/discard`).set("x-test-account", "acc2").send({})).status).toBe(409);
    expect((await request(app()).post(`/mentions/drafts/${ID1}/discard`).set("x-test-auth", "apikey").send({})).status).toBe(403);
    expect(byId(ID1).status).toBe("pending_review");
  });

  it("the second discard is a 409", async () => {
    rows().push(draft(ID1));
    await request(app()).post(`/mentions/drafts/${ID1}/discard`).send({});
    expect((await request(app()).post(`/mentions/drafts/${ID1}/discard`).send({})).status).toBe(409);
  });

  it("an id that is not a real id is a 404", async () => {
    expect((await request(app()).post("/mentions/drafts/abc/discard").send({})).status).toBe(404);
  });
});

const failedDraft = (id: string, over: Record<string, unknown> = {}) =>
  draft(id, { status: "failed", edited_text: "Our own words", decided_at: "2026-10-07T09:00:00.000Z", send_attempts: 1, error: "Mastodon reply failed (HTTP 401)", ...over });

describe("replies that could not be sent", () => {
  it("are listed with the reason, the wording, the tries and the comment, newest decision first, for this account only", async () => {
    rows().push(
      failedDraft(ID1, { platform_comment_id: "c-11", decided_at: "2026-10-07T09:00:00.000Z" }),
      failedDraft(ID2, { platform_comment_id: "c-22", decided_at: "2026-10-07T10:00:00.000Z", send_attempts: 5, error: "Could not send after 5 tries. Last problem: Mastodon reply failed (HTTP 429)" }),
      failedDraft(ID3, { account_id: "acc2", scheduled_post_id: "p9", platform_comment_id: "c-11" }),
      draft(ID4, { status: "sent", platform_comment_id: "c-44" }),
    );
    const r = await request(app()).get("/mentions/drafts");
    expect(r.body.failed.map((f: any) => f.id)).toEqual([ID2, ID1]);
    expect(r.body.failed[1]).toEqual({
      id: ID1, replyText: "Our own words", error: "Mastodon reply failed (HTTP 401)", uncertain: false, tries: 1, decidedAt: "2026-10-07T09:00:00.000Z",
      post: { id: "p1", platform: "bluesky", content: "We open at 9am", url: "https://bsky.app/post/1" },
      comment: { id: "c-11", author: "maria", text: "What time do you open?", url: null, createdAt: "2026-10-07T07:00:00.000Z" },
    });
    expect(r.body.failed[0]).toMatchObject({ tries: 5, comment: { author: "tom" } });
    expect(JSON.stringify(r.body)).not.toMatch(/SOMEONE ELSE|private to acc2/);
  });

  it("the reply text is the suggestion when the owner did not change it", async () => {
    rows().push(failedDraft(ID1, { edited_text: null }));
    expect((await request(app()).get("/mentions/drafts")).body.failed[0].replyText).toBe("Thanks for asking!");
  });

  it("flags the ones LazyRelay cannot be sure about, so the owner is told to look first", async () => {
    rows().push(
      failedDraft(ID1, { platform_comment_id: "c-11", error: "LazyRelay could not confirm whether this reply was posted (The request timed out). Check your account before trying again, so it is not posted twice." }),
      failedDraft(ID2, { platform_comment_id: "c-22", error: "LazyRelay stopped while sending this reply, so it may or may not have been posted. Check your account before trying again, so it is not posted twice." }),
      failedDraft(ID3, { platform_comment_id: "c-33", error: "Mastodon reply failed (HTTP 403)" }),
    );
    const byFailedId = Object.fromEntries((await request(app()).get("/mentions/drafts")).body.failed.map((f: any) => [f.id, f.uncertain]));
    expect(byFailedId).toEqual({ [ID1]: true, [ID2]: true, [ID3]: false });
  });

  it("shows even when nothing is waiting for a decision", async () => {
    rows().push(failedDraft(ID1));
    const r = await request(app()).get("/mentions/drafts");
    expect(r.body.drafts).toEqual([]);
    expect(r.body.failed).toHaveLength(1);
  });

  it("counts this account's approved and sending replies that are still waiting to go out", async () => {
    rows().push(
      draft(ID1, { status: "approved", platform_comment_id: "c-a" }),
      draft(ID2, { status: "sending", platform_comment_id: "c-b" }),
      draft(ID3, { status: "sent", platform_comment_id: "c-c" }),
      draft(ID4, { status: "approved", account_id: "acc2", platform_comment_id: "c-d" }),
    );
    expect((await request(app()).get("/mentions/drafts")).body.waitingToSend).toBe(2);
  });

  it("can be tried again: back to approved with the tries and the error cleared, and who asked recorded", async () => {
    rows().push(failedDraft(ID1, { send_attempts: 5, next_attempt_at: "2026-10-08T00:00:00.000Z" }));
    const r = await request(app()).post(`/mentions/drafts/${ID1}/retry`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, status: "approved" });
    expect(byId(ID1)).toMatchObject({ status: "approved", error: null, send_attempts: 0, next_attempt_at: null, decided_by: "user1" });
  });

  it("only a failed reply can be tried again", async () => {
    for (const [i, status] of (["pending_review", "needs_input", "approved", "sending", "sent", "discarded", "expired"] as const).entries()) {
      const id = `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb0${i}`;
      rows().push(draft(id, { status, sent_at: "x", platform_comment_id: `cc-${i}` }));
      expect((await request(app()).post(`/mentions/drafts/${id}/retry`).send({})).status, status).toBe(409);
      expect(byId(id).status).toBe(status);
    }
  });

  it("another account cannot retry it, an API key cannot retry, a bad id is a 404", async () => {
    rows().push(failedDraft(ID1));
    expect((await request(app()).post(`/mentions/drafts/${ID1}/retry`).set("x-test-account", "acc2").send({})).status).toBe(409);
    expect((await request(app()).post(`/mentions/drafts/${ID1}/retry`).set("x-test-auth", "apikey").send({})).status).toBe(403);
    expect((await request(app()).post("/mentions/drafts/nope/retry").send({})).status).toBe(404);
    expect(byId(ID1).status).toBe("failed");
  });

  it("can be dismissed with the discard route", async () => {
    rows().push(failedDraft(ID1));
    const r = await request(app()).post(`/mentions/drafts/${ID1}/discard`).send({});
    expect(r.status).toBe(200);
    expect(byId(ID1)).toMatchObject({ status: "discarded", decided_by: "user1" });
    expect((await request(app()).get("/mentions/drafts")).body.failed).toEqual([]);
  });
});
