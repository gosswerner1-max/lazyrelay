// The reply_drafts data layer: pure rules and queries, against the in-memory fake database
// (testFakeSupabase.ts). Nothing here can reach a real database. The table's own rules
// (check constraints, unique) were proven separately on a temporary branch.

import { describe, it, expect, beforeEach } from "vitest";
import { makeBuilder, tables } from "./testFakeSupabase.js";
import {
  REPLY_DRAFT_STATUSES,
  TRANSITIONS,
  canTransition,
  replyDraftsEnabled,
  isDraftableCategory,
  isReplyDraftStatus,
  cleanReplyText,
  cleanFailureReason,
  textToSend,
  createDraft,
  listDraftsAwaitingReview,
  getDraft,
  moveDraft,
  approveDraft,
  discardDraft,
  retryFailedDraft,
  claimForSending,
  markSent,
  markFailed,
  expireStaleDrafts,
  freeStuckSending,
  type ReplyDraftStatus,
} from "./replyDrafts.js";

const db = { from: (t: string) => makeBuilder(t) } as never;
const rows = () => tables.reply_drafts;
const byId = (id: string) => rows().find((r) => r.id === id)!;

const base = {
  account_id: "acc1",
  scheduled_post_id: "p1",
  social_account_id: "sa1",
  source_signature: "x",
  triage_category: "question",
  draft_text: "Thanks for asking!",
  edited_text: null,
  expires_at: "2099-01-01T00:00:00.000Z",
  updated_at: "2026-10-07T08:00:00.000Z",
};
const seed = (id: string, status: ReplyDraftStatus, over: Record<string, unknown> = {}) =>
  rows().push({ ...base, id, status, platform_comment_id: `c-${id}`, created_at: `2026-10-07T08:00:0${rows().length}.000Z`, ...over });

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.reply_drafts = [];
});

describe("pure rules", () => {
  it("the kill switch is on only for the exact text true", () => {
    expect(replyDraftsEnabled({ REPLY_DRAFTS_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "1", "yes", "false", " true"]) expect(replyDraftsEnabled({ REPLY_DRAFTS_ENABLED: v })).toBe(false);
    expect(replyDraftsEnabled({})).toBe(false);
  });

  it("an angry customer, or anything unknown, is never draftable", () => {
    expect(["sales_question", "question", "routine"].every(isDraftableCategory)).toBe(true);
    for (const c of ["angry_customer", "", "refund", undefined, null, 5]) expect(isDraftableCategory(c)).toBe(false);
  });

  it("knows the eight statuses and nothing else", () => {
    expect(REPLY_DRAFT_STATUSES).toHaveLength(8);
    expect(REPLY_DRAFT_STATUSES.every(isReplyDraftStatus)).toBe(true);
    expect(isReplyDraftStatus("weird")).toBe(false);
  });

  it("allows exactly the moves in the plan, and no others", () => {
    const allowed = new Set([
      "pending_review>approved", "pending_review>discarded", "pending_review>expired",
      "needs_input>approved", "needs_input>discarded", "needs_input>expired",
      "approved>sending",
      "sending>sent", "sending>failed", "sending>approved",
      "failed>approved", "failed>discarded",
    ]);
    for (const from of REPLY_DRAFT_STATUSES) {
      for (const to of REPLY_DRAFT_STATUSES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
    }
  });

  it("sent, discarded and expired are final", () => {
    for (const s of ["sent", "discarded", "expired"] as const) expect(TRANSITIONS[s]).toEqual([]);
  });

  it("reply text: trimmed, 1 to 2000 characters, text only", () => {
    expect(cleanReplyText("  hello  ")).toEqual({ ok: true, text: "hello" });
    expect(cleanReplyText("a".repeat(2000)).ok).toBe(true);
    for (const bad of ["", "   ", "a".repeat(2001), null, undefined, 5, {}]) expect(cleanReplyText(bad).ok).toBe(false);
  });

  it("sends the owner's edit when there is one, otherwise the draft, otherwise nothing", () => {
    expect(textToSend({ draft_text: "d", edited_text: "e" })).toBe("e");
    expect(textToSend({ draft_text: "d", edited_text: null })).toBe("d");
    expect(textToSend({ draft_text: null, edited_text: null })).toBeNull();
  });

  it("a failure reason is one short line with no long dashes", () => {
    expect(cleanFailureReason("Mastodon said no — try later\nplease")).toBe("Mastodon said no - try later please");
    expect(cleanFailureReason("x".repeat(500))).toHaveLength(300);
    expect(cleanFailureReason(undefined)).toBe("The reply could not be sent.");
    expect(cleanFailureReason("   ")).toBe("The reply could not be sent.");
  });
});

describe("createDraft", () => {
  const input = { accountId: "acc1", scheduledPostId: "p1", socialAccountId: "sa1", platformCommentId: "c1", triageCategory: "question", draftText: "Thanks!" };

  it("stores a draft waiting for review", async () => {
    const r = await createDraft(db, input);
    expect(r.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ account_id: "acc1", scheduled_post_id: "p1", platform_comment_id: "c1", source_signature: "c1", status: "pending_review", draft_text: "Thanks!", triage_category: "question" });
  });

  it("no draft text means a 'needs input' prompt, not a draft", async () => {
    const r = await createDraft(db, { ...input, draftText: null });
    expect(r.ok && r.row.status).toBe("needs_input");
    expect(rows()[0].draft_text).toBeNull();
  });

  it("never writes a row for an angry customer or an unknown category", async () => {
    for (const triageCategory of ["angry_customer", "refund", undefined]) {
      const r = await createDraft(db, { ...input, triageCategory });
      expect(r).toMatchObject({ ok: false, reason: "not_draftable" });
    }
    expect(rows()).toHaveLength(0);
  });

  it("refuses empty or oversized draft text without writing", async () => {
    for (const draftText of ["", "   ", "a".repeat(2001)]) expect(await createDraft(db, { ...input, draftText })).toMatchObject({ ok: false, reason: "invalid_text" });
    expect(rows()).toHaveLength(0);
  });

  it("trims the draft text before storing it", async () => {
    await createDraft(db, { ...input, draftText: "  Thanks!  " });
    expect(rows()[0].draft_text).toBe("Thanks!");
  });

  it("a comment that already has a draft gives 'duplicate', not an error and not a second row", async () => {
    const dup = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) }) }) }) } as never;
    expect(await createDraft(dup, input)).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("any other database error is reported, not swallowed", async () => {
    const broken = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "08006", message: "connection lost" } }) }) }) }) } as never;
    expect(await createDraft(broken, input)).toMatchObject({ ok: false, reason: "db_error", message: "connection lost" });
  });
});

describe("reading", () => {
  it("lists only this account's drafts that still need a decision, newest first", async () => {
    seed("a", "pending_review");
    seed("b", "needs_input", { draft_text: null });
    seed("c", "approved");
    seed("d", "sent", { sent_at: "x" });
    seed("e", "pending_review", { account_id: "acc2" });
    const { data, error } = await listDraftsAwaitingReview(db, "acc1");
    expect(error).toBeNull();
    expect(data.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("the list is capped at 50 whatever is asked for", async () => {
    for (let i = 0; i < 60; i++) seed(`x${i}`, "pending_review", { created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() });
    expect((await listDraftsAwaitingReview(db, "acc1", 500)).data).toHaveLength(50);
    expect((await listDraftsAwaitingReview(db, "acc1", 3)).data).toHaveLength(3);
  });

  it("another account's draft id gives nothing", async () => {
    seed("a", "pending_review");
    expect((await getDraft(db, "acc1", "a"))?.id).toBe("a");
    expect(await getDraft(db, "acc2", "a")).toBeNull();
    expect(await getDraft(db, "acc1", "nope")).toBeNull();
  });
});

describe("approving", () => {
  it("approves a draft and records who and when", async () => {
    seed("a", "pending_review");
    const r = await approveDraft(db, "acc1", "a", "user1");
    expect(r.ok).toBe(true);
    expect(byId("a")).toMatchObject({ status: "approved", decided_by: "user1" });
    expect(typeof byId("a").decided_at).toBe("string");
    expect(byId("a").edited_text).toBeNull();
  });

  it("keeps the owner's own wording, trimmed", async () => {
    seed("a", "pending_review");
    await approveDraft(db, "acc1", "a", "user1", "  My own reply  ");
    expect(byId("a")).toMatchObject({ status: "approved", edited_text: "My own reply", draft_text: "Thanks for asking!" });
  });

  it("refuses bad edited text and leaves the draft waiting", async () => {
    seed("a", "pending_review");
    for (const bad of ["", "   ", "a".repeat(2001)]) expect(await approveDraft(db, "acc1", "a", "user1", bad)).toMatchObject({ ok: false, reason: "invalid_text" });
    expect(byId("a").status).toBe("pending_review");
  });

  it("a 'needs input' row cannot be approved without the owner's text", async () => {
    seed("n", "needs_input", { draft_text: null });
    expect(await approveDraft(db, "acc1", "n", "user1")).toMatchObject({ ok: false, reason: "no_text" });
    expect(byId("n").status).toBe("needs_input");
  });

  it("a 'needs input' row is approved once the owner writes the reply", async () => {
    seed("n", "needs_input", { draft_text: null });
    expect((await approveDraft(db, "acc1", "n", "user1", "Here is the answer.")).ok).toBe(true);
    expect(byId("n")).toMatchObject({ status: "approved", edited_text: "Here is the answer." });
  });

  it("only drafts that are still waiting can be approved", async () => {
    for (const s of ["approved", "sending", "sent", "failed", "discarded", "expired"] as const) {
      seed(`s-${s}`, s, { sent_at: "x" });
      expect(await approveDraft(db, "acc1", `s-${s}`, "user1")).toMatchObject({ ok: false, reason: "not_waiting" });
      expect(byId(`s-${s}`).status).toBe(s);
    }
  });

  it("another account cannot approve it", async () => {
    seed("a", "pending_review");
    expect(await approveDraft(db, "acc2", "a", "intruder")).toMatchObject({ ok: false, reason: "not_waiting" });
    expect(byId("a").status).toBe("pending_review");
    expect(byId("a").decided_by).toBeUndefined();
  });

  it("the second of two clicks loses", async () => {
    seed("a", "pending_review");
    const first = await approveDraft(db, "acc1", "a", "user1");
    const second = await approveDraft(db, "acc1", "a", "user2");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(byId("a").decided_by).toBe("user1");
  });
});

describe("moveDraft (the one conditional update every status change goes through)", () => {
  it("moves only if the draft is still in one of the expected statuses", async () => {
    seed("a", "approved");
    expect(await moveDraft(db, { id: "a", from: ["pending_review"], to: "approved" })).toBeNull();
    expect(byId("a").status).toBe("approved");
  });

  it("returns the updated row", async () => {
    seed("a", "pending_review");
    const row = await moveDraft(db, { accountId: "acc1", id: "a", from: ["pending_review"], to: "discarded" });
    expect(row).toMatchObject({ id: "a", status: "discarded" });
  });

  it("with an account, another account's draft is untouched", async () => {
    seed("a", "pending_review");
    expect(await moveDraft(db, { accountId: "acc2", id: "a", from: ["pending_review"], to: "discarded" })).toBeNull();
    expect(byId("a").status).toBe("pending_review");
  });

  it("throws for a move the plan does not allow, before touching anything", async () => {
    seed("a", "sent", { sent_at: "x" });
    await expect(moveDraft(db, { id: "a", from: ["sent"], to: "pending_review" })).rejects.toThrow(/not an allowed move/);
    await expect(moveDraft(db, { id: "a", from: ["pending_review", "sent"], to: "approved" })).rejects.toThrow(/sent -> approved/);
    expect(byId("a").status).toBe("sent");
  });
});

describe("discarding and retrying", () => {
  it("a person can discard a waiting draft or give up on a failed one", async () => {
    seed("a", "pending_review");
    seed("n", "needs_input", { draft_text: null });
    seed("f", "failed");
    for (const id of ["a", "n", "f"]) expect(await discardDraft(db, "acc1", id, "user1")).toMatchObject({ status: "discarded", decided_by: "user1" });
  });

  it("an approved or sent draft cannot be discarded this way", async () => {
    seed("p", "approved");
    seed("s", "sent", { sent_at: "x" });
    expect(await discardDraft(db, "acc1", "p", "user1")).toBeNull();
    expect(await discardDraft(db, "acc1", "s", "user1")).toBeNull();
  });

  it("another account cannot discard it", async () => {
    seed("a", "pending_review");
    expect(await discardDraft(db, "acc2", "a", "intruder")).toBeNull();
    expect(byId("a").status).toBe("pending_review");
  });

  it("a failed send can be retried: back to approved with the error cleared", async () => {
    seed("f", "failed", { error: "Mastodon said no" });
    expect(await retryFailedDraft(db, "acc1", "f", "user1")).toMatchObject({ status: "approved", error: null });
  });

  it("only a failed draft can be retried", async () => {
    seed("a", "pending_review");
    expect(await retryFailedDraft(db, "acc1", "a", "user1")).toBeNull();
  });
});

describe("the sender's side", () => {
  it("only one worker wins an approved draft", async () => {
    seed("a", "approved");
    expect(await claimForSending(db, "a")).toMatchObject({ status: "sending" });
    expect(await claimForSending(db, "a")).toBeNull(); // the second worker must not send
  });

  it("a draft nobody approved cannot be claimed", async () => {
    for (const s of ["pending_review", "needs_input", "sending", "sent", "failed", "discarded", "expired"] as const) {
      seed(`s-${s}`, s);
      expect(await claimForSending(db, `s-${s}`), s).toBeNull();
    }
  });

  it("marks a sent reply with the time and the platform's id", async () => {
    seed("a", "sending", { error: "old" });
    const row = await markSent(db, "a", "platform-77");
    expect(row).toMatchObject({ status: "sent", platform_reply_id: "platform-77", error: null });
    expect(typeof row?.sent_at).toBe("string");
  });

  it("a reply the platform gives no id for is still marked sent", async () => {
    seed("a", "sending");
    expect(await markSent(db, "a", null)).toMatchObject({ status: "sent", platform_reply_id: null });
  });

  it("marks a failed send with a short clean reason", async () => {
    seed("a", "sending");
    expect(await markFailed(db, "a", `Rate limited — ${"x".repeat(400)}`)).toMatchObject({ status: "failed" });
    expect((byId("a").error as string).length).toBe(300);
    expect(byId("a").error as string).not.toContain("—");
  });

  it("sent and failed apply only to a draft that is being sent", async () => {
    seed("a", "approved");
    expect(await markSent(db, "a", "x")).toBeNull();
    expect(await markFailed(db, "a", "x")).toBeNull();
    expect(byId("a").status).toBe("approved");
  });
});

describe("sweeps", () => {
  const now = new Date("2026-10-20T00:00:00.000Z");

  it("expires waiting drafts past their expiry and nothing else", async () => {
    seed("old1", "pending_review", { expires_at: "2026-10-10T00:00:00.000Z" });
    seed("old2", "needs_input", { draft_text: null, expires_at: "2026-10-10T00:00:00.000Z" });
    seed("fresh", "pending_review", { expires_at: "2026-10-25T00:00:00.000Z" });
    seed("appr", "approved", { expires_at: "2026-10-10T00:00:00.000Z" });
    seed("sent", "sent", { sent_at: "x", expires_at: "2026-10-10T00:00:00.000Z" });
    expect(await expireStaleDrafts(db, now)).toBe(2);
    expect(byId("old1").status).toBe("expired");
    expect(byId("old2").status).toBe("expired");
    expect(byId("fresh").status).toBe("pending_review");
    expect(byId("appr").status).toBe("approved");
    expect(byId("sent").status).toBe("sent");
  });

  it("nothing to expire gives zero", async () => {
    expect(await expireStaleDrafts(db, now)).toBe(0);
  });

  it("frees a draft stuck in 'sending' so it is retried, and leaves a fresh one alone", async () => {
    seed("stuck", "sending", { updated_at: "2026-10-19T23:00:00.000Z" });
    seed("busy", "sending", { updated_at: "2026-10-19T23:59:00.000Z" });
    seed("done", "sent", { sent_at: "x", updated_at: "2026-10-19T00:00:00.000Z" });
    expect(await freeStuckSending(db, 10 * 60_000, now)).toBe(1);
    expect(byId("stuck").status).toBe("approved");
    expect(byId("busy").status).toBe("sending");
    expect(byId("done").status).toBe("sent");
  });
});
