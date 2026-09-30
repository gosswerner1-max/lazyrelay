// Tumblr blog choice: the connect picker lists the customer's blogs, the chosen
// blog is stored, and posting uses THAT blog (it used to always use the primary
// blog, whatever was connected). fetch is stubbed; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TumblrAdapter } from "./tumblr.js";

const BLOGS = [
  { name: "side-project", primary: false },
  { name: "main-blog", primary: true },
  { name: "old-blog", primary: false },
];

let fetchMock: ReturnType<typeof vi.fn>;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const adapter = () => new TumblrAdapter("client", "secret", "https://api.example.org/cb");

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/oauth2/token")) return json(200, { access_token: "acc", refresh_token: "ref", expires_in: 3600 });
    if (url.endsWith("/user/info")) return json(200, { response: { user: { blogs: BLOGS } } });
    if (url.includes("/posts")) return json(201, { response: { id: "99" } });
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("connect picker", () => {
  it("must return exactly one choice (a second blog means connecting again)", () => {
    expect(adapter().singleSelection).toBe(true);
  });

  it("lists every blog, the primary first, and keeps the login server-side", async () => {
    const r = await adapter().listConnectOptions("code");
    expect(r.options).toEqual([
      { id: "main-blog", name: "main-blog" },
      { id: "side-project", name: "side-project" },
      { id: "old-blog", name: "old-blog" },
    ]);
    expect(JSON.parse(r.userToken)).toMatchObject({ accessToken: "acc", refreshToken: "ref" });
  });

  it("refuses a Tumblr account with no blog", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/oauth2/token") ? json(200, { access_token: "a" }) : json(200, { response: { user: { blogs: [] } } }),
    );
    await expect(adapter().listConnectOptions("code")).rejects.toThrow(/Could not find a Tumblr blog/);
  });

  it("finalizing stores the CHOSEN blog, not the primary one", async () => {
    const userToken = JSON.stringify({ accessToken: "acc", refreshToken: "ref", expiresAt: "2026-10-01T00:00:00.000Z" });
    const r = await adapter().finalizeConnectOption(userToken, "side-project");
    expect(r).toMatchObject({ accessToken: "acc", refreshToken: "ref", platformAccountId: "side-project", displayName: "side-project" });
  });

  it("finalizing re-checks the blog still belongs to the login", async () => {
    const userToken = JSON.stringify({ accessToken: "acc", refreshToken: null, expiresAt: null });
    await expect(adapter().finalizeConnectOption(userToken, "someone-elses-blog")).rejects.toThrow(/no longer available/);
  });
});

describe("posting uses the connected blog", () => {
  const request = (over: Record<string, unknown> = {}) => ({
    socialAccountId: "sa1",
    content: "hello",
    mediaUrl: null,
    coverImageUrl: null,
    accessToken: "acc",
    ...over,
  });

  it("posts to the blog stored at connect time", async () => {
    const r = await adapter().post(request({ platformAccountId: "side-project" }) as never);
    expect(r).toMatchObject({ success: true, platformPostId: "side-project:99" });
    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/posts"))!;
    expect(String(postCall[0])).toContain("/blog/side-project/posts");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/user/info"))).toBe(false); // no guessing needed
  });

  it("a connection made before blogs could be picked still falls back to the primary blog", async () => {
    const r = await adapter().post(request({ platformAccountId: null }) as never);
    expect(r).toMatchObject({ success: true, platformPostId: "main-blog:99" });
  });
});
