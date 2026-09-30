// Lemmy adapter: instance handling, login, v3/v4 detection, posting, honest verification.
// fetch and the SSRF guard are stubbed; nothing real is called and no real credentials appear.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../urlSafety.js", () => ({
  isSafeMediaUrl: vi.fn(async (url: string) =>
    new URL(url).hostname.startsWith("internal")
      ? { safe: false, reason: "must not point at a private, internal, or reserved address" }
      : { safe: true, addresses: ["93.184.216.34"] },
  ),
}));

import { LemmyAdapter, normalizeLemmyInstance, deriveLemmyText } from "./lemmy.js";

const PASSWORD = "hunter2-not-real";
const JWT = "jwt-secret-value-123";
const ORIGIN = "https://lemmy.example";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;

let calls: Array<{ url: string; init: RequestInit }>;
let handlers: Handler[];

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  calls = [];
  handlers = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    for (const h of handlers) {
      const r = await h(url, init);
      if (r) return r;
    }
    return reply(404, { error: "not_found" });
  });
});
afterEach(() => vi.unstubAllGlobals());

const adapter = () => new LemmyAdapter("https://app.example/connect/lemmy");
const on = (h: Handler) => handlers.push(h);

const SITE_OK = { site_view: { site: { name: "x" } }, version: "0.19.19" };
const isSite = (v: number) => (u: string) => u === `${ORIGIN}/api/v${v}/site`;

/** A v3 (or v4) instance where login works and /site (with a bearer) returns my_user. */
function lemmyServer(v: 3 | 4, opts: { bot?: boolean } = {}) {
  on((url, init) => {
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    if (url === `${ORIGIN}/api/v${v}/site`) {
      return reply(200, auth ? { ...SITE_OK, my_user: { local_user_view: { person: { name: "alice", bot_account: opts.bot ?? true } } } } : SITE_OK);
    }
    if (url === `${ORIGIN}/api/v${v}${v === 4 ? "/account/auth/login" : "/user/login"}`) {
      return reply(200, { jwt: JWT, registration_created: false, verify_email_sent: false });
    }
    return undefined;
  });
}

const connectJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ instance: "lemmy.example", username: "alice", password: PASSWORD, ...over });

const creds = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ instance: ORIGIN, apiVersion: 3, jwt: JWT, username: "alice", community: "programming@programming.dev", ...over });

const req = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "Hello Lemmy\nThe body text.", mediaUrl: null, coverImageUrl: null, accessToken: creds(), ...over }) as never;

const noSecrets = (text: string | null) => {
  expect(text ?? "").not.toContain(PASSWORD);
  expect(text ?? "").not.toContain(JWT);
};

describe("instance normalisation and SSRF", () => {
  it("accepts a bare host or an https origin", () => {
    expect(normalizeLemmyInstance("Lemmy.World")).toEqual({ ok: true, origin: "https://lemmy.world" });
    expect(normalizeLemmyInstance("https://lemmy.world/")).toEqual({ ok: true, origin: "https://lemmy.world" });
    expect(normalizeLemmyInstance("https://lemmy.world:443")).toEqual({ ok: true, origin: "https://lemmy.world" });
  });

  it.each([
    "http://lemmy.world",
    "https://lemmy.world/c/tech",
    "https://user:pw@lemmy.world",
    "https://lemmy.world:8443",
    "https://lemmy.world/?x=1",
    "ftp://lemmy.world",
    "not a host",
    "localhost",
    "",
  ])("refuses %s", (input) => {
    expect(normalizeLemmyInstance(input).ok).toBe(false);
  });

  it("blocks an internal address before any request is made", async () => {
    await expect(adapter().exchangeCode(connectJson({ instance: "internal.example" }))).rejects.toThrow(/not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("blocks an internal address at post time too", async () => {
    const r = await adapter().post(req({ accessToken: creds({ instance: "https://internal.example" }) }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/not allowed/);
    expect(calls).toHaveLength(0);
  });
});

describe("connecting", () => {
  it("logs in on v3, stores the JWT and not the password, and names the account", async () => {
    lemmyServer(3);
    on((url) => (url.includes("/api/v3/community") ? reply(200, { community_view: { community: { id: 1 } } }) : undefined));
    const r = await adapter().exchangeCode(connectJson({ community: "!programming@programming.dev" }));
    expect(r).toMatchObject({ refreshToken: null, expiresAt: null, platformAccountId: "alice@lemmy.example", displayName: "@alice@lemmy.example" });
    expect(JSON.parse(r.accessToken)).toEqual({ instance: ORIGIN, apiVersion: 3, jwt: JWT, username: "alice", community: "programming@programming.dev" });
    expect(r.accessToken).not.toContain(PASSWORD);
    const login = calls.find((c) => c.url.endsWith("/api/v3/user/login"))!;
    expect(JSON.parse(String(login.init.body))).toEqual({ username_or_email: "alice", password: PASSWORD });
  });

  it("sends the 2FA code when one is given", async () => {
    lemmyServer(3);
    await adapter().exchangeCode(connectJson({ totpToken: "123456" }));
    const login = calls.find((c) => c.url.endsWith("/user/login"))!;
    expect(JSON.parse(String(login.init.body)).totp_2fa_token).toBe("123456");
  });

  it("still connects when the account is not flagged as a bot", async () => {
    lemmyServer(3, { bot: false });
    await expect(adapter().exchangeCode(connectJson())).resolves.toMatchObject({ platformAccountId: "alice@lemmy.example" });
  });

  it("detects v4 when v3 does not answer, and uses the v4 login route", async () => {
    lemmyServer(4);
    const r = await adapter().exchangeCode(connectJson());
    expect(JSON.parse(r.accessToken).apiVersion).toBe(4);
    const login = calls.find((c) => c.url.endsWith("/api/v4/account/auth/login"))!;
    expect(JSON.parse(String(login.init.body)).stay_logged_in).toBe(true);
  });

  it("prefers v3 when both answer", async () => {
    lemmyServer(3);
    lemmyServer(4);
    expect(JSON.parse((await adapter().exchangeCode(connectJson())).accessToken).apiVersion).toBe(3);
  });

  it("says so when the address is not a Lemmy instance", async () => {
    on((url) => (url.endsWith("/site") ? reply(200, { hello: "world" }) : undefined));
    await expect(adapter().exchangeCode(connectJson())).rejects.toThrow(/did not answer like a Lemmy instance/);
  });

  it("says so when the instance is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(`connect ECONNREFUSED with token ${JWT}`);
    });
    const err = await adapter().exchangeCode(connectJson()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Could not reach lemmy.example/);
    noSecrets((err as Error).message);
  });

  it.each([
    ["incorrect_login", 400, /username or password is wrong/],
    ["missing_totp_token", 400, /two factor/],
    ["incorrect_totp_token", 400, /two factor code was wrong/],
    ["email_not_verified", 400, /Verify your email/],
    ["registration_application_pending", 400, /waiting for approval/],
    ["site_ban", 400, /banned/],
  ])("explains login failure %s", async (code, status, message) => {
    on((url) => (isSite(3)(url) ? reply(200, SITE_OK) : undefined));
    on((url) => (url.endsWith("/user/login") ? reply(status, { error: code }) : undefined));
    const err = (await adapter().exchangeCode(connectJson()).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(message);
    noSecrets(err.message);
  });

  it("explains a pending registration or verification that returns 200 without a token", async () => {
    on((url) => (isSite(3)(url) ? reply(200, SITE_OK) : undefined));
    on((url) => (url.endsWith("/user/login") ? reply(200, { registration_created: true, verify_email_sent: false }) : undefined));
    await expect(adapter().exchangeCode(connectJson())).rejects.toThrow(/waiting for approval/);
  });

  it("gives a retry hint on HTTP 429", async () => {
    on((url) => (isSite(3)(url) ? reply(200, SITE_OK) : undefined));
    on((url) => (url.endsWith("/user/login") ? reply(429, {}, { "retry-after": "42" }) : undefined));
    await expect(adapter().exchangeCode(connectJson())).rejects.toThrow(/42 seconds/);
  });

  it("refuses a default community that does not exist", async () => {
    lemmyServer(3);
    on((url) => (url.includes("/api/v3/community") ? reply(400, { error: "couldnt_find_community" }) : undefined));
    await expect(adapter().exchangeCode(connectJson({ community: "nope" }))).rejects.toThrow(/could not find the community/);
  });

  it("refuses a malformed request without echoing the password", async () => {
    const err = (await adapter().exchangeCode("{not json").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/needs an instance/);
    noSecrets(err.message);
  });

  it("builds the connect page link", async () => {
    expect(await adapter().getAuthorizeUrl("abc")).toBe("https://app.example/connect/lemmy?state=abc");
    expect(adapter().skipConnectConfirmation).toBe(true);
  });
});

describe("title and body", () => {
  it("uses the first line as the title and the rest as the body", () => {
    expect(deriveLemmyText("# Big news\n\nLine one\nLine two", undefined)).toEqual({ title: "Big news", body: "Line one\nLine two" });
  });
  it("skips leading blank lines and lone hashes", () => {
    expect(deriveLemmyText("\n\n##\n  Real title\nrest", undefined)).toEqual({ title: "Real title", body: "rest" });
  });
  it("options.title wins and the full content is the body", () => {
    expect(deriveLemmyText("Just text", "My title")).toEqual({ title: "My title", body: "Just text" });
  });
  it("cuts an over-long first line to 200 characters and keeps the full text in the body", () => {
    const long = `${"word ".repeat(60)}end`;
    const r = deriveLemmyText(long, undefined) as { title: string; body: string };
    expect(r.title.length).toBeLessThanOrEqual(200);
    expect(r.title.endsWith("...")).toBe(true);
    expect(r.body).toBe(long);
  });
  it("needs some text or a title", () => {
    expect(deriveLemmyText("  \n ", undefined)).toHaveProperty("error");
  });
});

describe("posting", () => {
  function postServer() {
    on((url) => (url.startsWith(`${ORIGIN}/api/v3/community`) ? reply(200, { community_view: { community: { id: 77, removed: false, deleted: false } } }) : undefined));
    on((url, init) => (url === `${ORIGIN}/api/v3/post` && init.method === "POST" ? reply(200, { post_view: { post: { id: 5150 } } }) : undefined));
  }
  const postBody = () => JSON.parse(String(calls.find((c) => c.url === `${ORIGIN}/api/v3/post` && c.init.method === "POST")!.init.body));

  it("resolves the default community and creates a text post", async () => {
    postServer();
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "5150", errorMessage: null });
    const community = calls.find((c) => c.url.includes("/community"))!;
    expect(new URL(community.url).searchParams.get("name")).toBe("programming@programming.dev");
    expect(postBody()).toEqual({ name: "Hello Lemmy", community_id: 77, body: "The body text." });
    expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`);
    expect("honeypot" in postBody()).toBe(false);
  });

  it("options.community overrides the saved one; url and nsfw are passed on", async () => {
    postServer();
    await adapter().post(req({ options: { lemmy: { community: "rust@programming.dev", url: "https://example.org/a", nsfw: true, title: "T" } } }));
    expect(new URL(calls.find((c) => c.url.includes("/community"))!.url).searchParams.get("name")).toBe("rust@programming.dev");
    expect(postBody()).toMatchObject({ name: "T", url: "https://example.org/a", nsfw: true });
  });

  it("fails clearly when no community is set anywhere", async () => {
    const r = await adapter().post(req({ accessToken: creds({ community: undefined }) }));
    expect(r.errorMessage).toMatch(/Choose a Lemmy community/);
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when the community cannot be found", async () => {
    on((url) => (url.includes("/community") ? reply(400, { error: "couldnt_find_community" }) : undefined));
    expect((await adapter().post(req())).errorMessage).toMatch(/could not find the community/);
  });

  it("fails clearly beyond the 10000 character body limit", async () => {
    postServer();
    const r = await adapter().post(req({ content: `Title\n${"a".repeat(10_001)}` }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/10000/);
  });

  it("uploads an image to pict-rs and makes it the post link, with alt text", async () => {
    postServer();
    on((url) => (url === "https://media.example/pic.png" ? new Response("PNGDATA", { status: 200, headers: { "content-type": "image/png", "content-length": "7" } }) : undefined));
    on((url, init) => {
      if (url !== `${ORIGIN}/pictrs/image`) return undefined;
      expect(init.method).toBe("POST");
      const h = init.headers as Record<string, string>;
      expect(h["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
      expect(h.Authorization).toBe(`Bearer ${JWT}`);
      expect(h.Cookie).toBe(`jwt=${JWT}`);
      return reply(200, { msg: "ok", files: [{ file: "abc123.png", delete_token: "tok" }] });
    });
    const r = await adapter().post(req({ mediaUrl: "https://media.example/pic.png", mediaAltText: "A red [square]" }));
    expect(r.success).toBe(true);
    expect(postBody()).toMatchObject({ url: `${ORIGIN}/pictrs/image/abc123.png`, alt_text: "A red square" });
  });

  it("puts the image in the body when options.url is already the link, and extra images follow", async () => {
    postServer();
    on((url) => (url.startsWith("https://media.example/") ? new Response("X", { status: 200, headers: { "content-type": "image/jpeg", "content-length": "1" } }) : undefined));
    let n = 0;
    on((url) => (url === `${ORIGIN}/pictrs/image` ? reply(200, { msg: "ok", files: [{ file: `f${++n}.jpg` }] }) : undefined));
    await adapter().post(
      req({ mediaUrl: "https://media.example/1.jpg", mediaUrls: ["https://media.example/2.jpg"], mediaAltText: "First", options: { lemmy: { url: "https://example.org/x" } } }),
    );
    const body = postBody();
    expect(body.url).toBe("https://example.org/x");
    expect(body.alt_text).toBeUndefined();
    expect(body.body).toContain(`![First](${ORIGIN}/pictrs/image/f1.jpg)`);
    expect(body.body).toContain(`![](${ORIGIN}/pictrs/image/f2.jpg)`);
  });

  it("uses the v4 image route and answer", async () => {
    on((url) => (url.startsWith(`${ORIGIN}/api/v4/community`) ? reply(200, { community_view: { community: { id: 9 } } }) : undefined));
    on((url) => (url === "https://media.example/p.webp" ? new Response("X", { status: 200, headers: { "content-type": "image/webp", "content-length": "1" } }) : undefined));
    on((url) => (url === `${ORIGIN}/api/v4/image` ? reply(200, { image_url: `${ORIGIN}/api/v4/image/abc.webp`, filename: "abc.webp" }) : undefined));
    on((url, init) => (url === `${ORIGIN}/api/v4/post` && init.method === "POST" ? reply(200, { post_view: { post: { id: 12 } } }) : undefined));
    const r = await adapter().post(req({ accessToken: creds({ apiVersion: 4 }), mediaUrl: "https://media.example/p.webp" }));
    expect(r.platformPostId).toBe("12");
    const sent = JSON.parse(String(calls.find((c) => c.url === `${ORIGIN}/api/v4/post` && c.init.method === "POST")!.init.body));
    expect(sent.url).toBe(`${ORIGIN}/api/v4/image/abc.webp`);
  });

  it("refuses video before any request", async () => {
    const r = await adapter().post(req({ mediaUrl: "https://media.example/clip.mp4" }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/does not support video/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a video that is only recognisable by its content type", async () => {
    postServer();
    on((url) => (url === "https://media.example/blob" ? new Response("X", { status: 200, headers: { "content-type": "video/mp4", "content-length": "1" } }) : undefined));
    expect((await adapter().post(req({ mediaUrl: "https://media.example/blob" }))).errorMessage).toMatch(/does not support video/);
  });

  it("does not create the post when an upload fails", async () => {
    postServer();
    on((url) => (url === "https://media.example/pic.png" ? new Response("X", { status: 200, headers: { "content-type": "image/png", "content-length": "1" } }) : undefined));
    on((url) => (url === `${ORIGIN}/pictrs/image` ? reply(413, {}) : undefined));
    const r = await adapter().post(req({ mediaUrl: "https://media.example/pic.png" }));
    expect(r.errorMessage).toMatch(/too large/);
    expect(calls.some((c) => c.url === `${ORIGIN}/api/v3/post` && c.init.method === "POST")).toBe(false);
  });

  it("asks the customer to reconnect when the token is refused", async () => {
    on((url) => (url.includes("/community") ? reply(400, { error: "not_logged_in" }) : undefined));
    const r = await adapter().post(req());
    expect(r.errorMessage).toBe("Lemmy refused the login. Reconnect this account.");
    noSecrets(r.errorMessage);
  });

  it("gives a retry hint on HTTP 429 and never leaks the token", async () => {
    on((url) => (url.includes("/community") ? reply(200, { community_view: { community: { id: 1 } } }) : undefined));
    on((url, init) => (url.endsWith("/post") && init.method === "POST" ? reply(429, {}, { "retry-after": "30" }) : undefined));
    const r = await adapter().post(req());
    expect(r.errorMessage).toMatch(/30 seconds/);
    noSecrets(r.errorMessage);
  });

  it("reports a damaged saved connection instead of throwing", async () => {
    const r = await adapter().post(req({ accessToken: "not json" }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/Reconnect/);
  });
});

describe("verifyPublished", () => {
  const postView = (over: Record<string, unknown> = {}) => ({ post_view: { post: { id: 5150, removed: false, deleted: false, ap_id: `${ORIGIN}/post/5150`, ...over } } });

  it("needs the post to exist AND its public page to answer 200 without a login", async () => {
    on((url) => (url === `${ORIGIN}/api/v3/post?id=5150` ? reply(200, postView()) : undefined));
    on((url) => (url === `${ORIGIN}/post/5150` ? new Response("<html/>", { status: 200 }) : undefined));
    const r = await adapter().verifyPublished("5150", creds());
    expect(r).toEqual({ verifiedLive: true, platformPostUrl: `${ORIGIN}/post/5150`, errorMessage: null });
    const page = calls.find((c) => c.url === `${ORIGIN}/post/5150`)!;
    expect((page.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((page.init.headers as Record<string, string>).Cookie).toBeUndefined();
  });

  it("says a moderator removed it", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(200, postView({ removed: true })) : undefined));
    const r = await adapter().verifyPublished("5150", creds());
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/moderator removed/);
  });

  it("says when the author deleted it", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(200, postView({ deleted: true })) : undefined));
    expect((await adapter().verifyPublished("5150", creds())).errorMessage).toMatch(/deleted/);
  });

  it("is not live when the public page does not answer 200", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(200, postView()) : undefined));
    on((url) => (url === `${ORIGIN}/post/5150` ? new Response("nope", { status: 403 }) : undefined));
    const r = await adapter().verifyPublished("5150", creds());
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/HTTP 403/);
  });

  it("is not live when the post is not found", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(400, { error: "couldnt_find_post" }) : undefined));
    expect((await adapter().verifyPublished("5150", creds())).verifiedLive).toBe(false);
  });

  it("never follows a redirect on the public page", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(200, postView()) : undefined));
    on((url) => (url === `${ORIGIN}/post/5150` ? new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }) : undefined));
    expect((await adapter().verifyPublished("5150", creds())).verifiedLive).toBe(false);
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
    expect(calls.every((c) => c.url.startsWith(ORIGIN))).toBe(true);
  });

  it("falls back to the instance URL when ap_id points at another host", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(200, postView({ ap_id: "https://elsewhere.example/post/1" })) : undefined));
    on((url) => (url === `${ORIGIN}/post/5150` ? new Response("<html/>", { status: 200 }) : undefined));
    expect((await adapter().verifyPublished("5150", creds())).platformPostUrl).toBe(`${ORIGIN}/post/5150`);
  });
});

describe("comments and metrics", () => {
  it("lists visible comments and skips removed or deleted ones", async () => {
    on((url) =>
      url.startsWith(`${ORIGIN}/api/v3/comment/list`)
        ? reply(200, {
            comments: [
              { comment: { id: 1, content: "nice", ap_id: `${ORIGIN}/comment/1`, published: "2026-09-30T10:00:00Z", removed: false, deleted: false }, creator: { name: "bob", display_name: "Bob" } },
              { comment: { id: 2, content: "spam", removed: true, deleted: false }, creator: { name: "eve" } },
              { comment: { id: 3, content: "gone", removed: false, deleted: true }, creator: { name: "mal" } },
              { comment: { id: 4, content: "hi", ap_id: `${ORIGIN}/comment/4`, published_at: "2026-09-30T11:00:00Z" }, creator: { name: "carol" } },
            ],
          })
        : undefined,
    );
    const r = await adapter().getComments("5150", creds());
    expect(new URL(calls[0].url).searchParams.get("post_id")).toBe("5150");
    expect(r.comments.map((c) => [c.id, c.author, c.createdAt])).toEqual([
      ["1", "Bob", "2026-09-30T10:00:00Z"],
      ["4", "carol", "2026-09-30T11:00:00Z"],
    ]);
  });

  it("reports metrics from counts (v3) with null for anything missing", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(200, { post_view: { post: { id: 1 }, counts: { upvotes: 7, comments: 3 } } }) : undefined));
    expect(await adapter().getPostMetrics("1", creds())).toEqual({ likes: 7, comments: 3, shares: null, views: null, errorMessage: null });
  });

  it("falls back to score, and reads v4 numbers from the post itself", async () => {
    on((url) => (url.includes("/api/v3/post") ? reply(200, { post_view: { post: { id: 1 }, counts: { score: 4 } } }) : undefined));
    expect(await adapter().getPostMetrics("1", creds())).toMatchObject({ likes: 4, comments: null });
    handlers = [];
    on((url) => (url.includes("/api/v4/post") ? reply(200, { post_view: { post: { id: 1, upvotes: 9, comments: 2 } } }) : undefined));
    expect(await adapter().getPostMetrics("1", creds({ apiVersion: 4 }))).toMatchObject({ likes: 9, comments: 2 });
  });

  it("reports a metrics failure without numbers", async () => {
    on(() => reply(500, {}));
    const r = await adapter().getPostMetrics("1", creds());
    expect(r).toMatchObject({ likes: null, comments: null });
    expect(r.errorMessage).toBeTruthy();
  });

  it("posts a comment and replies to one (post id looked up from the comment)", async () => {
    on((url) => (url.startsWith(`${ORIGIN}/api/v3/comment?id=8`) ? reply(200, { comment_view: { comment: { id: 8, post_id: 5150 } } }) : undefined));
    on((url, init) => (url === `${ORIGIN}/api/v3/comment` && init.method === "POST" ? reply(200, { comment_view: { comment: { id: 99 } } }) : undefined));
    expect(await adapter().postComment("5150", "first!", creds())).toEqual({ success: true, errorMessage: null });
    expect(await adapter().replyToComment("8", "thanks", creds())).toEqual({ success: true, errorMessage: null });
    const posts = calls.filter((c) => c.init.method === "POST").map((c) => JSON.parse(String(c.init.body)));
    expect(posts).toEqual([
      { content: "first!", post_id: 5150 },
      { content: "thanks", post_id: 5150, parent_id: 8 },
    ]);
  });
});

describe("secrets", () => {
  it("never puts the password or JWT into any failure message", async () => {
    const messages: Array<string | null> = [];
    on(() => reply(500, { error: `oops ${JWT} ${PASSWORD}` }));
    messages.push((await adapter().post(req())).errorMessage);
    messages.push((await adapter().verifyPublished("5150", creds())).errorMessage);
    messages.push((await adapter().getComments("5150", creds())).errorMessage);
    messages.push((await adapter().getPostMetrics("5150", creds())).errorMessage);
    messages.push((await adapter().postComment("5150", "x", creds())).errorMessage);
    messages.push((await adapter().exchangeCode(connectJson()).catch((e: Error) => e.message)));
    for (const m of messages) noSecrets(m);
  });

  it("only ever sends the JWT to the chosen instance", async () => {
    on((url) => (url.includes("/community") ? reply(200, { community_view: { community: { id: 1 } } }) : undefined));
    on((url, init) => (url.endsWith("/post") && init.method === "POST" ? reply(200, { post_view: { post: { id: 2 } } }) : undefined));
    await adapter().post(req({ options: { lemmy: { url: "https://other.example/x" } } }));
    for (const c of calls) {
      if (JSON.stringify(c.init.headers ?? {}).includes(JWT)) expect(new URL(c.url).origin).toBe(ORIGIN);
    }
  });

  it("uses no en or em dashes in any user-facing message", async () => {
    on(() => reply(400, { error: "site_ban" }));
    const all = [
      (await adapter().post(req())).errorMessage,
      (await adapter().exchangeCode(connectJson()).catch((e: Error) => e.message)),
      (await adapter().post(req({ accessToken: creds({ community: undefined }) }))).errorMessage,
    ];
    for (const m of all) expect(m ?? "").not.toMatch(/[–—]/);
  });
});

describe("review fixes", () => {
  const listOf = (posts: unknown[]) => reply(200, { posts });
  const okCommunity = () => on((url) => (url.startsWith(`${ORIGIN}/api/v3/community`) ? reply(200, { community_view: { community: { id: 77 } } }) : undefined));
  const recent = (over: Record<string, unknown> = {}) => ({
    post: { id: 808, name: "Hello Lemmy", published: new Date(Date.now() - 30_000).toISOString(), removed: false, deleted: false, ...over },
    creator: { name: "alice" },
  });

  it("verify: the unauthenticated API read must show the post live (no Authorization header sent)", async () => {
    const view = { post_view: { post: { id: 5150, removed: false, deleted: false, ap_id: `${ORIGIN}/post/5150` }, community: { removed: false, deleted: false } } };
    on((url) => (url === `${ORIGIN}/api/v3/post?id=5150` ? reply(200, view) : undefined));
    on((url) => (url === `${ORIGIN}/post/5150` ? new Response("<html/>", { status: 200 }) : undefined));
    expect((await adapter().verifyPublished("5150", creds())).verifiedLive).toBe(true);
    const reads = calls.filter((c) => c.url === `${ORIGIN}/api/v3/post?id=5150`);
    expect(reads).toHaveLength(2);
    expect((reads[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`);
    expect((reads[1].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it.each([401, 403, 404])("verify: a %s on the public read means not publicly live, even if the page says 200", async (status) => {
    on((url, init) => {
      if (url !== `${ORIGIN}/api/v3/post?id=5150`) return undefined;
      const authed = !!(init.headers as Record<string, string>).Authorization;
      return authed ? reply(200, { post_view: { post: { id: 5150, removed: false, deleted: false } } }) : reply(status, {});
    });
    on((url) => (url === `${ORIGIN}/post/5150` ? new Response("<html/>", { status: 200 }) : undefined));
    const r = await adapter().verifyPublished("5150", creds());
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/not show it publicly/);
  });

  it("verify: the public read showing removed, or a removed community, is not live", async () => {
    on((url, init) => {
      if (url !== `${ORIGIN}/api/v3/post?id=5150`) return undefined;
      const authed = !!(init.headers as Record<string, string>).Authorization;
      return reply(200, { post_view: { post: { id: 5150, removed: authed ? false : true, deleted: false } } });
    });
    expect((await adapter().verifyPublished("5150", creds())).errorMessage).toMatch(/moderator removed/);
    handlers = [];
    on((url) => (url === `${ORIGIN}/api/v3/post?id=5150` ? reply(200, { post_view: { post: { id: 5150, removed: false, deleted: false }, community: { removed: true } } }) : undefined));
    expect((await adapter().verifyPublished("5150", creds())).errorMessage).toMatch(/community/);
  });

  it("post: a timeout on creation finds the post already made and returns its id (no duplicate)", async () => {
    okCommunity();
    on((url, init) => {
      if (url === `${ORIGIN}/api/v3/post` && init.method === "POST") throw new Error("aborted");
      return undefined;
    });
    on((url) => (url.startsWith(`${ORIGIN}/api/v3/post/list`) ? listOf([recent({ id: 1, name: "Other" }), recent()]) : undefined));
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "808", errorMessage: null });
    expect(calls.filter((c) => c.url === `${ORIGIN}/api/v3/post` && c.init.method === "POST")).toHaveLength(1);
  });

  it("post: an unconfirmed creation says to check Lemmy before retrying", async () => {
    okCommunity();
    on((url, init) => {
      if (url === `${ORIGIN}/api/v3/post` && init.method === "POST") throw new Error("aborted");
      return undefined;
    });
    // Old post, someone else's post and a removed one must not be mistaken for ours.
    on((url) =>
      url.startsWith(`${ORIGIN}/api/v3/post/list`)
        ? listOf([recent({ published: new Date(Date.now() - 3_600_000).toISOString() }), { ...recent(), creator: { name: "bob" } }, recent({ removed: true })])
        : undefined,
    );
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/did not confirm/);
    expect(r.errorMessage).toMatch(/before trying again/);
    noSecrets(r.errorMessage);
  });

  it("post: a 5xx on creation is also treated as unconfirmed and checked", async () => {
    okCommunity();
    on((url, init) => (url === `${ORIGIN}/api/v3/post` && init.method === "POST" ? reply(502, {}) : undefined));
    on((url) => (url.startsWith(`${ORIGIN}/api/v3/post/list`) ? listOf([recent()]) : undefined));
    expect((await adapter().post(req())).platformPostId).toBe("808");
  });

  it("post: a plain refusal (4xx) is a clear failure and no lookup is made", async () => {
    okCommunity();
    on((url, init) => (url === `${ORIGIN}/api/v3/post` && init.method === "POST" ? reply(400, { error: "banned_from_community" }) : undefined));
    const r = await adapter().post(req());
    expect(r.errorMessage).toMatch(/banned from that community/);
    expect(calls.some((c) => c.url.includes("/post/list"))).toBe(false);
  });

  it("refuses an API answer larger than 2 MB", async () => {
    on((url) => (url.includes("/community") ? new Response(JSON.stringify({ community_view: { community: { id: 1 } }, pad: "x".repeat(2 * 1024 * 1024 + 10) }), { status: 200 }) : undefined));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/could not find|look up/);
  });

  it("gives the image upload a longer timeout than normal requests", async () => {
    const seen: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      seen.push(ms);
      return new AbortController().signal;
    });
    okCommunity();
    on((url) => (url === "https://media.example/p.png" ? new Response("X", { status: 200, headers: { "content-type": "image/png", "content-length": "1" } }) : undefined));
    on((url) => (url === `${ORIGIN}/pictrs/image` ? reply(200, { msg: "ok", files: [{ file: "a.png" }] }) : undefined));
    on((url, init) => (url === `${ORIGIN}/api/v3/post` && init.method === "POST" ? reply(200, { post_view: { post: { id: 3 } } }) : undefined));
    await adapter().post(req({ mediaUrl: "https://media.example/p.png" }));
    spy.mockRestore();
    expect(Math.max(...seen)).toBe(120_000);
    expect(seen.filter((ms) => ms === 30_000).length).toBeGreaterThan(0);
  });

  it("detection: a 429 or 5xx from v3 is reported, not treated as not-Lemmy, and v4 is not tried", async () => {
    on((url) => (url === `${ORIGIN}/api/v3/site` ? reply(429, {}, { "retry-after": "15" }) : undefined));
    await expect(adapter().exchangeCode(connectJson())).rejects.toThrow(/15 seconds/);
    handlers = [];
    calls = [];
    on((url) => (url === `${ORIGIN}/api/v3/site` ? reply(503, {}) : undefined));
    await expect(adapter().exchangeCode(connectJson())).rejects.toThrow(/server problem \(HTTP 503\)/);
    expect(calls.some((c) => c.url.includes("/api/v4/"))).toBe(false);
  });
});

describe("an instance that serves a cached, anonymous /site (seen live on lemmy.cafe)", () => {
  function cachedSiteServer(opts: { unreadStatus?: number } = {}) {
    on((url) => {
      if (url === `${ORIGIN}/api/v3/site`) return reply(200, SITE_OK, { "cache-control": "public, max-age=60" }); // never has my_user
      if (url === `${ORIGIN}/api/v3/user/login`) return reply(200, { jwt: JWT, registration_created: false, verify_email_sent: false });
      if (url === `${ORIGIN}/api/v3/user/unread_count`) return reply(opts.unreadStatus ?? 200, opts.unreadStatus && opts.unreadStatus >= 400 ? { error: "not_logged_in" } : { replies: 0, mentions: 0, private_messages: 0 });
      if (url.startsWith(`${ORIGIN}/api/v3/user?username=`)) return reply(200, { person_view: { person: { name: "alice", deleted: false } } });
      return undefined;
    });
  }

  it("still connects: the login is proven by the unread count and the name by the public profile", async () => {
    cachedSiteServer();
    const r = await adapter().exchangeCode(connectJson());
    expect(r.platformAccountId).toBe("alice@lemmy.example");
    expect(JSON.parse(r.accessToken)).toMatchObject({ jwt: JWT, username: "alice", apiVersion: 3 });
    // The token went only to the login-checked endpoint, and the profile lookup carried no login at all.
    const profile = calls.find((c) => c.url.includes("/user?username="))!;
    expect((profile.init.headers as Record<string, string>).Authorization).toBeUndefined();
    noSecrets(r.displayName);
  });

  it("refuses when the token itself is not accepted (a 401 on the unread count)", async () => {
    cachedSiteServer({ unreadStatus: 401 });
    const err = await adapter().exchangeCode(connectJson()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/did not confirm the account/);
    noSecrets((err as Error).message);
  });
});
