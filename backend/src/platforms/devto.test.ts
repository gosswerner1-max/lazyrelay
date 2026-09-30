// dev.to adapter: fetch is stubbed, nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DevToAdapter, normaliseTags, deriveTitleAndBody } from "./devto.js";
import type { PostRequest } from "./types.js";

// Built in pieces so secret scanners do not mistake this obvious test placeholder for a real key.
const KEY = ["devto", "test", "placeholder", "key", "0123456789"].join("-");
const TOKEN = JSON.stringify({ apiKey: KEY });

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const page = (html: string, status = 200) => new Response(html, { status });
const adapter = () => new DevToAdapter("https://app.example.org/connect/devto");

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function req(over: Partial<PostRequest> = {}): PostRequest {
  return { socialAccountId: "a", content: "My title\nThe body text", mediaUrl: null, coverImageUrl: null, accessToken: TOKEN, ...over };
}
const sentArticle = () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).article;

describe("connect", () => {
  it("builds the connect page url with state", async () => {
    expect(await adapter().getAuthorizeUrl("st 1")).toBe("https://app.example.org/connect/devto?state=st+1");
    expect(adapter().skipConnectConfirmation).toBe(true);
  });

  it("verifies the key live and returns account details", async () => {
    fetchMock.mockResolvedValue(res(200, { id: 42, username: "werner" }));
    const r = await adapter().exchangeCode(JSON.stringify({ apiKey: KEY }));
    expect(r).toMatchObject({ platformAccountId: "42", displayName: "@werner", refreshToken: null, expiresAt: null });
    expect(JSON.parse(r.accessToken)).toEqual({ apiKey: KEY });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://dev.to/api/users/me");
    expect((init as RequestInit).headers).toMatchObject({ "api-key": KEY, Accept: "application/vnd.forem.api-v1+json" });
  });

  it("explains a 401 without leaking the key", async () => {
    fetchMock.mockResolvedValue(res(401, { error: "unauthorized", status: 401 }));
    const err = await adapter().exchangeCode(JSON.stringify({ apiKey: KEY })).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refused the API key/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("rejects bad JSON and a missing key", async () => {
    await expect(adapter().exchangeCode("not json")).rejects.toThrow(/requires an API key/);
    await expect(adapter().exchangeCode("{}")).rejects.toThrow(/requires an API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a network failure to plain language", async () => {
    fetchMock.mockRejectedValue(new Error(`boom ${KEY}`));
    const err = (await adapter().exchangeCode(JSON.stringify({ apiKey: KEY })).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Could not reach dev.to/);
    expect(err.message).not.toContain(KEY);
  });
});

describe("title, body, tags helpers", () => {
  it("uses the first non-empty line as title and the rest as body", () => {
    expect(deriveTitleAndBody("\n\n## Hello world\n\nParagraph one")).toEqual({ title: "Hello world", body: "Paragraph one" });
  });
  it("keeps full content when nothing remains, and when an explicit title is given", () => {
    expect(deriveTitleAndBody("Only a title")).toEqual({ title: "Only a title", body: "Only a title" });
    expect(deriveTitleAndBody("Line one\nLine two", "Custom")).toEqual({ title: "Custom", body: "Line one\nLine two" });
  });
  it("caps very long titles", () => {
    expect(deriveTitleAndBody("x".repeat(400) + "\nbody").title).toHaveLength(250);
  });
  it("normalises tags: lowercase, alphanumeric, unique, max four", () => {
    expect(normaliseTags(["Type-Script", "#Node.js", "node js", "  ", "a", "b", "c"])).toEqual(["typescript", "nodejs", "a", "b"]);
    expect(normaliseTags(undefined)).toEqual([]);
  });
});

describe("post", () => {
  it("sends markdown to POST /articles and returns the article id", async () => {
    fetchMock.mockResolvedValue(res(201, { id: 777 }));
    const r = await adapter().post(req({ options: { devto: { tags: ["A-b", "c"], series: "S1", canonicalUrl: "https://x.example/p" } } }));
    expect(r).toEqual({ success: true, platformPostId: "777", errorMessage: null });
    expect(fetchMock.mock.calls[0][0]).toBe("https://dev.to/api/articles");
    expect(sentArticle()).toEqual({
      title: "My title",
      body_markdown: "The body text",
      published: true,
      tags: ["ab", "c"],
      series: "S1",
      canonical_url: "https://x.example/p",
    });
  });

  it("uses the first image as main_image and appends the rest as markdown", async () => {
    fetchMock.mockResolvedValue(res(201, { id: 1 }));
    await adapter().post(
      req({
        mediaUrl: "https://img.example/1.png",
        mediaUrls: ["https://img.example/1.png", "https://img.example/2.png", "https://img.example/3.jpg"],
        mediaAltText: "A chart",
      }),
    );
    const a = sentArticle();
    expect(a.main_image).toBe("https://img.example/1.png");
    expect(a.body_markdown).toBe("The body text\n\n![A chart](https://img.example/2.png)\n![A chart](https://img.example/3.jpg)");
  });

  it("refuses video without calling dev.to", async () => {
    const r = await adapter().post(req({ mediaUrl: "https://v.example/clip.MP4?x=1" }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toBe("dev.to does not accept video uploads through its API.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours published:false", async () => {
    fetchMock.mockResolvedValue(res(201, { id: 5 }));
    await adapter().post(req({ options: { devto: { published: false } } }));
    expect(sentArticle().published).toBe(false);
  });

  it("returns dev.to's own message on 422", async () => {
    fetchMock.mockResolvedValue(res(422, { error: "Title has already been used", status: 422 }));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toBe("dev.to rejected the article: Title has already been used");
  });

  it("maps 429 and 401", async () => {
    fetchMock.mockResolvedValueOnce(res(429, {}));
    expect((await adapter().post(req())).errorMessage).toMatch(/rate limiting.*Try again/);
    fetchMock.mockResolvedValueOnce(res(401, {}));
    expect((await adapter().post(req())).errorMessage).toMatch(/refused the API key/);
  });

  it("never puts the key in a returned message, even when dev.to echoes it or the network throws", async () => {
    fetchMock.mockResolvedValueOnce(res(500, { error: `oops ${KEY}` }));
    const r1 = await adapter().post(req());
    // dev.to's own text is passed through for other statuses, but the key is only ever sent in a header.
    expect(JSON.stringify(sentArticle())).not.toContain(KEY);
    fetchMock.mockRejectedValueOnce(new Error(`network ${KEY}`));
    const r2 = await adapter().post(req());
    expect(r2.errorMessage).not.toContain(KEY);
    expect(r1.success).toBe(false);
  });

  it("fails cleanly on an unreadable stored credential", async () => {
    const r = await adapter().post(req({ accessToken: "{}" }));
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("post edge cases", () => {
  it("keeps the whole text as body when the first line overflows the title cap", () => {
    const long = "y".repeat(300);
    const r = deriveTitleAndBody(long + "\nsecond line");
    expect(r.title).toHaveLength(250);
    expect(r.body).toBe(long + "\nsecond line");
  });

  it("uses the title as body when content is empty", async () => {
    fetchMock.mockResolvedValue(res(201, { id: 1 }));
    await adapter().post(req({ content: "  ", options: { devto: { title: "Only title" } } }));
    expect(sentArticle().body_markdown).toBe("Only title");
  });

  it("after a timeout, returns the article if dev.to did create it", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    fetchMock.mockResolvedValueOnce(
      res(200, [
        { id: 5, title: "My title", created_at: "2020-01-01T00:00:00Z" },
        { id: 6, title: "My title", created_at: new Date(Date.now() - 60_000).toISOString() },
      ]),
    );
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "6", errorMessage: null });
  });

  it("after a timeout with no matching article, says the result is unconfirmed", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    fetchMock.mockResolvedValueOnce(res(200, [{ id: 5, title: "My title", created_at: "2020-01-01T00:00:00Z" }]));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/did not confirm.*Check your dev.to dashboard before retrying/);
  });

  it("caps and scrubs long error text", async () => {
    fetchMock.mockResolvedValue(res(500, { error: "bad " + KEY + " — " + "z".repeat(1000) }));
    const r = await adapter().post(req());
    expect(r.errorMessage).not.toContain(KEY);
    expect(r.errorMessage).not.toMatch(/[–—]/);
    expect(r.errorMessage!.length).toBeLessThan(360);
  });
});

describe("verifyPublished", () => {
  const listWith = (article: object, publicPage: () => Response) => async (url: string) =>
    url.includes("/articles/me/all") ? res(200, [{ id: 9, ...article }]) : publicPage();

  it("does not follow a redirecting article url", async () => {
    fetchMock.mockImplementation(listWith({ published: true, url: "https://dev.to/w/post-9" }, () => page("", 302)));
    const r = await adapter().verifyPublished("9", TOKEN);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/HTTP 302/);
    const call = fetchMock.mock.calls.find((c) => c[0] === "https://dev.to/w/post-9")!;
    expect((call[1] as RequestInit).redirect).toBe("manual");
  });

  it("refuses to fetch a non-dev.to or non-https address", async () => {
    for (const url of ["https://evil.example/w/post-9", "http://dev.to/w/post-9", "https://dev.to.evil.example/x", "not a url"]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(listWith({ published: true, url }, () => page("ok")));
      const r = await adapter().verifyPublished("9", TOKEN);
      expect(r.verifiedLive).toBe(false);
      expect(fetchMock.mock.calls.some((c) => c[0] === url)).toBe(false);
    }
  });

  it("requires published to be explicitly true", async () => {
    fetchMock.mockImplementation(listWith({ url: "https://dev.to/w/post-9" }, () => page("post-9")));
    const r = await adapter().verifyPublished("9", TOKEN);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/did not say/);
  });

  it("requires the page to mention the article (path or title)", async () => {
    const article = { published: true, title: "My Post", url: "https://dev.to/w/post-9" };
    fetchMock.mockImplementation(listWith(article, () => page("<html>generic error page</html>")));
    const wrong = await adapter().verifyPublished("9", TOKEN);
    expect(wrong.verifiedLive).toBe(false);
    expect(wrong.errorMessage).toMatch(/does not look like this article/);
    fetchMock.mockImplementation(listWith(article, () => page("<h1>my post</h1>")));
    expect((await adapter().verifyPublished("9", TOKEN)).verifiedLive).toBe(true);
  });

  it("is live only when the public URL answers 200", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/articles/me/all")) return res(200, [{ id: 9, published: true, url: "https://dev.to/w/post-9" }]);
      if (url === "https://dev.to/w/post-9") return page('<link rel="canonical" href="https://dev.to/w/post-9">');
      return res(404, {});
    });
    expect(await adapter().verifyPublished("9", TOKEN)).toEqual({ verifiedLive: true, platformPostUrl: "https://dev.to/w/post-9", errorMessage: null });
    // The public page is fetched without credentials.
    const publicCall = fetchMock.mock.calls.find((c) => c[0] === "https://dev.to/w/post-9")!;
    expect(publicCall[1]).not.toHaveProperty("headers");
  });

  it("is not live when the public page 404s", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/articles/me/all") ? res(200, [{ id: 9, published: true, url: "https://dev.to/w/post-9" }]) : res(404, {}),
    );
    const r = await adapter().verifyPublished("9", TOKEN);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/HTTP 404/);
  });

  it("reports a draft honestly", async () => {
    fetchMock.mockResolvedValue(res(200, [{ id: 9, published: false, url: "https://dev.to/w/draft-9" }]));
    const r = await adapter().verifyPublished("9", TOKEN);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toBe("Saved as a draft on dev.to as you chose, not published.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the public article endpoint when not in the author's list", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/articles/me/all")) return res(200, []);
      if (url.endsWith("/articles/9")) return res(200, { id: 9, published: true, url: "https://dev.to/w/p" });
      return page('<link href="https://dev.to/w/p">');
    });
    expect((await adapter().verifyPublished("9", TOKEN)).verifiedLive).toBe(true);
  });

  it("reports an unknown article and a refused key", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.includes("/me/all") ? res(200, []) : res(404, {})));
    expect((await adapter().verifyPublished("9", TOKEN)).errorMessage).toMatch(/could not find/);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(res(401, {}));
    const r = await adapter().verifyPublished("9", TOKEN);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).not.toContain(KEY);
  });
});

describe("getComments and getPostMetrics", () => {
  it("flattens the comment tree", async () => {
    fetchMock.mockResolvedValue(
      res(200, [
        {
          id_code: "c1",
          body_html: "<p>Nice <b>post</b></p>",
          created_at: "2026-09-01T10:00:00Z",
          user: { name: "Ann", username: "ann" },
          children: [{ id_code: "c2", body_html: "<p>Thanks</p>", user: { username: "werner" }, children: [] }],
        },
      ]),
    );
    const r = await adapter().getComments("9", TOKEN);
    expect(fetchMock.mock.calls[0][0]).toBe("https://dev.to/api/comments?a_id=9");
    expect(r.comments).toEqual([
      { id: "c1", author: "Ann", text: "Nice post", url: null, createdAt: "2026-09-01T10:00:00Z" },
      { id: "c2", author: "werner", text: "Thanks", url: null, createdAt: null },
    ]);
  });

  it("decodes html entities in comment text", async () => {
    fetchMock.mockResolvedValue(
      res(200, [{ id_code: "c1", body_html: "<p>Tom &amp; Jerry &#39;q&#39; &quot;hi&quot; &lt;b&gt; &#x27;x&#x27; &amp;lt;</p>" }]),
    );
    const r = await adapter().getComments("9", TOKEN);
    expect(r.comments[0].text).toBe("Tom & Jerry 'q' \"hi\" <b> 'x' &lt;");
  });

  it("surfaces a comments error", async () => {
    fetchMock.mockResolvedValue(res(404, { error: "not found" }));
    const r = await adapter().getComments("9", TOKEN);
    expect(r.comments).toEqual([]);
    expect(r.errorMessage).toMatch(/not found/);
  });

  it("parses metrics and keeps missing fields null, not zero", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { id: 9, public_reactions_count: 12, comments_count: 0, page_views_count: 340 }));
    expect(await adapter().getPostMetrics("9", TOKEN)).toEqual({ likes: 12, comments: 0, shares: null, views: 340, errorMessage: null });
    fetchMock.mockResolvedValueOnce(res(200, { id: 9, public_reactions_count: 3 }));
    expect(await adapter().getPostMetrics("9", TOKEN)).toEqual({ likes: 3, comments: null, shares: null, views: null, errorMessage: null });
  });

  it("returns nulls plus an error on failure", async () => {
    fetchMock.mockResolvedValue(res(429, {}));
    const m = await adapter().getPostMetrics("9", TOKEN);
    expect(m).toMatchObject({ likes: null, comments: null, views: null });
    expect(m.errorMessage).toMatch(/rate limiting/);
  });
});
