// Hashnode adapter: connect (publication choice), title/body derivation, tags, images,
// draft vs publish, GraphQL error mapping, and proof of publish. fetch is stubbed;
// nothing real is called and no real token appears anywhere.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../urlSafety.js", () => ({ isSafeMediaUrl: vi.fn(async () => ({ safe: true, addresses: ["203.0.113.10"] })) }));

import { HashnodeAdapter, buildTags, slugifyTag, deriveTitleAndBody } from "./hashnode.js";
import { isSafeMediaUrl } from "../urlSafety.js";

const TOKEN = "hn-secret-token-1234";
const CREDS = JSON.stringify({ token: TOKEN, publicationId: "pub1" });
const POST_URL = "https://blog.example.hashnode.dev/my-post";

let fetchMock: ReturnType<typeof vi.fn>;
const jsonRes = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const gqlOk = (data: unknown) => jsonRes(200, { data });
const gqlErr = (message: string, code?: string) => jsonRes(200, { errors: [{ message, extensions: code ? { code } : {} }], data: null });
const adapter = () => new HashnodeAdapter("https://app.example.org/connect/hashnode");

function pub(id: string, title: string, url: string) {
  return { node: { id, title, url } };
}
function pubsReply(edges: unknown[]) {
  return gqlOk({ me: { id: "u1", username: "someone", publications: { edges } } });
}

/** The GraphQL calls only (not the public page check), parsed. */
function gqlCalls() {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("gql-beta.hashnode.com"))
    .map((c) => ({ init: c[1] as RequestInit, body: JSON.parse((c[1] as RequestInit).body as string) as { query: string; variables: Record<string, any> } }));
}

const request = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "First line\nThe body.", mediaUrl: null, coverImageUrl: null, accessToken: CREDS, ...over }) as never;

beforeEach(() => {
  fetchMock = vi.fn(async () => gqlOk({}));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(isSafeMediaUrl).mockResolvedValue({ safe: true, addresses: ["203.0.113.10"] });
});
afterEach(() => vi.unstubAllGlobals());

describe("connect", () => {
  it("builds the connect page address with the state and skips the confirm step", async () => {
    const a = adapter();
    expect(a.skipConnectConfirmation).toBe(true);
    expect(await a.getAuthorizeUrl("st 1")).toBe("https://app.example.org/connect/hashnode?state=st+1");
  });

  it("connects when the account has exactly one blog", async () => {
    fetchMock.mockResolvedValue(pubsReply([pub("pub1", "My Blog", "https://myblog.hashnode.dev")]));
    const r = await adapter().exchangeCode(JSON.stringify({ token: TOKEN }));
    expect(r).toMatchObject({ platformAccountId: "pub1", displayName: "My Blog (myblog.hashnode.dev)", refreshToken: null, expiresAt: null });
    expect(JSON.parse(r.accessToken)).toEqual({ token: TOKEN, publicationId: "pub1" });
    expect(gqlCalls()[0].body.query).toContain("publications(first:");
    expect((gqlCalls()[0].init.headers as Record<string, string>).Authorization).toBe(TOKEN);
  });

  it("picks the blog the customer named when there are several", async () => {
    fetchMock.mockResolvedValue(
      pubsReply([pub("pub1", "One", "https://one.hashnode.dev"), pub("pub2", "Two", "https://two.hashnode.dev"), pub("pub3", "Custom", "https://writing.example.com")]),
    );
    const two = await adapter().exchangeCode(JSON.stringify({ token: TOKEN, publicationHost: "https://Two.hashnode.dev/" }));
    expect(two.platformAccountId).toBe("pub2");
    const custom = await adapter().exchangeCode(JSON.stringify({ token: TOKEN, publicationHost: "writing.example.com" }));
    expect(custom.platformAccountId).toBe("pub3");
  });

  it("asks for the blog address when there are several and none was given", async () => {
    fetchMock.mockResolvedValue(pubsReply([pub("pub1", "One", "https://one.hashnode.dev"), pub("pub2", "Two", "https://two.hashnode.dev")]));
    await expect(adapter().exchangeCode(JSON.stringify({ token: TOKEN }))).rejects.toThrow(/more than one blog.*address/);
  });

  it("fails when the named blog is not on the account", async () => {
    fetchMock.mockResolvedValue(pubsReply([pub("pub1", "One", "https://one.hashnode.dev")]));
    await expect(adapter().exchangeCode(JSON.stringify({ token: TOKEN, publicationHost: "other.hashnode.dev" }))).rejects.toThrow(/Could not find a blog with that address/);
  });

  it("fails when the account has no blog", async () => {
    fetchMock.mockResolvedValue(pubsReply([]));
    await expect(adapter().exchangeCode(JSON.stringify({ token: TOKEN }))).rejects.toThrow(/no blog yet/);
  });

  it("fails without a token in the form", async () => {
    await expect(adapter().exchangeCode(JSON.stringify({ publicationHost: "x.hashnode.dev" }))).rejects.toThrow(/personal access token/);
    await expect(adapter().exchangeCode("not json")).rejects.toThrow(/personal access token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the token was refused when Hashnode will not log it in (and tries the Bearer form once)", async () => {
    fetchMock.mockResolvedValue(gqlErr("You must be logged in", "UNAUTHENTICATED"));
    await expect(adapter().exchangeCode(JSON.stringify({ token: TOKEN }))).rejects.toThrow("Hashnode refused the token. Reconnect this account.");
    const auth = gqlCalls().map((c) => (c.init.headers as Record<string, string>).Authorization);
    expect(auth).toEqual([TOKEN, `Bearer ${TOKEN}`]);
  });

  it("uses the Bearer form when only that one is accepted", async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization.startsWith("Bearer ")
        ? pubsReply([pub("pub1", "My Blog", "https://myblog.hashnode.dev")])
        : gqlErr("You must be logged in", "UNAUTHENTICATED"),
    );
    const r = await adapter().exchangeCode(JSON.stringify({ token: TOKEN }));
    expect(r.platformAccountId).toBe("pub1");
  });

  it("tells the customer when the blog needs a Pro plan", async () => {
    fetchMock.mockResolvedValue(gqlErr("Publication is not on a Pro plan. Upgrade to use the API.", "FORBIDDEN"));
    await expect(adapter().exchangeCode(JSON.stringify({ token: TOKEN }))).rejects.toThrow(/needs a Pro plan/);
  });
});

describe("title and body", () => {
  it("uses the first non-empty line as the title, without markdown #, and the rest as the body", () => {
    expect(deriveTitleAndBody("\n\n## My Title\n\nBody one.\n\nBody two.")).toEqual({ title: "My Title", body: "Body one.\n\nBody two." });
  });

  it("keeps the full text as the body when a title is given", () => {
    expect(deriveTitleAndBody("Line one\nLine two", "  Given Title ")).toEqual({ title: "Given Title", body: "Line one\nLine two" });
  });

  it("uses the title as the body when there is nothing else", () => {
    expect(deriveTitleAndBody("# Only a title")).toEqual({ title: "Only a title", body: "Only a title" });
  });

  it("cuts a very long first line to 250 characters for the title but keeps all text in the body", () => {
    const long = "a".repeat(300);
    const r = deriveTitleAndBody(`${long}\nmore`);
    expect(r.title).toHaveLength(250);
    expect(r.body).toBe(`${long}\nmore`);
  });

  it("is sent to Hashnode as markdown, as is", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: { id: "p1", url: POST_URL } } }));
    await adapter().post(request({ content: "# Title\n\n**bold** and [link](https://x.example)\n\n- a\n- b" }));
    const input = gqlCalls()[0].body.variables.input;
    expect(input.title).toBe("Title");
    expect(input.contentMarkdown).toBe("**bold** and [link](https://x.example)\n\n- a\n- b");
  });

  it("refuses a post with no text at all", async () => {
    const r = await adapter().post(request({ content: "  \n " }));
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tags", () => {
  it("slugifies to lowercase with hyphens and keeps the readable name", () => {
    expect(slugifyTag("#Machine Learning!")).toBe("machine-learning");
    expect(buildTags(["Web Dev", "#TypeScript"])).toEqual([
      { slug: "web-dev", name: "Web Dev" },
      { slug: "typescript", name: "TypeScript" },
    ]);
  });

  it("drops empty and duplicate tags and stops at five", () => {
    const tags = buildTags(["a", "A", "!!!", "b", "c", "d", "e", "f", "g"]);
    expect(tags.map((t) => t.slug)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("sends the tags on the publish call", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: { id: "p1" } } }));
    await adapter().post(request({ options: { hashnode: { tags: ["Node JS", "api"] } } }));
    expect(gqlCalls()[0].body.variables.input.tags).toEqual([
      { slug: "node-js", name: "Node JS" },
      { slug: "api", name: "api" },
    ]);
  });
});

describe("images", () => {
  it("publishing: first image is the cover (plain coverImage), the others are markdown images with alt text", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: { id: "p1" } } }));
    await adapter().post(
      request({ mediaUrl: "https://cdn.example/a.png", mediaUrls: ["https://cdn.example/b.png", "https://cdn.example/c.jpg"], mediaAltText: "A [red] door" }),
    );
    const input = gqlCalls()[0].body.variables.input;
    expect(input.coverImage).toBe("https://cdn.example/a.png");
    expect(input.coverImageOptions).toBeUndefined();
    expect(input.contentMarkdown).toBe("The body.\n\n![A red door](https://cdn.example/b.png)\n\n![A red door](https://cdn.example/c.jpg)");
  });

  it("does not repeat the cover image in the body when mediaUrls also lists it", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: { id: "p1" } } }));
    await adapter().post(request({ mediaUrl: "https://cdn.example/a.png", mediaUrls: ["https://cdn.example/a.png", "https://cdn.example/b.png"] }));
    const input = gqlCalls()[0].body.variables.input;
    expect(input.contentMarkdown).toBe("The body.\n\n![Image](https://cdn.example/b.png)");
  });

  it("draft: the cover goes in coverImageOptions", async () => {
    fetchMock.mockResolvedValue(gqlOk({ createDraft: { draft: { id: "d1" } } }));
    await adapter().post(request({ mediaUrl: "https://cdn.example/a.png", options: { hashnode: { draft: true } } }));
    const input = gqlCalls()[0].body.variables.input;
    expect(input.coverImageOptions).toEqual({ coverImageURL: "https://cdn.example/a.png" });
    expect(input.coverImage).toBeUndefined();
  });

  it("refuses a video before calling Hashnode", async () => {
    const r1 = await adapter().post(request({ mediaUrl: "https://cdn.example/clip.mp4" }));
    const r2 = await adapter().post(request({ mediaUrl: "https://cdn.example/a.png", mediaUrls: ["https://cdn.example/clip.mov?x=1"] }));
    for (const r of [r1, r2]) {
      expect(r.success).toBe(false);
      expect(r.errorMessage).toMatch(/cannot carry a video/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publish and draft", () => {
  it("publishes to the connected blog and returns the post id", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: { id: "post123", url: POST_URL } } }));
    const r = await adapter().post(
      request({ options: { hashnode: { title: "Custom", subtitle: "Sub", canonicalUrl: "https://origin.example/p" } } }),
    );
    expect(r).toEqual({ success: true, platformPostId: "post123", errorMessage: null });
    const call = gqlCalls()[0];
    expect(call.body.query).toContain("publishPost");
    expect(call.body.variables.input).toMatchObject({
      publicationId: "pub1",
      title: "Custom",
      subtitle: "Sub",
      originalArticleURL: "https://origin.example/p",
      contentMarkdown: "First line\nThe body.",
    });
    expect(call.body.variables.input.publishedAt).toBeUndefined(); // publishedAt only backdates in the schema
  });

  it("creates a draft, not a post, when draft is true, and prefixes the id", async () => {
    fetchMock.mockResolvedValue(gqlOk({ createDraft: { draft: { id: "draft9" } } }));
    const r = await adapter().post(request({ options: { hashnode: { draft: true } } }));
    expect(r).toEqual({ success: true, platformPostId: "draft:draft9", errorMessage: null });
    expect(gqlCalls()[0].body.query).toContain("createDraft");
    expect(gqlCalls()[0].body.query).not.toContain("publishPost");
  });

  it("maps a refused token to the reconnect message", async () => {
    fetchMock.mockResolvedValue(gqlErr("You must be logged in", "UNAUTHENTICATED"));
    const r = await adapter().post(request());
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Hashnode refused the token. Reconnect this account." });
  });

  it("maps HTTP 401 the same way", async () => {
    fetchMock.mockResolvedValue(jsonRes(401, {}));
    const r = await adapter().post(request());
    expect(r.errorMessage).toBe("Hashnode refused the token. Reconnect this account.");
  });

  it("passes other GraphQL errors on in plain words, with no long dashes and no token", async () => {
    fetchMock.mockResolvedValue(gqlErr(`Slug already used — pick another (${TOKEN})`, "BAD_USER_INPUT"));
    const r = await adapter().post(request());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/Slug already used - pick another/);
    expect(r.errorMessage).not.toMatch(/[–—]/);
    expect(r.errorMessage).not.toContain(TOKEN);
  });

  it("reports a network failure plainly", async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNRESET ${TOKEN}`));
    const r = await adapter().post(request());
    expect(r.errorMessage).toMatch(/Check your Hashnode blog before trying again/);
    expect(r.errorMessage).not.toContain(TOKEN);
  });

  it("fails on a damaged saved connection without calling Hashnode", async () => {
    const r = await adapter().post(request({ accessToken: "not-json" }));
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not claim success when Hashnode returns no post id", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: null } }));
    const r = await adapter().post(request());
    expect(r.success).toBe(false);
  });
});

describe("double-post protection", () => {
  const recent = (minutesAgo = 1) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  function timeoutThen(recentReply: Response | Error) {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const q = JSON.parse(init.body as string).query as string;
      if (q.includes("mutation")) throw new Error("The operation was aborted due to timeout");
      if (recentReply instanceof Error) throw recentReply;
      return recentReply;
    });
  }

  it("selects only the post id from the publish mutation", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: { id: "p1" } } }));
    await adapter().post(request());
    expect(gqlCalls()[0].body.query).toMatch(/post \{ id \}/);
    expect(gqlCalls()[0].body.query).not.toContain("url");
  });

  it("counts a post as created when an id came back even if the response also carries errors", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { data: { publishPost: { post: { id: "p1" } } }, errors: [{ message: "url failed" }] }));
    expect(await adapter().post(request())).toEqual({ success: true, platformPostId: "p1", errorMessage: null });
  });

  it("after a timeout, finds the post Hashnode did create and reports success (no retry, no double post)", async () => {
    timeoutThen(gqlOk({ publication: { posts: { edges: [{ node: { id: "old", title: "Other", publishedAt: recent(500) } }, { node: { id: "made", title: "first line", publishedAt: recent() } }] } } }));
    const r = await adapter().post(request());
    expect(r).toEqual({ success: true, platformPostId: "made", errorMessage: null });
    expect(gqlCalls().filter((c) => c.body.query.includes("mutation"))).toHaveLength(1);
    expect(gqlCalls()[1].body.variables).toEqual({ id: "pub1" });
  });

  it("after a timeout with no matching recent post, says it is unconfirmed and to check Hashnode", async () => {
    timeoutThen(gqlOk({ publication: { posts: { edges: [{ node: { id: "old", title: "First line", publishedAt: recent(500) } }] } } }));
    const r = await adapter().post(request());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/unclear whether.*Check your Hashnode blog before trying again/);
  });

  it("after a timeout where the lookup also fails, reports unconfirmed", async () => {
    timeoutThen(new Error("still down"));
    const r = await adapter().post(request());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/Check your Hashnode blog/);
  });

  it("a draft that timed out is looked up in the drafts list", async () => {
    timeoutThen(gqlOk({ publication: { drafts: { edges: [{ node: { id: "dd", title: "First line", updatedAt: recent() } }] } } }));
    const r = await adapter().post(request({ options: { hashnode: { draft: true } } }));
    expect(r).toEqual({ success: true, platformPostId: "draft:dd", errorMessage: null });
    expect(gqlCalls()[1].body.query).toContain("drafts(first: 5)");
  });

  it("does not go looking after an ordinary refusal", async () => {
    fetchMock.mockResolvedValue(gqlErr("Title too long", "BAD_USER_INPUT"));
    await adapter().post(request());
    expect(gqlCalls()).toHaveLength(1);
  });
});

describe("error wording", () => {
  it("does not claim a Pro plan problem for a non-403 error that mentions subscription", async () => {
    fetchMock.mockResolvedValue(gqlErr("Newsletter subscription settings are invalid", "BAD_USER_INPUT"));
    const r = await adapter().post(request());
    expect(r.errorMessage).not.toMatch(/Pro plan/);
    expect(r.errorMessage).toMatch(/Newsletter subscription settings are invalid/);
  });

  it("still says Pro plan for a FORBIDDEN or HTTP 403 refusal", async () => {
    fetchMock.mockResolvedValue(gqlErr("Upgrade to Pro to use the API", "FORBIDDEN"));
    expect((await adapter().post(request())).errorMessage).toMatch(/needs a Pro plan/);
    fetchMock.mockResolvedValue(jsonRes(403, { errors: [{ message: "Pro plan required" }] }));
    expect((await adapter().post(request())).errorMessage).toMatch(/needs a Pro plan/);
  });
});

describe("verifyPublished", () => {
  const postReply = (over: Record<string, unknown> = {}) => gqlOk({ post: { id: "p1", url: POST_URL, title: "Hello Post", slug: "my-post", publishedAt: "2026-09-01T10:00:00.000Z", ...over } });
  const PAGE_HTML = "<html><head><title>Hello Post</title></head><body>hi</body></html>";

  function routeFetch(pageStatus: number, postBody: Response = postReply()) {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("gql-beta") ? postBody : new Response(pageStatus === 200 ? PAGE_HTML : "nope", { status: pageStatus })));
  }

  it("is verified only when the post is published and its public page answers 200 without a token", async () => {
    routeFetch(200);
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r).toEqual({ verifiedLive: true, platformPostUrl: POST_URL, errorMessage: null });
    const pageCall = fetchMock.mock.calls.find((c) => c[0] === POST_URL)!;
    expect((pageCall[1] as RequestInit).headers).toBeUndefined();
  });

  it("is not verified when the public page is not 200", async () => {
    routeFetch(404);
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/HTTP 404/);
  });

  it("does not follow a redirect to an internal address: it is never fetched", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("gql-beta")) return postReply();
      if (url === POST_URL) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      return new Response(PAGE_HTML, { status: 200 });
    });
    vi.mocked(isSafeMediaUrl).mockImplementation(async (u: string) => (u.includes("169.254") ? { safe: false, reason: "private" } : { safe: true, addresses: ["203.0.113.10"] }));
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("169.254"))).toBe(false);
    for (const c of fetchMock.mock.calls.filter((c) => !String(c[0]).includes("gql-beta"))) expect((c[1] as RequestInit).redirect).toBe("manual");
  });

  it("does not accept a redirect that ends on a different host, even a safe one", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("gql-beta")) return postReply();
      if (url === POST_URL) return new Response(null, { status: 301, headers: { location: "https://parked.example.net/" } });
      return new Response(PAGE_HTML, { status: 200 });
    });
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/different website/);
  });

  it("follows a redirect that stays on the same host", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("gql-beta")) return postReply();
      if (url === POST_URL) return new Response(null, { status: 301, headers: { location: `${POST_URL}/` } });
      return new Response(PAGE_HTML, { status: 200 });
    });
    expect((await adapter().verifyPublished("p1", CREDS)).verifiedLive).toBe(true);
  });

  it("gives up after 3 redirects", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("gql-beta")) return postReply();
      return new Response(null, { status: 302, headers: { location: `${POST_URL}/${Math.random()}` } });
    });
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(fetchMock.mock.calls.filter((c) => !String(c[0]).includes("gql-beta"))).toHaveLength(4);
  });

  it("a parked domain that answers 200 without the title or slug is not verified", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("gql-beta") ? postReply() : new Response("<html><body>This domain is for sale</body></html>", { status: 200 }),
    );
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/does not show this article's title/);
  });

  it("accepts the slug when the title is absent, and decodes entities in the title", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("gql-beta") ? postReply({ title: "Tom & Jerry" }) : new Response('<a href="/my-post">x</a>', { status: 200 }),
    );
    expect((await adapter().verifyPublished("p1", CREDS)).verifiedLive).toBe(true);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("gql-beta") ? postReply({ title: "Tom & Jerry", slug: "zzz" }) : new Response("<title>Tom &amp; Jerry</title>", { status: 200 }),
    );
    expect((await adapter().verifyPublished("p1", CREDS)).verifiedLive).toBe(true);
  });

  it("only reads the first 64 KB of the page", async () => {
    const big = "x".repeat(70 * 1024) + "Hello Post";
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("gql-beta") ? postReply({ slug: "zzz" }) : new Response(big, { status: 200 })));
    expect((await adapter().verifyPublished("p1", CREDS)).verifiedLive).toBe(false);
  });

  it("is not verified when the public page cannot be reached", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("gql-beta")) return postReply();
      throw new Error("boom");
    });
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
  });

  it("is not verified when the publish time is still in the future", async () => {
    routeFetch(200, postReply({ publishedAt: "2999-01-01T00:00:00.000Z" }));
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/not published yet/);
  });

  it("is not verified when Hashnode does not know the post", async () => {
    routeFetch(200, gqlOk({ post: null }));
    const r = await adapter().verifyPublished("gone", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/does not show this article/);
  });

  it("does not touch the public address when it fails the safety check", async () => {
    routeFetch(200);
    vi.mocked(isSafeMediaUrl).mockResolvedValue({ safe: false, reason: "private" });
    const r = await adapter().verifyPublished("p1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(fetchMock.mock.calls.some((c) => c[0] === POST_URL)).toBe(false);
  });

  it("a draft is honestly reported as saved, not published", async () => {
    fetchMock.mockResolvedValue(gqlOk({ draft: { id: "d1" } }));
    const r = await adapter().verifyPublished("draft:d1", CREDS);
    expect(r).toEqual({ verifiedLive: false, platformPostUrl: null, errorMessage: "Saved as a draft on Hashnode as you chose, not published", savedAsDraft: true });
    expect(gqlCalls()[0].body.variables).toEqual({ id: "d1" });
  });

  it("a draft that has vanished is reported as missing", async () => {
    fetchMock.mockResolvedValue(gqlOk({ draft: null }));
    const r = await adapter().verifyPublished("draft:d1", CREDS);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toMatch(/could not be found/);
  });
});

describe("metrics and comments", () => {
  it("reads views, reactions and comments; shares stay null", async () => {
    fetchMock.mockResolvedValue(gqlOk({ post: { views: 120, reactionCount: 7, responseCount: 3 } }));
    expect(await adapter().getPostMetrics("p1", CREDS)).toEqual({ likes: 7, comments: 3, shares: null, views: 120, errorMessage: null });
  });

  it("keeps unknown numbers null, not zero", async () => {
    fetchMock.mockResolvedValue(gqlOk({ post: { views: null, reactionCount: 0, responseCount: 0 } }));
    const m = await adapter().getPostMetrics("p1", CREDS);
    expect(m.views).toBeNull();
    expect(m.likes).toBe(0);
  });

  it("lists comments", async () => {
    fetchMock.mockResolvedValue(
      gqlOk({ post: { url: POST_URL, comments: { edges: [{ node: { id: "c1", dateAdded: "2026-09-02T00:00:00Z", content: { text: " Nice " }, author: { name: "Sam", username: "sam" } } }] } } }),
    );
    expect(await adapter().getComments("p1", CREDS)).toEqual({
      comments: [{ id: "c1", author: "Sam", text: "Nice", url: POST_URL, createdAt: "2026-09-02T00:00:00Z" }],
      errorMessage: null,
    });
  });
});

describe("the token stays private", () => {
  it("never appears in any error or message, whatever fails", async () => {
    const messages: string[] = [];
    const scenarios: Response[] = [
      gqlErr(`bad ${TOKEN}`, "BAD_USER_INPUT"),
      gqlErr(`forbidden ${TOKEN}`, "FORBIDDEN"),
      gqlErr(TOKEN, "UNAUTHENTICATED"),
      jsonRes(500, { errors: [{ message: `oops ${TOKEN}` }] }),
    ];
    for (const s of scenarios) {
      fetchMock.mockResolvedValue(s);
      const post = await adapter().post(request());
      messages.push(post.errorMessage ?? "");
      messages.push((await adapter().verifyPublished("p1", CREDS)).errorMessage ?? "");
      messages.push((await adapter().getPostMetrics("p1", CREDS)).errorMessage ?? "");
      messages.push((await adapter().getComments("p1", CREDS)).errorMessage ?? "");
      messages.push(await adapter().exchangeCode(JSON.stringify({ token: TOKEN })).then(() => "", (e: Error) => e.message));
    }
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      expect(m).not.toContain(TOKEN);
      expect(m).not.toMatch(/[–—]/);
    }
  });

  it("is sent only in the Authorization header, never in the query or variables", async () => {
    fetchMock.mockResolvedValue(gqlOk({ publishPost: { post: { id: "p1" } } }));
    await adapter().post(request());
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).not.toContain(TOKEN);
    expect(String((call[1] as RequestInit).body)).not.toContain(TOKEN);
  });
});
