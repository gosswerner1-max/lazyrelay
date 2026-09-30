// WordPress adapter: fetch is stubbed, the SSRF guard and the media downloader are
// mocked. Nothing real is called and no real credentials appear anywhere.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../urlSafety.js", () => ({
  // Same contract as the real guard, minus DNS: https only, no private literals.
  isSafeMediaUrl: vi.fn(async (raw: string) => {
    const u = new URL(raw);
    if (u.protocol !== "https:") return { safe: false, reason: "must use https" };
    if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(u.hostname) || u.hostname === "localhost") {
      return { safe: false, reason: "must not point at a private, internal, or reserved address" };
    }
    return { safe: true, addresses: ["93.184.216.34"] };
  }),
}));

const mediaMock = vi.hoisted(() => ({
  fetchMediaForStreaming: vi.fn(async (url: string) => {
    if (url.includes("missing")) return null;
    const isVideo = url.endsWith(".mp4");
    return {
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
      sizeBytes: 3,
      contentType: isVideo ? "video/mp4" : "image/png",
    };
  }),
}));
vi.mock("./streamUpload.js", () => mediaMock);

import { WordPressAdapter, deriveTitleAndBody, textToHtml, normalizeSiteUrl } from "./wordpress.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null; hasStreamBody: boolean };
let calls: Call[];

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({
    status,
    ok: status < 400,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }) as unknown as Response;

function stubFetch(handler: (c: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      const c: Call = {
        url,
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        body: typeof init?.body === "string" ? init.body : null,
        hasStreamBody: typeof init?.body === "object" && init?.body !== null,
      };
      calls.push(c);
      return handler(c);
    }),
  );
}

const SITE = "https://blog.example.com";
const PASSWORD = "abcd efgh ijkl mnop qrst uvwx";
const creds = (extra: Record<string, unknown> = {}) => JSON.stringify({ siteUrl: SITE, username: "editor", applicationPassword: PASSWORD, ...extra });
const basic = "Basic " + Buffer.from(`editor:${PASSWORD}`).toString("base64");
const adapter = () => new WordPressAdapter("https://app.example/connect/wordpress");
const req = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "My title\n\nBody text", mediaUrl: null, coverImageUrl: null, accessToken: creds(), ...over }) as never;
const postsBody = () => JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/wp-json/wp/v2/posts"))!.body!);

beforeEach(() => {
  calls = [];
  mediaMock.fetchMediaForStreaming.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("getAuthorizeUrl", () => {
  it("returns the connect page with the state", async () => {
    expect(await adapter().getAuthorizeUrl("st1")).toBe("https://app.example/connect/wordpress?state=st1");
  });
});

describe("normalizeSiteUrl", () => {
  it("keeps a subdirectory, drops trailing slash, query, and wp-json tail", () => {
    expect(normalizeSiteUrl("https://Example.com/blog/")).toEqual({ ok: true, siteUrl: "https://example.com/blog" });
    expect(normalizeSiteUrl("https://example.com/blog/wp-json/wp/v2?x=1#y")).toEqual({ ok: true, siteUrl: "https://example.com/blog" });
    expect(normalizeSiteUrl("example.com")).toEqual({ ok: true, siteUrl: "https://example.com" });
  });
  it("rejects http and embedded credentials", () => {
    expect(normalizeSiteUrl("http://example.com").ok).toBe(false);
    expect(normalizeSiteUrl("https://user:pw@example.com").ok).toBe(false);
  });
});

describe("exchangeCode", () => {
  const code = (over: Record<string, unknown> = {}) => JSON.stringify({ siteUrl: SITE, username: "editor", applicationPassword: PASSWORD, ...over });
  const me = { id: 7, name: "Ed Itor", capabilities: { edit_posts: true } };

  it("verifies live with Basic auth and returns the stored credentials", async () => {
    stubFetch(() => reply(200, me));
    const r = await adapter().exchangeCode(code({ siteUrl: `${SITE}/` }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SITE}/wp-json/wp/v2/users/me?context=edit`);
    expect(calls[0].headers.Authorization).toBe(basic);
    expect(JSON.parse(r.accessToken)).toEqual({ siteUrl: SITE, username: "editor", applicationPassword: PASSWORD });
    expect(r.refreshToken).toBeNull();
    expect(r.expiresAt).toBeNull();
    expect(r.platformAccountId).toBe("blog.example.com:editor");
    expect(r.displayName).toContain("blog.example.com");
  });

  it("falls back to ?rest_route= when /wp-json is not reachable and remembers it", async () => {
    stubFetch((c) => (c.url.includes("/wp-json/") ? reply(404, "<html>not found</html>") : reply(200, me)));
    const r = await adapter().exchangeCode(code());
    expect(calls[1].url).toBe(`${SITE}/?rest_route=/wp/v2/users/me&context=edit`);
    expect(JSON.parse(r.accessToken).useRestRoute).toBe(true);
  });

  it("reports bad JSON", async () => {
    await expect(adapter().exchangeCode("not json")).rejects.toThrow(/site address, your username/);
  });

  it("rejects an http address before any request", async () => {
    stubFetch(() => reply(200, me));
    await expect(adapter().exchangeCode(code({ siteUrl: "http://blog.example.com" }))).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("blocks a private address before any request", async () => {
    stubFetch(() => reply(200, me));
    await expect(adapter().exchangeCode(code({ siteUrl: "https://10.0.0.5" }))).rejects.toThrow(/cannot connect to that address/);
    expect(calls).toHaveLength(0);
  });

  it("explains a wrong password (401 incorrect_password)", async () => {
    stubFetch(() => reply(401, { code: "incorrect_password", message: "bad" }));
    await expect(adapter().exchangeCode(code())).rejects.toThrow(/rejected that username or application password/);
  });

  it("explains disabled Application Passwords", async () => {
    stubFetch(() => reply(401, { code: "application_passwords_disabled" }));
    await expect(adapter().exchangeCode(code())).rejects.toThrow(/Application Passwords are turned off/);
  });

  it("explains an ignored login header (rest_not_logged_in)", async () => {
    stubFetch(() => reply(401, { code: "rest_not_logged_in" }));
    await expect(adapter().exchangeCode(code())).rejects.toThrow(/Application Passwords may be turned off/);
  });

  it("says not WordPress when neither route answers", async () => {
    stubFetch(() => reply(404, "<html>nope</html>"));
    await expect(adapter().exchangeCode(code())).rejects.toThrow(/does not look like a WordPress site/);
  });

  it("reports a redirect instead of following it", async () => {
    stubFetch(() => reply(301, "", { location: "https://www.blog.example.com/wp-json/wp/v2/users/me" }));
    await expect(adapter().exchangeCode(code())).rejects.toThrow(/redirected the request \(to www\.blog\.example\.com\)/);
  });

  it("never puts the password in an error message", async () => {
    stubFetch(() => reply(401, { code: "incorrect_password" }));
    await adapter().exchangeCode(code()).catch((e: Error) => expect(e.message).not.toContain("abcd"));
  });
});

describe("title and body derivation", () => {
  it("uses options.title and keeps the whole content as body", () => {
    expect(deriveTitleAndBody("Line one\n\nLine two", " Given ")).toEqual({ title: "Given", body: "Line one\n\nLine two" });
  });
  it("uses the first non-empty line and strips a markdown heading mark", () => {
    expect(deriveTitleAndBody("\n\n## Big news\n\nThe rest\nof it", undefined)).toEqual({ title: "Big news", body: "The rest\nof it" });
  });
  it("uses the full content when nothing remains after the first line", () => {
    expect(deriveTitleAndBody("Only a line", undefined)).toEqual({ title: "Only a line", body: "Only a line" });
  });
  it("caps the title at 250 characters", () => {
    expect(deriveTitleAndBody("x".repeat(400) + "\nbody", undefined).title).toHaveLength(250);
  });
});

describe("textToHtml", () => {
  it("escapes a script tag", () => {
    const html = textToHtml('<script>alert("x")</script>');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
  it("makes paragraphs, line breaks, and links https URLs without the trailing dot", () => {
    const html = textToHtml("Line a\nLine b\n\nSee https://example.com/x?a=1&b=2.");
    expect(html).toContain("<p>Line a<br>\nLine b</p>");
    expect(html).toContain('<a href="https://example.com/x?a=1&amp;b=2" rel="noopener noreferrer">https://example.com/x?a=1&amp;b=2</a>.</p>');
  });
  it("does not let an escaped quote break out of a link", () => {
    const html = textToHtml('https://e.com/a"onmouseover="x');
    expect(html).not.toMatch(/href="[^"]*"[^>]*onmouseover/);
  });
});

describe("post", () => {
  const okHandler = (extra?: (c: Call) => Response | null) => (c: Call) => {
    const special = extra?.(c);
    if (special) return special;
    if (c.method === "POST" && c.url.endsWith("/wp/v2/posts")) return reply(201, { id: 42 });
    return reply(404, {});
  };

  it("publishes with a derived title, escaped HTML, and returns the numeric id", async () => {
    stubFetch(okHandler());
    const r = await adapter().post(req({ content: "# Hello\n\n<b>hi</b>" }));
    expect(r).toEqual({ success: true, platformPostId: "42", errorMessage: null });
    const body = postsBody();
    expect(body.title).toBe("Hello");
    expect(body.status).toBe("publish");
    expect(body.content).toBe("<p>&lt;b&gt;hi&lt;/b&gt;</p>");
    expect(calls[0].headers.Authorization).toBe(basic);
  });

  it("honours status draft and a custom title", async () => {
    stubFetch(okHandler());
    await adapter().post(req({ options: { wordpress: { title: "Mine", status: "draft" } } }));
    expect(postsBody()).toMatchObject({ title: "Mine", status: "draft" });
  });

  it("resolves existing terms by exact case-insensitive name, creates missing tags, tolerates a refused category create", async () => {
    stubFetch(
      okHandler((c) => {
        if (c.method === "GET" && c.url.includes("/wp/v2/categories?")) {
          return c.url.includes("search=News") ? reply(200, [{ id: 3, name: "news" }, { id: 4, name: "Newsletter" }]) : reply(200, []);
        }
        if (c.method === "GET" && c.url.includes("/wp/v2/tags?")) return reply(200, []);
        if (c.method === "POST" && c.url.endsWith("/wp/v2/tags")) return reply(201, { id: 91 });
        if (c.method === "POST" && c.url.endsWith("/wp/v2/categories")) return reply(403, { code: "rest_cannot_create" });
        return null;
      }),
    );
    const r = await adapter().post(req({ options: { wordpress: { categories: ["News", "Secret"], tags: ["Fresh"] } } }));
    expect(r.success).toBe(true);
    const body = postsBody();
    expect(body.categories).toEqual([3]); // "Secret" skipped, no failure
    expect(body.tags).toEqual([91]);
  });

  it("uses the term id WordPress returns for term_exists", async () => {
    stubFetch(
      okHandler((c) => {
        if (c.method === "GET" && c.url.includes("/wp/v2/tags?")) return reply(200, []);
        if (c.method === "POST" && c.url.endsWith("/wp/v2/tags")) return reply(400, { code: "term_exists", data: { term_id: 55 } });
        return null;
      }),
    );
    await adapter().post(req({ options: { wordpress: { tags: ["Dup"] } } }));
    expect(postsBody().tags).toEqual([55]);
  });

  it("uploads an image as the featured image with alt text", async () => {
    stubFetch(
      okHandler((c) => {
        if (c.method === "POST" && c.url.endsWith("/wp/v2/media")) return reply(201, { id: 12, source_url: "https://blog.example.com/wp-content/uploads/pic.png" });
        if (c.method === "POST" && c.url.endsWith("/wp/v2/media/12")) return reply(200, { id: 12 });
        return null;
      }),
    );
    const r = await adapter().post(req({ mediaUrl: "https://cdn.example.com/pic.png", mediaAltText: "A picture" }));
    expect(r.success).toBe(true);
    const upload = calls.find((c) => c.url.endsWith("/wp/v2/media"))!;
    expect(upload.hasStreamBody).toBe(true);
    expect(upload.headers["Content-Disposition"]).toBe('attachment; filename="pic.png"');
    expect(upload.headers["Content-Type"]).toBe("image/png");
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/wp/v2/media/12"))!.body!)).toEqual({ alt_text: "A picture" });
    expect(postsBody().featured_media).toBe(12);
  });

  it("appends extra images as figures and a video as a video element", async () => {
    let n = 100;
    stubFetch(
      okHandler((c) => {
        if (c.method === "POST" && c.url.endsWith("/wp/v2/media")) {
          n += 1;
          return reply(201, { id: n, source_url: `https://blog.example.com/u/${n}` });
        }
        return null;
      }),
    );
    await adapter().post(req({ mediaUrl: "https://cdn.example.com/clip.mp4", mediaUrls: ["https://cdn.example.com/two.png"] }));
    const body = postsBody();
    expect(body.featured_media).toBeUndefined();
    expect(body.content).toContain('<video controls src="https://blog.example.com/u/101"></video>');
    expect(body.content).toContain('<figure><img src="https://blog.example.com/u/102" alt=""></figure>');
  });

  it("returns a clear error when a video upload is refused, and creates no post", async () => {
    stubFetch(okHandler((c) => (c.url.endsWith("/wp/v2/media") ? reply(400, { code: "rest_upload_unknown_error", message: "Sorry, you are not allowed to upload this file type." }) : null)));
    const r = await adapter().post(req({ mediaUrl: "https://cdn.example.com/clip.mp4" }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/refused the video upload/);
    expect(calls.some((c) => c.url.endsWith("/wp/v2/posts"))).toBe(false);
  });

  it("fails when the source media cannot be fetched", async () => {
    stubFetch(okHandler());
    const r = await adapter().post(req({ mediaUrl: "https://cdn.example.com/missing.png" }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Could not fetch media from https://cdn.example.com/missing.png" });
  });

  it("maps 401 and 403 to reconnect and permission messages", async () => {
    stubFetch(() => reply(401, { code: "rest_cannot_create" }));
    expect((await adapter().post(req())).errorMessage).toBe("WordPress refused the login. The application password may have been revoked. Reconnect this account.");
    stubFetch(() => reply(403, { code: "rest_cannot_create" }));
    expect((await adapter().post(req())).errorMessage).toMatch(/not be allowed to publish/);
  });

  it("returns a failure for corrupt stored credentials", async () => {
    const r = await adapter().post(req({ accessToken: "garbage" }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/Reconnect this account/);
  });

  it("re-checks the site address at post time and makes no request when blocked", async () => {
    stubFetch(() => reply(201, { id: 1 }));
    const r = await adapter().post(req({ accessToken: JSON.stringify({ siteUrl: "https://127.0.0.1", username: "u", applicationPassword: "p" }) }));
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("uses the rest_route form when the connection was saved with it", async () => {
    stubFetch((c) => (c.url.includes("rest_route=/wp/v2/posts") ? reply(201, { id: 9 }) : reply(404, {})));
    const r = await adapter().post(req({ accessToken: creds({ useRestRoute: true }) }));
    expect(r.platformPostId).toBe("9");
    expect(calls[0].url).toBe(`${SITE}/?rest_route=/wp/v2/posts`);
  });
});

describe("verifyPublished", () => {
  const postRes = (status: string, link = "https://blog.example.com/hello/", extra: Record<string, unknown> = {}) =>
    reply(200, { id: 42, status, link, title: { raw: "Hello" }, password: "", ...extra });

  it("is live only when published AND the public address answers 200 without auth", async () => {
    stubFetch((c) => (c.url.includes("/wp-json/wp/v2/posts/42") ? postRes("publish") : reply(200, "<html><h1>Hello</h1></html>")));
    const r = await adapter().verifyPublished("42", creds());
    expect(r).toEqual({ verifiedLive: true, platformPostUrl: "https://blog.example.com/hello/", errorMessage: null });
    expect(calls[0].url).toBe(`${SITE}/wp-json/wp/v2/posts/42?context=edit`);
    expect(calls[0].headers.Authorization).toBe(basic);
    expect(calls[1].url).toBe("https://blog.example.com/hello/");
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  it("is not live when the public address does not answer 200", async () => {
    stubFetch((c) => (c.url.includes("/wp-json/") ? postRes("publish") : reply(404, "gone")));
    const r = await adapter().verifyPublished("42", creds());
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/HTTP 404/);
    expect(r.platformPostUrl).toBe("https://blog.example.com/hello/");
  });

  it("follows public redirects by hand and without auth", async () => {
    stubFetch((c) => {
      if (c.url.includes("/wp-json/")) return postRes("publish");
      if (c.url === "https://blog.example.com/hello/") return reply(301, "", { location: "https://www.example.org/hello/" });
      return reply(200, "<h1>Hello</h1>");
    });
    const r = await adapter().verifyPublished("42", creds());
    expect(r.verifiedLive).toBe(true);
    expect(calls[2].url).toBe("https://www.example.org/hello/");
    expect(calls[2].headers.Authorization).toBeUndefined();
  });

  it("reports a draft honestly and does not read the public page", async () => {
    stubFetch(() => postRes("draft", "https://blog.example.com/?p=42"));
    const r = await adapter().verifyPublished("42", creds());
    expect(r).toEqual({ verifiedLive: false, platformPostUrl: null, errorMessage: "Saved as a draft on WordPress as you chose, not published." });
    expect(calls).toHaveLength(1);
  });

  it("does not treat a scheduled post as live", async () => {
    stubFetch(() => postRes("future"));
    expect((await adapter().verifyPublished("42", creds())).verifiedLive).toBe(false);
  });

  it("reports a deleted post", async () => {
    stubFetch(() => reply(404, { code: "rest_post_invalid_id" }));
    expect((await adapter().verifyPublished("42", creds())).errorMessage).toMatch(/not found/);
  });

  it("rejects a post address on a different host and never fetches it", async () => {
    stubFetch(() => postRes("publish", "https://evil.example/hello/"));
    const r = await adapter().verifyPublished("42", creds());
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/different host/);
    expect(calls).toHaveLength(1);
  });

  it("does not treat a password-protected post as live", async () => {
    stubFetch(() => postRes("publish", undefined, { password: "secret" }));
    const r = await adapter().verifyPublished("42", creds());
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/password protected/);
    expect(calls).toHaveLength(1);
  });

  it("does not accept a 200 catch-all or maintenance page that does not mention the post", async () => {
    stubFetch((c) => (c.url.includes("/wp-json/") ? postRes("publish", "https://blog.example.com/x-1234/") : reply(200, "<h1>Coming soon</h1>")));
    const r = await adapter().verifyPublished("42", creds());
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/did not show the post/);
  });

  it("accepts a page that shows the slug even when the title is absent", async () => {
    stubFetch((c) => (c.url.includes("/wp-json/") ? postRes("publish", "https://blog.example.com/my-slug/") : reply(200, '<link rel="canonical" href="https://blog.example.com/my-slug/">')));
    expect((await adapter().verifyPublished("42", creds())).verifiedLive).toBe(true);
  });

  it("only reads the first 256 KB of the public page", async () => {
    stubFetch((c) => (c.url.includes("/wp-json/") ? postRes("publish") : reply(200, "x".repeat(300 * 1024) + "Hello")));
    expect((await adapter().verifyPublished("42", creds())).verifiedLive).toBe(false);
  });
});

describe("getComments and replyToComment", () => {
  it("reads comments for the post", async () => {
    stubFetch(() =>
      reply(200, [
        { id: 5, author_name: "Sam", content: { rendered: "<p>Nice &amp; neat</p>" }, link: "https://blog.example.com/hello/#comment-5", date_gmt: "2026-09-01T10:00:00" },
      ]),
    );
    const r = await adapter().getComments("42", creds());
    expect(calls[0].url).toContain("/wp-json/wp/v2/comments?post=42");
    expect(r.errorMessage).toBeNull();
    expect(r.comments).toEqual([
      { id: "5", author: "Sam", text: "Nice & neat", url: "https://blog.example.com/hello/#comment-5", createdAt: "2026-09-01T10:00:00Z" },
    ]);
  });

  it("returns an error result when comments cannot be loaded", async () => {
    stubFetch(() => reply(401, {}));
    const r = await adapter().getComments("42", creds());
    expect(r.comments).toEqual([]);
    expect(r.errorMessage).toMatch(/Reconnect this account/);
  });

  it("replies by looking up the post id, then creating a child comment with escaped text", async () => {
    stubFetch((c) => {
      if (c.method === "GET") return reply(200, { id: 5, post: 42 });
      return reply(201, { id: 6 });
    });
    const r = await adapter().replyToComment("5", "Thanks <3", creds());
    expect(r).toEqual({ success: true, errorMessage: null });
    expect(calls[0].url).toBe(`${SITE}/wp-json/wp/v2/comments/5`);
    expect(JSON.parse(calls[1].body!)).toEqual({ post: 42, parent: 5, content: "Thanks &lt;3" });
  });

  it("reports a refused reply", async () => {
    stubFetch((c) => (c.method === "GET" ? reply(200, { id: 5, post: 42 }) : reply(403, {})));
    const r = await adapter().replyToComment("5", "Hi", creds());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/not be allowed/);
  });
});

describe("credentials stay on the customer's own host", () => {
  it("never sends the auth header to any other host across connect, post (with media) and verify", async () => {
    stubFetch((c) => {
      if (c.url.includes("/users/me")) return reply(200, { id: 1, capabilities: { edit_posts: true } });
      if (c.method === "POST" && c.url.endsWith("/wp/v2/media")) return reply(201, { id: 3, source_url: "https://cdn.other.example/x.png" });
      if (c.method === "POST" && c.url.endsWith("/wp/v2/posts")) return reply(201, { id: 42 });
      if (c.url.includes("/wp/v2/posts/42")) return reply(200, { id: 42, status: "publish", link: "https://blog.example.com/hello/", title: { raw: "Hello" }, password: "" });
      if (c.url === "https://blog.example.com/hello/") return reply(200, "Hello page");
      return reply(200, "ok");
    });
    const a = adapter();
    await a.exchangeCode(JSON.stringify({ siteUrl: SITE, username: "editor", applicationPassword: PASSWORD }));
    await a.post(req({ mediaUrl: "https://cdn.example.com/pic.png" }));
    await a.verifyPublished("42", creds());
    const withAuth = calls.filter((c) => c.headers.Authorization);
    expect(withAuth.length).toBeGreaterThan(0);
    for (const c of withAuth) expect(new URL(c.url).host).toBe("blog.example.com");
    // The media source and the public read-back went out without credentials.
    expect(calls.some((c) => c.url === "https://blog.example.com/hello/" && !c.headers.Authorization)).toBe(true);
  });
});

describe("review fixes", () => {
  it("keeps the whole content as the body when the first line is over the title cap", () => {
    const first = "word ".repeat(80).trim(); // 399 chars
    const content = `${first}\nsecond line`;
    const r = deriveTitleAndBody(content, undefined);
    expect(r.body).toBe(content);
    expect(r.title.length).toBeLessThanOrEqual(250);
    expect(r.title.endsWith("word")).toBe(true); // cut at a word boundary
  });

  it("does not throw on out-of-range or surrogate entities, and decodes hex", async () => {
    stubFetch(() => reply(200, [{ id: 1, author_name: "A", content: { rendered: "<p>&#99999999999; &#xD800; it&#x27;s &#65;</p>" } }]));
    const r = await adapter().getComments("42", creds());
    expect(r.errorMessage).toBeNull();
    expect(r.comments[0].text).toBe("&#99999999999; &#xD800; it's A");
  });

  it("after a dropped connection on create, returns the post if it exists", async () => {
    stubFetch((c) => {
      if (c.method === "POST" && c.url.endsWith("/wp/v2/posts")) throw new Error("socket hang up");
      if (c.method === "GET" && c.url.includes("/wp/v2/posts?")) return reply(200, [{ id: 77, title: { raw: "My title" } }]);
      return reply(404, {});
    });
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "77", errorMessage: null });
    const lookup = calls.find((c) => c.method === "GET")!;
    expect(lookup.url).toContain("status=any");
    expect(lookup.url).toContain("orderby=date");
  });

  it("after a dropped connection with no matching post, says the result is unconfirmed", async () => {
    stubFetch((c) => {
      if (c.method === "POST") throw new Error("timeout");
      return reply(200, [{ id: 5, title: { raw: "Some other post" } }]);
    });
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/did not confirm whether the post was created/);
  });

  it("a 201 whose body cannot be read is recovered, not reported as an HTTP error", async () => {
    stubFetch((c) => {
      if (c.method === "POST") {
        return {
          status: 201,
          ok: true,
          headers: { get: () => null },
          text: async () => {
            throw new Error("aborted");
          },
        } as unknown as Response;
      }
      return reply(200, [{ id: 88, title: { raw: "My title" } }]);
    });
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "88", errorMessage: null });
  });

  it("refuses an API body over 2 MB", async () => {
    stubFetch(() => reply(200, "[" + "1,".repeat(1.2 * 1024 * 1024) + "1]"));
    const r = await adapter().getComments("42", creds());
    expect(r.comments).toEqual([]);
    expect(r.errorMessage).not.toBeNull();
  });

  it("connect refuses a user who cannot publish (Contributor)", async () => {
    stubFetch(() => reply(200, { id: 2, capabilities: { edit_posts: true, publish_posts: false } }));
    await expect(adapter().exchangeCode(JSON.stringify({ siteUrl: SITE, username: "editor", applicationPassword: PASSWORD }))).rejects.toThrow(/Author role or higher/);
  });

  it("rejects a custom port before any request, at connect and at post time", async () => {
    expect(normalizeSiteUrl("https://example.com:8443").ok).toBe(false);
    stubFetch(() => reply(200, {}));
    await expect(adapter().exchangeCode(JSON.stringify({ siteUrl: "https://example.com:8443", username: "u", applicationPassword: "p" }))).rejects.toThrow(/port/);
    const r = await adapter().post(req({ accessToken: JSON.stringify({ siteUrl: "https://example.com:8443", username: "u", applicationPassword: "p" }) }));
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("caps and scrubs a server-supplied error message (no password, no tokens, no markup)", async () => {
    const message = `<b>Oops</b> ${PASSWORD} token=${"A1b2C3d4".repeat(6)} ${"long ".repeat(200)}`;
    stubFetch(() => reply(400, { code: "x", message }));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).not.toContain("abcd");
    expect(r.errorMessage).not.toContain("A1b2C3d4A1b2");
    expect(r.errorMessage).not.toContain("<b>");
    expect(r.errorMessage!.length).toBeLessThan(400);
  });
});
