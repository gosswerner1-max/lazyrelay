// Whop's dormancy switches and connect routes over HTTP. Login is mocked, supabase is the in-memory fake, Whop is the
// fake from platforms/whopTestKit.ts.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables, vault } from "../../testFakeSupabase.js";
import { APP_ID, APP_PASS, createFakeWhop, freshCompany } from "../../platforms/whopTestKit.js";

let currentAccount = "acc1";
vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = currentAccount;
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
vi.mock("../../accountLimits.js", () => ({ checkAccountLimit: vi.fn(async () => null), checkNewDistinctAccountLimit: vi.fn(async () => null) }));
vi.mock("../../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { buildSocialAccountsRouter } = await import("./socialAccounts.routes.js");
const { WhopAdapter } = await import("../../platforms/whop.js");
const { buildPlatformRegistry } = await import("../../platforms/registry.js");

const names = (body: unknown) => (body as Array<{ platform: string }>).map((p) => p.platform);
let whop: ReturnType<typeof createFakeWhop>;
const withWhop = () => {
  const a = express();
  a.use(express.json());
  a.use(buildSocialAccountsRouter(new Map([["whop", new WhopAdapter(APP_PASS, APP_ID)]]) as never));
  return a;
};
const without = () => {
  const a = express();
  a.use(express.json());
  a.use(buildSocialAccountsRouter(new Map() as never));
  return a;
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  tables.social_accounts = [];
  currentAccount = "acc1";
  whop = createFakeWhop([freshCompany()]);
  vi.stubGlobal("fetch", vi.fn(whop.handler));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ["WHOP_PLATFORM_PUBLIC", "WHOP_TEST_ACCOUNT_IDS", "SLACK_PLATFORM_PUBLIC", "SLACK_TEST_ACCOUNT_IDS", "NOSTR_PLATFORM_PUBLIC", "NOSTR_TEST_ACCOUNT_IDS", "ARTICLE_PLATFORMS_PUBLIC", "ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS", "WHOP_APP_API_KEY", "WHOP_APP_ID"]) delete process.env[k];
});

describe("Whop is dormant until switched on", () => {
  it("is hidden and refused when not configured at all", async () => {
    expect(names((await request(without()).get("/platforms")).body)).not.toContain("whop");
    const c = await request(without()).get("/social-accounts/connect?platform=whop");
    expect(c.status).toBe(400);
    expect(c.body.error).toMatch(/isn't available to connect yet/);
    for (const r of [request(without()).get("/social-accounts/whop/config"), request(without()).post("/social-accounts/whop/challenge").send({ company: "biz_TestCo12345" }), request(without()).post("/social-accounts/whop/verify").send({ challengeId: "x" })]) {
      expect((await r).status).toBe(400);
    }
  });

  it("is still hidden and refused when configured but not switched on (every Whop route)", async () => {
    expect(names((await request(withWhop()).get("/platforms")).body)).not.toContain("whop");
    expect((await request(withWhop()).get("/social-accounts/connect?platform=whop")).body.error).toMatch(/isn't available to connect yet/);
    expect((await request(withWhop()).get("/social-accounts/whop/config")).status).toBe(400);
    expect((await request(withWhop()).post("/social-accounts/whop/challenge").send({ company: "biz_TestCo12345" })).status).toBe(400);
    expect(whop.calls).toHaveLength(0); // nothing reached Whop
  });

  it("the Slack, Nostr and article-platform switches do not open it", async () => {
    for (const k of ["SLACK_PLATFORM_PUBLIC", "NOSTR_PLATFORM_PUBLIC", "ARTICLE_PLATFORMS_PUBLIC"]) process.env[k] = "true";
    for (const k of ["SLACK_TEST_ACCOUNT_IDS", "NOSTR_TEST_ACCOUNT_IDS", "ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS"]) process.env[k] = "acc1";
    expect(names((await request(withWhop()).get("/platforms")).body)).not.toContain("whop");
    expect((await request(withWhop()).get("/social-accounts/whop/config")).status).toBe(400);
  });

  it("a named test account sees it, other accounts do not, and WHOP_PLATFORM_PUBLIC opens it to everyone", async () => {
    process.env.WHOP_TEST_ACCOUNT_IDS = "x, acc1";
    expect(names((await request(withWhop()).get("/platforms")).body)).toContain("whop");
    currentAccount = "acc9";
    expect(names((await request(withWhop()).get("/platforms")).body)).not.toContain("whop");
    delete process.env.WHOP_TEST_ACCOUNT_IDS;
    process.env.WHOP_PLATFORM_PUBLIC = "true";
    expect(names((await request(withWhop()).get("/platforms")).body)).toContain("whop");
    expect(names((await request(without()).get("/platforms")).body)).not.toContain("whop"); // never without the adapter
  });

  it("is only registered when both WHOP_APP_API_KEY and a well formed WHOP_APP_ID are set", () => {
    expect(buildPlatformRegistry().has("whop")).toBe(false);
    process.env.WHOP_APP_API_KEY = APP_PASS;
    expect(buildPlatformRegistry().has("whop")).toBe(false);
    process.env.WHOP_APP_ID = "not-an-app-id";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildPlatformRegistry().has("whop")).toBe(false);
    process.env.WHOP_APP_ID = APP_ID;
    expect(buildPlatformRegistry().has("whop")).toBe(true);
  });

  it("the generic connect route never starts a Whop connection, even when Whop is on", async () => {
    process.env.WHOP_PLATFORM_PUBLIC = "true";
    const r = await request(withWhop()).get("/social-accounts/connect?platform=whop");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/own connect dialog/);
  });
});

describe("Whop connect over HTTP", () => {
  it("serves the install link (built from the backend's app id) and never the key", async () => {
    process.env.WHOP_PLATFORM_PUBLIC = "true";
    const r = await request(withWhop()).get("/social-accounts/whop/config");
    expect(r.body).toEqual({ installUrl: `https://whop.com/apps/${APP_ID}/install` });
  });

  it("challenge, admin post, verify and pick work end to end, and no response ever carries the key", async () => {
    process.env.WHOP_PLATFORM_PUBLIC = "true";
    const seen: string[] = [];
    const app = withWhop();
    const challenge = await request(app).post("/social-accounts/whop/challenge").send({ company: "https://whop.com/dashboard/biz_TestCo12345/" });
    seen.push(JSON.stringify(challenge.body));
    expect(challenge.status).toBe(200);
    whop.addPost("exp_ForumOne1234", `proof ${challenge.body.code}`, { admin: true, user: "owner" });
    const verified = await request(app).post("/social-accounts/whop/verify").send({ challengeId: challenge.body.challengeId });
    seen.push(JSON.stringify(verified.body));
    expect(verified.status).toBe(200);
    const pending = await request(app).get(`/social-accounts/pending-selection/${verified.body.selectionToken}`);
    seen.push(JSON.stringify(pending.body));
    expect(pending.body).toMatchObject({ platform: "whop", singleSelection: true });
    expect(seen.join("")).not.toContain(APP_PASS);
  });

  it("a member's copy of the code is refused over HTTP, and bad input gets a plain 400", async () => {
    process.env.WHOP_PLATFORM_PUBLIC = "true";
    const app = withWhop();
    const challenge = await request(app).post("/social-accounts/whop/challenge").send({ company: "biz_TestCo12345" });
    whop.addPost("exp_ForumOne1234", challenge.body.code, { admin: false, user: "member" });
    const r = await request(app).post("/social-accounts/whop/verify").send({ challengeId: challenge.body.challengeId });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/owner or admin/);
    expect((await request(app).post("/social-accounts/whop/challenge").send({})).status).toBe(400);
    expect((await request(app).post("/social-accounts/whop/challenge").send({ company: "hello" })).status).toBe(400);
    expect((await request(app).post("/social-accounts/whop/verify").send({ challengeId: 5 })).status).toBe(400);
  });

  it("is in the rules lookup: 4,000 characters, text only, no media", async () => {
    const r = await request(without()).get("/platforms/rules?platform=whop");
    expect(r.body.platforms[0]).toMatchObject({ platform: "whop", text: { maxLength: 4000 }, media: { textOnlyAllowed: true, image: { supported: false }, video: { supported: false } } });
    expect(r.body.platforms[0].text.note).toMatch(/LazyRelay's own conservative number/);
  });
});

describe("scheduling a Whop post", () => {
  const tomorrow = () => new Date(Date.now() + 24 * 3600_000).toISOString();
  it("refuses text over LazyRelay's 4,000 character number up front, and accepts text exactly at it", async () => {
    const { validatePostFields } = await import("../../postCreation.js");
    tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform: "whop" }];
    const over = await validatePostFields("acc1", { socialAccountId: "sa1", content: "x".repeat(4001), scheduledFor: tomorrow() });
    expect(over).toMatchObject({ status: 400, body: { error: "Whop posts can be up to 4,000 characters" } });
    const ok = await validatePostFields("acc1", { socialAccountId: "sa1", content: "x".repeat(4000), scheduledFor: tomorrow() });
    expect("status" in ok).toBe(false);
  });
});
