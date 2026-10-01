// WhopAdapter against an in-memory fake Whop (whopTestKit.ts): posting, proof of publish, id checks, error wording,
// rate limits, idempotency, and that the app credential never leaks. No real network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APP_ID, APP_PASS, createFakeWhop, freshCompany } from "./whopTestKit.js";

vi.mock("../supabase.js", () => ({ supabase: {} }));
const { WhopAdapter, normalizeWhopText, parseWhopAccountId, parseWhopPostId } = await import("./whop.js");
const { parseRateLimitDelay, whopPostUrl, WHOP_API_VERSION_DATE, WHOP_TEXT_LIMIT } = await import("./whopApi.js");
const { classifyPostError } = await import("../postErrors.js");

const ACCOUNT = "biz_TestCo12345:exp_ForumOne1234";
let whop: ReturnType<typeof createFakeWhop>;
let adapter: InstanceType<typeof WhopAdapter>;
let logs: string[];

const request = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", platformAccountId: ACCOUNT, content: "Hello **community**", mediaUrl: null, coverImageUrl: null, accessToken: "placeholder", scheduledPostId: "p1", ...over }) as never;

beforeEach(() => {
  whop = createFakeWhop([freshCompany()]);
  vi.stubGlobal("fetch", vi.fn(whop.handler));
  adapter = new WhopAdapter(APP_PASS, APP_ID);
  logs = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("posting", () => {
  it("creates a top-level forum post and returns an id that carries company, forum, post and a text fingerprint", async () => {
    const r = await adapter.post(request());
    expect(r.success).toBe(true);
    const parsed = parseWhopPostId(r.platformPostId!);
    expect(parsed).toMatchObject({ companyId: "biz_TestCo12345", experienceId: "exp_ForumOne1234" });
    const call = whop.callsTo("POST", "/forum_posts")[0];
    expect(call.body).toEqual({ experience_id: "exp_ForumOne1234", content: "Hello **community**" }); // no is_mention, no title
    expect(call.url.startsWith("https://api.whop.com/api/v1/forum_posts")).toBe(true);
  });

  it("sends the bearer credential, the dated API version and an idempotency key on every call", async () => {
    await adapter.post(request());
    for (const c of whop.calls) {
      expect(c.headers.authorization).toBe(`Bearer ${APP_PASS}`);
      expect(c.headers["api-version-date"]).toBe(WHOP_API_VERSION_DATE);
    }
    expect(whop.callsTo("POST", "/forum_posts")[0].headers["idempotency-key"]).toBe("lazyrelay-post-p1");
  });

  it("ignores the token it is handed: the app credential comes from the adapter, not the account row", async () => {
    const r = await adapter.post(request({ accessToken: "whatever-is-stored-on-the-row" }));
    expect(r.success).toBe(true);
    expect(JSON.stringify(whop.calls)).not.toContain("whatever-is-stored-on-the-row");
  });

  it("a retry after a lost answer reuses the same key, so Whop replays the stored post instead of creating a second", async () => {
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status: 0, afterEffect: true });
    const first = await adapter.post(request());
    expect(first.success).toBe(false);
    expect(first.errorMessage).toMatch(/Could not reach Whop/);
    const second = await adapter.post(request());
    expect(second.success).toBe(true);
    const keys = whop.callsTo("POST", "/forum_posts").map((c) => c.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(1);
    expect(whop.posts.get("exp_ForumOne1234")).toHaveLength(1); // ONE post exists
  });

  it("a rate-limited attempt rotates the key (Whop replays stored errors), a lost answer does not", async () => {
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status: 429, body: { error: { type: "rate_limit_exceeded", message: "Try again in 12 seconds." } } });
    const limited = await adapter.post(request());
    expect(limited.success).toBe(false);
    expect(limited.errorMessage).toMatch(/whop_rate_limited/);
    expect(limited.errorMessage).toMatch(/wait 12 seconds/);
    const retry = await adapter.post(request());
    expect(retry.success).toBe(true);
    const keys = whop.callsTo("POST", "/forum_posts").map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["lazyrelay-post-p1", "lazyrelay-post-p1-r1"]);
  });

  it("refuses media, empty text and text over LazyRelay's 4,000 character limit before calling Whop", async () => {
    expect((await adapter.post(request({ mediaUrl: "https://example.org/a.png" }))).errorMessage).toMatch(/whop_text_only/);
    expect((await adapter.post(request({ content: "  \n " }))).errorMessage).toMatch(/whop_empty/);
    expect((await adapter.post(request({ content: "a".repeat(WHOP_TEXT_LIMIT + 1) }))).errorMessage).toMatch(/whop_too_long/);
    expect((await adapter.post(request({ content: "a".repeat(WHOP_TEXT_LIMIT) }))).success).toBe(true);
    expect(whop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a connection with no valid saved forum, or an injected path, fails without calling Whop", async () => {
    for (const bad of [null, "", "biz_TestCo12345", "biz_TestCo12345:exp_x/../../admin", "biz_TestCo12345:exp_ForumOne1234:extra", "../biz_TestCo12345:exp_ForumOne1234"]) {
      const r = await adapter.post(request({ platformAccountId: bad }));
      expect(r.success).toBe(false);
    }
    expect(whop.calls).toHaveLength(0);
  });

  it("customer text cannot become a mention: <@ is broken with an invisible space, and the read-back still matches", async () => {
    const r = await adapter.post(request({ content: "hi <@someone> and <@all>" }));
    expect(r.success).toBe(true);
    const sent = String(whop.callsTo("POST", "/forum_posts")[0].body?.content);
    expect(sent).not.toContain("<@");
    expect(sent).toContain("<​@someone>");
    expect((await adapter.verifyPublished(r.platformPostId!)).verifiedLive).toBe(true);
    expect(normalizeWhopText("a\r\nb\r\n")).toBe("a\nb");
  });
});

describe("proof of publish", () => {
  it("is live only after GET /forum_posts/{id} shows the same id, a null parent and the same text, and links to the post", async () => {
    const r = await adapter.post(request());
    const v = await adapter.verifyPublished(r.platformPostId!);
    expect(v.verifiedLive).toBe(true);
    const parsed = parseWhopPostId(r.platformPostId!)!;
    expect(v.platformPostUrl).toBe(`https://whop.com/lazyrelay-test/exp_ForumOne1234/app/posts/${parsed.postId}/`);
    expect(whop.callsTo("GET", `/forum_posts/${parsed.postId}`)).toHaveLength(1);
  });

  it("a different text, a comment instead of a post, or a missing post is unconfirmed, never live", async () => {
    const r = await adapter.post(request());
    const parsed = parseWhopPostId(r.platformPostId!)!;
    const stored = whop.posts.get("exp_ForumOne1234")![0];

    stored.content = "Something else entirely";
    expect((await adapter.verifyPublished(r.platformPostId!)).errorMessage).toMatch(/whop_unconfirmed/);
    stored.content = "Hello **community**";
    stored.parent_id = "post_Other00001";
    expect((await adapter.verifyPublished(r.platformPostId!)).errorMessage).toMatch(/whop_unconfirmed.*comment/);
    stored.parent_id = null;
    whop.posts.set("exp_ForumOne1234", []);
    const gone = await adapter.verifyPublished(r.platformPostId!);
    expect(gone.verifiedLive).toBe(false);
    expect(gone.errorMessage).toMatch(/whop_unconfirmed/);
    expect(parsed.postId).toBeTruthy();
  });

  it("a read-back that fails with a permission error is reported as such, not as confirmed", async () => {
    const r = await adapter.post(request());
    whop.scripted.push({ match: (m, p) => m === "GET" && p.startsWith("/forum_posts/"), status: 403, body: { error: { message: "no" } } });
    const v = await adapter.verifyPublished(r.platformPostId!);
    expect(v.verifiedLive).toBe(false);
    expect(v.errorMessage).toMatch(/whop_forbidden/);
  });

  it("a malformed post id is refused before any call", async () => {
    for (const bad of ["", "post_x", "biz_TestCo12345:exp_ForumOne1234:post_Test000001", "biz_TestCo12345:exp_ForumOne1234:post_/../x:aaaaaaaaaaaaaaaa", "biz_TestCo12345:exp_ForumOne1234:post_Test000001:XYZ"]) {
      expect((await adapter.verifyPublished(bad)).verifiedLive).toBe(false);
    }
    expect(whop.calls).toHaveLength(0);
  });

  it("is still confirmed (without a link) when the community route cannot be read", async () => {
    const r = await adapter.post(request());
    whop.scripted.push({ match: (m, p) => m === "GET" && p === "/experiences", status: 500, body: {} });
    const v = await adapter.verifyPublished(r.platformPostId!);
    expect(v.verifiedLive).toBe(true);
    expect(v.platformPostUrl).toBeNull();
  });
});

describe("error mapping (status -> what the scheduler does and what the customer reads)", () => {
  const post = async (status: number, body: unknown = {}) => {
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status, body });
    const r = await adapter.post(request());
    return { raw: r.errorMessage!, classified: classifyPostError("whop", r.errorMessage!) };
  };

  it("401, 403 and 404 on posting need a reconnect, in plain words", async () => {
    for (const status of [401, 403, 404]) {
      const { classified } = await post(status);
      expect(classified.kind).toBe("reconnect");
      expect(classified.message).toMatch(/Whop says LazyRelay no longer has permission in this community/);
      expect(classified.message).toMatch(/Reinstall the LazyRelay app/);
    }
  });

  it("429 is retryable and the delay is read from the body", async () => {
    const { raw, classified } = await post(429, { error: { type: "rate_limit_exceeded", message: "Try again in 12 seconds." } });
    expect(classified.kind).toBe("retry");
    expect(raw).toMatch(/12 seconds/);
    expect(parseRateLimitDelay("Try again in 12 seconds.")).toBe(12);
    expect(parseRateLimitDelay("nothing", "30")).toBe(30);
    expect(parseRateLimitDelay("Try again in 999999 seconds.")).toBe(3600);
    expect(parseRateLimitDelay("soon")).toBeNull();
  });

  it("422 (verification required) is not retried and shows Whop's message", async () => {
    const { classified } = await post(422, { error: { code: "verification_required", message: "Verification required before posting." } });
    expect(classified.kind).toBe("fatal");
    expect(classified.message).toMatch(/Verification required before posting/);
  });

  it("409 and 5xx are retried", async () => {
    for (const status of [409, 500, 502, 503]) expect((await post(status)).classified.kind).toBe("retry");
  });

  it("a network failure is retried and never quotes the raw error", async () => {
    whop.scripted.push({ match: () => true, status: 0, networkError: true });
    const r = await adapter.post(request());
    expect(classifyPostError("whop", r.errorMessage!).kind).toBe("retry");
    expect(r.errorMessage).not.toMatch(/socket/);
  });

  it("a 404 while confirming is a retry, never a reconnect", () => {
    expect(classifyPostError("whop", "Whop post whop_unconfirmed (Whop does not show the post yet)").kind).toBe("retry");
  });
});

describe("secrets and safety", () => {
  it("the app credential is never in a log, an error, the adapter's JSON, or anything returned", async () => {
    whop.scripted.push({ match: (m, p) => m === "POST" && p === "/forum_posts", status: 422, body: { error: { message: `bad ${APP_PASS} value` } } });
    const failed = await adapter.post(request());
    const ok = await adapter.post(request({ scheduledPostId: "p2" }));
    const v = await adapter.verifyPublished(ok.platformPostId!);
    await adapter.listConnectOptions().catch((e) => logs.push(String(e)));
    const everything = JSON.stringify([failed, ok, v, adapter, logs, adapter.installUrl]);
    expect(everything).not.toContain(APP_PASS);
    expect(failed.errorMessage).toMatch(/\[removed\]/);
  });

  it("only ever talks to https://api.whop.com, refuses redirects, and has a timeout", async () => {
    await adapter.post(request());
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeTruthy();
    for (const c of whop.calls) expect(c.url.startsWith("https://api.whop.com/api/v1/")).toBe(true);
  });

  it("ids are validated with strict patterns", () => {
    expect(parseWhopAccountId("biz_TestCo12345:exp_ForumOne1234")).toBeTruthy();
    for (const bad of ["biz_/x:exp_ab12", "biz_TestCo12345:exp_a b", "biz_TestCo12345:post_ab123", "BIZ_TestCo12345:exp_ForumOne1234", "biz_TestCo12345:exp_ForumOne1234\n"]) {
      expect(parseWhopAccountId(bad)).toBeNull();
    }
    expect(whopPostUrl("../evil", "exp_ForumOne1234", "post_Test000001")).toBeNull();
    expect(whopPostUrl("ok-route", "exp_ForumOne1234", "post_Test000001")).toBe("https://whop.com/ok-route/exp_ForumOne1234/app/posts/post_Test000001/");
  });

  it("a hostile oversized answer is capped, not buffered whole", async () => {
    const big = "x".repeat(2_000_000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: big } }), { status: 422 })));
    const r = await adapter.post(request());
    expect(r.success).toBe(false);
    expect(String(r.errorMessage).length).toBeLessThan(600);
  });

  it("a bad app id stops the adapter being built", () => {
    expect(() => new WhopAdapter(APP_PASS, "not-an-app")).toThrow();
    expect(adapter.installUrl).toBe(`https://whop.com/apps/${APP_ID}/install`);
  });
});

describe("forum listing", () => {
  it("lists only forums (by app name), only the requested community's, across pages, with a readable label", async () => {
    const company = freshCompany();
    for (let i = 0; i < 25; i++) company.experiences.push({ id: `exp_Course${String(i).padStart(4, "0")}`, name: `Course ${i}`, appName: "Courses" });
    whop = createFakeWhop([company]);
    vi.stubGlobal("fetch", vi.fn(whop.handler));
    const list = await adapter.api.listForums("biz_TestCo12345");
    expect(list.forums.map((f) => f.id)).toEqual(["exp_ForumOne1234", "exp_ForumTwo1234"]);
    expect(list.forums[0].label).toBe("Forums (Lazyrelay)");
    expect(whop.callsTo("GET", "/experiences").length).toBeGreaterThan(1); // it followed the cursor
    expect(list.companyRoute).toBe("lazyrelay-test");
  });

  it("a community that has not installed the app is refused (403) and nothing is listed", async () => {
    whop.setInstalled("biz_TestCo12345", false);
    await expect(adapter.api.listForums("biz_TestCo12345")).rejects.toMatchObject({ code: "whop_forbidden" });
    await expect(adapter.api.listForums("not-an-id")).rejects.toMatchObject({ code: "whop_bad_request" });
  });
});
