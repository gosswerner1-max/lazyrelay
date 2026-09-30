// Client review links end to end: the owner creates a link (plan caps), a client with NO
// login reviews through it, and every way of getting it wrong is refused. supabase is the
// in-memory fake; login, email and sync side effects are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1" }));
const email = vi.hoisted(() => ({ sent: [] as Array<{ to: string; activity: Record<string, unknown> }> }));
vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = auth.accountId;
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("../../googleCalendar/outboundSync.js", () => ({ syncPostToCalendar: async () => {} }));
vi.mock("../../googleSheets/outboundSync.js", () => ({ syncAccountSheet: async () => {} }));
vi.mock("../../email.js", () => ({ sendReviewActivityEmail: (to: string, activity: Record<string, unknown>) => email.sent.push({ to, activity }) }));

const { buildReviewLinksRouter } = await import("./reviewLinks.routes.js");
const { buildReviewPublicRouter } = await import("./reviewPublic.routes.js");
const { generateReviewToken } = await import("../../reviewLinks.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildReviewLinksRouter());
  a.use(buildReviewPublicRouter());
  return a;
};
const DAY = 86_400_000;

function seed(tier = "enterprise") {
  tables.subscriptions = [{ account_id: "acc1", tier, status: "active" }];
  tables.accounts = [{ id: "acc1", email: "owner@agency.co", business_name: "Agency Co" }, { id: "acc2", email: "other@x.co", business_name: "Other" }];
  tables.social_accounts = [
    { id: "ig", account_id: "acc1", platform: "instagram", display_name: "Brand IG", brand_label: "Acme" },
    { id: "fb", account_id: "acc1", platform: "facebook", display_name: "Other FB", brand_label: "Zed" },
  ];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", social_account_id: "ig", content: "Summer sale starts Friday", status: "needs_approval", scheduled_for: new Date(Date.now() + DAY).toISOString(), media_url: null, media_urls: [], options: {}, changes_requested_at: null },
    { id: "p2", account_id: "acc1", social_account_id: "fb", content: "Zed post", status: "needs_approval", scheduled_for: new Date(Date.now() + DAY).toISOString(), media_url: null, media_urls: [], options: {}, changes_requested_at: null },
    { id: "p3", account_id: "acc1", social_account_id: "ig", content: "Already scheduled", status: "pending", scheduled_for: new Date(Date.now() + DAY).toISOString(), media_url: null, media_urls: [], options: {}, changes_requested_at: null },
    { id: "px", account_id: "acc2", social_account_id: "ig", content: "SOMEONE ELSE'S SECRET", status: "needs_approval", scheduled_for: new Date(Date.now() + DAY).toISOString(), media_url: null, media_urls: [], options: {}, changes_requested_at: null },
  ];
  tables.post_review_comments = [];
  tables.review_links = [];
}
const makeLink = (over: Record<string, unknown> = {}) => {
  const row = { id: `l${(tables.review_links ?? []).length + 1}`, account_id: "acc1", token: generateReviewToken(), label: "Acme review", brand_label: null, expires_at: new Date(Date.now() + 10 * DAY).toISOString(), revoked_at: null, last_viewed_at: null, created_at: new Date().toISOString(), ...over };
  tables.review_links.push(row);
  return row as { id: string; token: string };
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  auth.accountId = "acc1";
  email.sent = [];
  seed();
});

describe("owner: links and plan caps", () => {
  it("creates a link with a long random token and a 30 day expiry", async () => {
    const r = await request(app()).post("/review-links").send({ label: "Acme" });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.status).toBe("active");
    const days = (new Date(r.body.expiresAt).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("Free and Starter get 0 links; Pro 1; Business 3", async () => {
    for (const [tier, n] of [["free", 0], ["pro", 0], ["business", 1], ["enterprise", 3]] as const) {
      seed(tier);
      expect((await request(app()).get("/review-links")).body.maxLinks).toBe(n);
    }
    seed("free");
    const blocked = await request(app()).post("/review-links").send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/Pro plan and above/);
  });

  it("only active links count toward the cap, so revoking frees a slot", async () => {
    seed("business"); // 1 link
    const first = (await request(app()).post("/review-links").send({})).body;
    const second = await request(app()).post("/review-links").send({});
    expect(second.status).toBe(403);
    expect((await request(app()).delete(`/review-links/${first.id}`)).body).toEqual({ revoked: true });
    expect((await request(app()).post("/review-links").send({})).status).toBe(201);
  });

  it("refuses a bad expiry and never touches another account's links", async () => {
    expect((await request(app()).post("/review-links").send({ expiresInDays: 0 })).status).toBe(400);
    expect((await request(app()).post("/review-links").send({ expiresInDays: 91 })).status).toBe(400);
    tables.review_links = [{ id: "theirs", account_id: "acc2", token: "t", expires_at: new Date(Date.now() + DAY).toISOString(), revoked_at: null, created_at: new Date().toISOString() }];
    expect((await request(app()).get("/review-links")).body.links).toHaveLength(0);
    expect((await request(app()).delete("/review-links/theirs")).status).toBe(404);
  });
});

describe("client: what the link shows", () => {
  it("shows only the posts waiting for approval on that account", async () => {
    const link = makeLink();
    const r = await request(app()).get(`/public/review/${link.token}`);
    expect(r.status).toBe(200);
    expect(r.body.businessName).toBe("Agency Co");
    expect(r.body.posts.map((p: { id: string }) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(JSON.stringify(r.body)).not.toContain("SOMEONE ELSE'S SECRET");
    expect(JSON.stringify(r.body)).not.toContain("Already scheduled");
    expect(r.body.posts.find((p: { id: string }) => p.id === "p1").state).toBe("waiting");
    // opening the link is recorded (this once silently never happened: the update was created but never sent)
    expect(tables.review_links.find((l) => l.id === (link as { id: string }).id)!.last_viewed_at).toBeTruthy();
  });

  it("a brand link shows only that brand's posts, and refuses to act on another brand's", async () => {
    const link = makeLink({ brand_label: "Acme" });
    const r = await request(app()).get(`/public/review/${link.token}`);
    expect(r.body.posts.map((p: { id: string }) => p.id)).toEqual(["p1"]);
    const sneaky = await request(app()).post(`/public/review/${link.token}/posts/p2/approve`).send({ name: "Sam" });
    expect(sneaky.status).toBe(409);
    expect(tables.scheduled_posts.find((p) => p.id === "p2")!.status).toBe("needs_approval");
  });

  it("a bad, unknown, expired or revoked link all give the same 404", async () => {
    const expired = makeLink({ expires_at: new Date(Date.now() - DAY).toISOString() });
    const revoked = makeLink({ revoked_at: new Date().toISOString() });
    for (const token of ["nope", generateReviewToken(), expired.token, revoked.token]) {
      const r = await request(app()).get(`/public/review/${token}`);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("This review link isn't valid, or it has expired.");
    }
  });
});

describe("client: approving", () => {
  it("moves the post to scheduled, records who approved, and emails the owner", async () => {
    const link = makeLink();
    const r = await request(app()).post(`/public/review/${link.token}/posts/p1/approve`).send({ name: "Sam Client" });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts.find((p) => p.id === "p1")!.status).toBe("pending");
    expect(tables.post_review_comments[0]).toMatchObject({ post_id: "p1", author_kind: "reviewer", author_name: "Sam Client", kind: "approved", review_link_id: link.id });
    expect(email.sent).toEqual([{ to: "owner@agency.co", activity: expect.objectContaining({ action: "approved", reviewer: "Sam Client" }) }]);
    // it stays on the page, marked approved
    const page = await request(app()).get(`/public/review/${link.token}`);
    expect(page.body.posts.find((p: { id: string }) => p.id === "p1").state).toBe("approved");
  });

  it("needs a name; a second approval and a post that is not waiting are refused", async () => {
    const link = makeLink();
    expect((await request(app()).post(`/public/review/${link.token}/posts/p1/approve`).send({})).status).toBe(400);
    await request(app()).post(`/public/review/${link.token}/posts/p1/approve`).send({ name: "Sam" });
    expect((await request(app()).post(`/public/review/${link.token}/posts/p1/approve`).send({ name: "Sam" })).status).toBe(409);
    expect((await request(app()).post(`/public/review/${link.token}/posts/p3/approve`).send({ name: "Sam" })).status).toBe(409);
    expect(email.sent).toHaveLength(1);
  });

  it("can never reach another account's post, even by id", async () => {
    const link = makeLink();
    const r = await request(app()).post(`/public/review/${link.token}/posts/px/approve`).send({ name: "Sam" });
    expect(r.status).toBe(409);
    expect(tables.scheduled_posts.find((p) => p.id === "px")!.status).toBe("needs_approval");
  });

  it("a revoked link can no longer approve", async () => {
    const link = makeLink({ revoked_at: new Date().toISOString() });
    expect((await request(app()).post(`/public/review/${link.token}/posts/p1/approve`).send({ name: "Sam" })).status).toBe(404);
    expect(tables.scheduled_posts.find((p) => p.id === "p1")!.status).toBe("needs_approval");
  });
});

describe("client: asking for changes and commenting", () => {
  it("records the request, flags the post, emails once, and shows it on the page", async () => {
    const link = makeLink();
    const r = await request(app()).post(`/public/review/${link.token}/posts/p1/changes`).send({ name: "Sam", comment: "Please say Saturday, not Friday" });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts.find((p) => p.id === "p1")!.changes_requested_at).toBeTruthy();
    expect(tables.scheduled_posts.find((p) => p.id === "p1")!.status).toBe("needs_approval"); // still not scheduled
    expect(email.sent).toHaveLength(1);
    // a second request straight away does not send a second email
    await request(app()).post(`/public/review/${link.token}/posts/p1/changes`).send({ name: "Sam", comment: "Also the photo" });
    expect(email.sent).toHaveLength(1);
    const page = await request(app()).get(`/public/review/${link.token}`);
    const p1 = page.body.posts.find((p: { id: string }) => p.id === "p1");
    expect(p1.state).toBe("changes_requested");
    expect(p1.comments.map((c: { body: string }) => c.body)).toEqual(["Please say Saturday, not Friday", "Also the photo"]);
  });

  it("a change request needs a comment; plain comments work and are capped", async () => {
    const link = makeLink();
    expect((await request(app()).post(`/public/review/${link.token}/posts/p1/changes`).send({ name: "Sam" })).status).toBe(400);
    expect((await request(app()).post(`/public/review/${link.token}/posts/p1/comments`).send({ name: "Sam", comment: "Nice" })).status).toBe(201);
    expect((await request(app()).post(`/public/review/${link.token}/posts/p1/comments`).send({ name: "Sam", comment: "x".repeat(1001) })).status).toBe(400);
    tables.post_review_comments = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, account_id: "acc1", post_id: "p1", author_kind: "reviewer", author_name: "S", kind: "comment", body: "x", created_at: new Date().toISOString() }));
    const full = await request(app()).post(`/public/review/${link.token}/posts/p1/comments`).send({ name: "Sam", comment: "one more" });
    expect(full.status).toBe(400);
    expect(full.body.error).toMatch(/conversation is full/);
  });

  it("comment text is returned as plain data (the page escapes it), never interpreted", async () => {
    const link = makeLink();
    await request(app()).post(`/public/review/${link.token}/posts/p1/comments`).send({ name: "<b>Sam</b>", comment: "<script>alert(1)</script>" });
    const page = await request(app()).get(`/public/review/${link.token}`);
    const c = page.body.posts.find((p: { id: string }) => p.id === "p1").comments[0];
    expect(c.body).toBe("<script>alert(1)</script>");
    expect(page.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("owner: the conversation", () => {
  it("lists comments and lets the owner reply", async () => {
    const link = makeLink();
    await request(app()).post(`/public/review/${link.token}/posts/p1/comments`).send({ name: "Sam", comment: "Question about the date" });
    const reply = await request(app()).post("/scheduled-posts/p1/review-comments").send({ body: "Friday is right, sale starts then" });
    expect(reply.status).toBe(201);
    const list = await request(app()).get("/scheduled-posts/p1/review-comments");
    expect(list.body.comments.map((c: { authorKind: string; authorName: string }) => `${c.authorKind}:${c.authorName}`)).toEqual(["reviewer:Sam", "owner:Agency Co"]);
    // the client sees the owner's reply
    const page = await request(app()).get(`/public/review/${link.token}`);
    expect(page.body.posts.find((p: { id: string }) => p.id === "p1").comments).toHaveLength(2);
  });

  it("never shows or lets the owner touch another account's post", async () => {
    expect((await request(app()).get("/scheduled-posts/px/review-comments")).status).toBe(404);
    expect((await request(app()).post("/scheduled-posts/px/review-comments").send({ body: "hi" })).status).toBe(404);
  });
});
