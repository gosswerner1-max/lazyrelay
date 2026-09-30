// Tumblr and LinkedIn multi-image posting. fetch and the media fetcher are stubbed; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./streamUpload.js", async (orig) => {
  const actual = await orig<typeof import("./streamUpload.js")>();
  return { ...actual, fetchMediaForStreaming: vi.fn() };
});

import { fetchMediaForStreaming } from "./streamUpload.js";
import { TumblrAdapter } from "./tumblr.js";
import { LinkedInAdapter } from "./linkedin.js";

const fetchMedia = fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers(headers) }) as Response;

let calls: Array<{ url: string; method?: string; body?: unknown }>;
const request = (over: Record<string, unknown> = {}) => ({
  socialAccountId: "sa1",
  platformAccountId: "myblog",
  content: "Caption",
  mediaUrl: "https://cdn.example.com/1.jpg",
  mediaUrls: ["https://cdn.example.com/2.jpg", "https://cdn.example.com/3.jpg"],
  coverImageUrl: null,
  accessToken: "tok",
  ...over,
});

beforeEach(() => {
  calls = [];
  fetchMedia.mockReset();
  fetchMedia.mockResolvedValue({ body: "stream", contentType: "image/jpeg", sizeBytes: 3 });
});
afterEach(() => vi.unstubAllGlobals());

describe("tumblr multi-image", () => {
  const adapter = () => new TumblrAdapter("c", "s", "https://api.example.org/cb");
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        return json(201, { response: { id: 55 } });
      }),
    );
  });

  it("sends the text block then one image block per image, main first", async () => {
    const r = await adapter().post(request() as never);
    expect(r).toEqual({ success: true, platformPostId: "myblog:55", errorMessage: null });
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { content: unknown }).content).toEqual([
      { type: "text", text: "Caption" },
      { type: "image", media: [{ url: "https://cdn.example.com/1.jpg", type: "image/jpeg" }] },
      { type: "image", media: [{ url: "https://cdn.example.com/2.jpg", type: "image/jpeg" }] },
      { type: "image", media: [{ url: "https://cdn.example.com/3.jpg", type: "image/jpeg" }] },
    ]);
  });

  it("reports the platform's refusal and makes no further calls", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => json(400, { errors: [{ detail: "Bad image" }] }));
    const r = await adapter().post(request() as never);
    expect(r).toMatchObject({ success: false, platformPostId: null, errorMessage: "Bad image" });
  });

  it("single-image post is unchanged", async () => {
    await adapter().post(request({ mediaUrls: [] }) as never);
    expect((calls[0].body as { content: unknown }).content).toEqual([
      { type: "text", text: "Caption" },
      { type: "image", media: [{ url: "https://cdn.example.com/1.jpg", type: "image/jpeg" }] },
    ]);
  });
});

describe("linkedin multi-image", () => {
  const adapter = () => new LinkedInAdapter("c", "s", "https://api.example.org/cb");
  let initCount: number;
  let failInitAt: number | null;
  let failPutAt: number | null;
  let putCount: number;
  beforeEach(() => {
    initCount = 0;
    putCount = 0;
    failInitAt = null;
    failPutAt = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: unknown; method?: string }) => {
        const body = typeof init?.body === "string" && !url.startsWith("https://upload.example.com/") ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init?.method, body });
        if (url.includes("/v2/userinfo")) return json(200, { sub: "m1" });
        if (url.includes("/rest/images?action=initializeUpload")) {
          initCount++;
          if (failInitAt === initCount) return json(403, { message: "Not allowed" });
          return json(200, { value: { uploadUrl: `https://upload.example.com/u${initCount}`, image: `urn:li:image:I${initCount}` } });
        }
        if (url.startsWith("https://upload.example.com/")) {
          putCount++;
          return failPutAt === putCount ? json(500, {}) : json(201, {});
        }
        if (url.endsWith("/rest/posts")) return json(201, {}, { "x-restli-id": "urn:li:share:9" });
        return json(404, {});
      }),
    );
  });
  const posts = () => calls.filter((c) => c.url.endsWith("/rest/posts"));

  it("uploads each image in order then creates a single multiImage post", async () => {
    const r = await adapter().post(request() as never);
    expect(r).toEqual({ success: true, platformPostId: "urn:li:share:9", errorMessage: null });
    expect(fetchMedia.mock.calls.map((c) => c[0])).toEqual([
      "https://cdn.example.com/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg",
    ]);
    expect(calls.filter((c) => c.url.startsWith("https://upload.example.com/")).map((c) => c.url)).toEqual([
      "https://upload.example.com/u1",
      "https://upload.example.com/u2",
      "https://upload.example.com/u3",
    ]);
    expect(posts()).toHaveLength(1);
    const body = posts()[0].body as { content: unknown; author: string; commentary: string };
    expect(body.author).toBe("urn:li:person:m1");
    expect(body.commentary).toBe("Caption");
    expect(body.content).toEqual({
      multiImage: { images: [{ id: "urn:li:image:I1" }, { id: "urn:li:image:I2" }, { id: "urn:li:image:I3" }] },
    });
  });

  it("a refused upload init returns the reason and creates no post", async () => {
    failInitAt = 2;
    const r = await adapter().post(request() as never);
    expect(r).toMatchObject({ success: false, platformPostId: null, errorMessage: "Not allowed" });
    expect(posts()).toHaveLength(0);
  });

  it("a failed image upload returns a clear message and creates no post", async () => {
    failPutAt = 3;
    const r = await adapter().post(request() as never);
    expect(r).toMatchObject({ success: false, errorMessage: "LinkedIn image upload failed (HTTP 500)" });
    expect(posts()).toHaveLength(0);
  });

  it("an unfetchable image returns a clear message and creates no post", async () => {
    fetchMedia.mockResolvedValueOnce({ body: "s", contentType: "image/jpeg", sizeBytes: 1 }).mockResolvedValueOnce(null);
    const r = await adapter().post(request() as never);
    expect(r).toMatchObject({ success: false, errorMessage: "Could not fetch image from https://cdn.example.com/2.jpg" });
    expect(posts()).toHaveLength(0);
  });

  it("single-image post is unchanged (media content, one upload)", async () => {
    const r = await adapter().post(request({ mediaUrls: [] }) as never);
    expect(r.success).toBe(true);
    expect(initCount).toBe(1);
    expect((posts()[0].body as { content: unknown }).content).toEqual({ media: { id: "urn:li:image:I1" } });
  });
});
