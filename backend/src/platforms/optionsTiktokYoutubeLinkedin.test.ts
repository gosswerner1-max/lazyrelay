// Platform options for TikTok, YouTube and LinkedIn. fetch is stubbed and media
// fetching is mocked; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./streamUpload.js", async (orig) => {
  const actual = await orig<typeof import("./streamUpload.js")>();
  return {
    ...actual,
    fetchMediaForStreaming: vi.fn(async () => ({
      body: new Blob([new Uint8Array(10)]).stream(),
      contentType: "video/mp4",
      sizeBytes: 10,
    })),
  };
});

import { fetchMediaForStreaming } from "./streamUpload.js";
import { TikTokAdapter } from "./tiktok.js";
import { YouTubeAdapter } from "./youtube.js";
import { LinkedInAdapter } from "./linkedin.js";

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: unknown } };
let calls: Call[];
const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status < 400, status, json: async () => body, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as Response;
const stubFetch = (handler: (url: string, init?: Call["init"]) => Response) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: Call["init"]) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
const jsonBody = (c: Call) => JSON.parse(c.init!.body as string);

beforeEach(() => {
  calls = [];
  (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

// ---------------- TikTok ----------------
describe("TikTok is_aigc", () => {
  const tt = () => new TikTokAdapter("k", "s", "https://x/cb");
  const req = (over: Record<string, unknown> = {}) => ({
    socialAccountId: "sa", content: "Hello", mediaUrl: "https://cdn.example.com/v.mp4", mediaUrls: [], coverImageUrl: null,
    accessToken: "tok", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE", ...over,
  });
  const handler = (url: string) => {
    if (url.includes("creator_info")) return res(200, { data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"] } });
    if (url.includes("video/init")) return res(200, { data: { publish_id: "p1", upload_url: "https://up.example.com/u" } });
    if (url === "https://up.example.com/u") return res(201, {});
    return res(404, {});
  };
  const initPostInfo = () => jsonBody(calls.find((c) => c.url.includes("video/init"))!).post_info;

  it("sends is_aigc: true when aiGenerated is true", async () => {
    stubFetch(handler);
    const r = await tt().post(req({ options: { tiktok: { aiGenerated: true } } }) as never);
    expect(r).toEqual({ success: true, platformPostId: "p1", errorMessage: null });
    expect(initPostInfo()).toEqual({
      privacy_level: "PUBLIC_TO_EVERYONE", title: "Hello", disable_duet: true, disable_stitch: true, disable_comment: true,
      brand_organic_toggle: false, brand_content_toggle: false, is_aigc: true,
    });
  });

  it("omits is_aigc without options, with empty options, and when false", async () => {
    for (const options of [undefined, {}, { tiktok: {} }, { tiktok: { aiGenerated: false } }]) {
      calls = [];
      stubFetch(handler);
      await tt().post(req(options === undefined ? {} : { options }) as never);
      expect(initPostInfo()).toEqual({
        privacy_level: "PUBLIC_TO_EVERYONE", title: "Hello", disable_duet: true, disable_stitch: true, disable_comment: true,
        brand_organic_toggle: false, brand_content_toggle: false,
      });
      expect("is_aigc" in initPostInfo()).toBe(false);
    }
  });

  it("returns TikTok's message and does not upload when init fails", async () => {
    stubFetch((url) => (url.includes("video/init") ? res(400, { error: { code: "invalid_param", message: "bad request" } }) : handler(url)));
    const r = await tt().post(req({ options: { tiktok: { aiGenerated: true } } }) as never);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("bad request");
    expect(calls.some((c) => c.url === "https://up.example.com/u")).toBe(false);
  });
});

// ---------------- YouTube ----------------
describe("YouTube options", () => {
  const yt = () => new YouTubeAdapter("id", "s", "https://x/cb");
  const req = (over: Record<string, unknown> = {}) => ({
    socialAccountId: "sa", content: "My caption text", mediaUrl: "https://cdn.example.com/v.mp4", mediaUrls: [], coverImageUrl: null,
    accessToken: "tok", ...over,
  });
  const handler = (url: string) => {
    if (url.includes("uploadType=resumable")) return res(200, {}, { location: "https://up.example.com/session" });
    if (url === "https://up.example.com/session") return res(200, { id: "vid1" });
    return res(404, {});
  };
  const initBody = () => jsonBody(calls.find((c) => c.url.includes("uploadType=resumable"))!);

  it("without options the init body is exactly the old one", async () => {
    stubFetch(handler);
    const r = await yt().post(req() as never);
    expect(r).toEqual({ success: true, platformPostId: "vid1", errorMessage: null });
    expect(initBody()).toEqual({
      snippet: { title: "My caption text", description: "My caption text", categoryId: "22" },
      status: { privacyStatus: "public" },
    });
    const b = initBody();
    expect("tags" in b.snippet).toBe(false);
    expect("selfDeclaredMadeForKids" in b.status).toBe(false);
    expect("containsSyntheticMedia" in b.status).toBe(false);
  });

  it("applies title, privacy, madeForKids, tags and the synthetic-media disclosure", async () => {
    stubFetch(handler);
    await yt().post(
      req({ options: { youtube: { title: "Custom title", privacy: "unlisted", madeForKids: false, tags: ["a", "b"], aiGenerated: true } } }) as never,
    );
    expect(initBody()).toEqual({
      snippet: { title: "Custom title", description: "My caption text", categoryId: "22", tags: ["a", "b"] },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    });
  });

  it("sends selfDeclaredMadeForKids: true when set, and never sends containsSyntheticMedia for aiGenerated: false", async () => {
    stubFetch(handler);
    await yt().post(req({ options: { youtube: { madeForKids: true, aiGenerated: false, privacy: "private" } } }) as never);
    expect(initBody().status).toEqual({ privacyStatus: "private", selfDeclaredMadeForKids: true });
  });

  it("returns YouTube's message and does not upload when init fails", async () => {
    stubFetch((url) => (url.includes("uploadType=resumable") ? res(403, { error: { message: "quota exceeded" } }) : handler(url)));
    const r = await yt().post(req({ options: { youtube: { privacy: "private" } } }) as never);
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "quota exceeded" });
    expect(fetchMediaForStreaming).not.toHaveBeenCalled();
  });

  it("verifyPublished works for a private video (owner token sees it by id)", async () => {
    stubFetch(() => res(200, { items: [{ id: "vid1", status: { uploadStatus: "processed", privacyStatus: "private" } }] }));
    const v = await yt().verifyPublished("vid1", "tok");
    expect(v).toEqual({ verifiedLive: true, platformPostUrl: "https://www.youtube.com/watch?v=vid1", errorMessage: null });
  });
});

// ---------------- LinkedIn ----------------
describe("LinkedIn PDF document", () => {
  const li = () => new LinkedInAdapter("id", "s", "https://x/cb");
  const req = (over: Record<string, unknown> = {}) => ({
    socialAccountId: "sa", content: "Read this", mediaUrl: null, mediaUrls: [], coverImageUrl: null, accessToken: "tok", ...over,
  });
  const handler = (url: string) => {
    if (url.includes("/v2/userinfo")) return res(200, { sub: "abc" });
    if (url.includes("/rest/documents?action=initializeUpload"))
      return res(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D1" } });
    if (url === "https://www.linkedin.com/dms-uploads/x") return res(201, {});
    if (url.endsWith("/rest/posts")) return res(201, {}, { "x-restli-id": "urn:li:share:9" });
    return res(404, {});
  };
  const postBody = () => jsonBody(calls.find((c) => c.url.endsWith("/rest/posts"))!);

  it("initializes, uploads the PDF, then posts with content.media {id, title}", async () => {
    stubFetch(handler);
    const r = await li().post(req({ options: { linkedin: { documentUrl: "https://cdn.example.com/a.pdf", documentTitle: "My deck" } } }) as never);
    expect(r).toEqual({ success: true, platformPostId: "urn:li:share:9", errorMessage: null });
    const urls = calls.map((c) => c.url);
    expect(urls.indexOf("https://api.linkedin.com/rest/documents?action=initializeUpload")).toBeLessThan(urls.indexOf("https://www.linkedin.com/dms-uploads/x"));
    expect(urls.indexOf("https://www.linkedin.com/dms-uploads/x")).toBeLessThan(urls.indexOf("https://api.linkedin.com/rest/posts"));
    const init = calls.find((c) => c.url.includes("/rest/documents"))!;
    expect(JSON.parse(init.init!.body as string)).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc" } });
    expect(init.init!.headers!["LinkedIn-Version"]).toBe("202607");
    const put = calls.find((c) => c.url === "https://www.linkedin.com/dms-uploads/x")!;
    expect(put.init!.method).toBe("PUT");
    expect(fetchMediaForStreaming).toHaveBeenCalledWith("https://cdn.example.com/a.pdf");
    expect(postBody().content).toEqual({ media: { id: "urn:li:document:D1", title: "My deck" } });
  });

  it("without options: no document call, and the post body is the old text-only one", async () => {
    stubFetch(handler);
    await li().post(req() as never);
    expect(calls.some((c) => c.url.includes("/rest/documents"))).toBe(false);
    expect(postBody()).toEqual({
      author: "urn:li:person:abc", commentary: "Read this", visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    });
  });

  it("stops with LinkedIn's message if initializeUpload is refused (no post created)", async () => {
    stubFetch((url) => (url.includes("/rest/documents") ? res(403, { message: "not allowed" }) : handler(url)));
    const r = await li().post(req({ options: { linkedin: { documentUrl: "https://cdn.example.com/a.pdf" } } }) as never);
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "not allowed" });
    expect(calls.some((c) => c.url.endsWith("/rest/posts"))).toBe(false);
  });

  it("stops if the PDF upload fails (no post created)", async () => {
    stubFetch((url) => (url === "https://www.linkedin.com/dms-uploads/x" ? res(500, {}) : handler(url)));
    const r = await li().post(req({ options: { linkedin: { documentUrl: "https://cdn.example.com/a.pdf" } } }) as never);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("HTTP 500");
    expect(calls.some((c) => c.url.endsWith("/rest/posts"))).toBe(false);
  });

  it("stops if the PDF cannot be fetched (no upload, no post)", async () => {
    (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    stubFetch(handler);
    const r = await li().post(req({ options: { linkedin: { documentUrl: "https://cdn.example.com/a.pdf" } } }) as never);
    expect(r.success).toBe(false);
    expect(calls.some((c) => c.url === "https://www.linkedin.com/dms-uploads/x")).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/rest/posts"))).toBe(false);
  });
});
