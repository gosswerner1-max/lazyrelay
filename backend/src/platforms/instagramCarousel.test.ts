// Instagram carousel posting: one container per image, one CAROUSEL container
// that lists them, then publish. fetch is stubbed; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InstagramAdapter } from "./instagram.js";

let calls: Array<{ url: string; body: URLSearchParams | null }>;
let childCounter: number;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const adapter = () => new InstagramAdapter("client", "secret", "https://api.example.org/cb");
const request = (over: Record<string, unknown> = {}) => ({
  socialAccountId: "sa1",
  content: "Caption",
  mediaUrl: "https://cdn.example.com/1.jpg",
  mediaUrls: ["https://cdn.example.com/2.jpg", "https://cdn.example.com/3.jpg"],
  coverImageUrl: null,
  accessToken: "tok",
  ...over,
});

beforeEach(() => {
  calls = [];
  childCounter = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? new URLSearchParams(init.body) : null });
      if (url.includes("/me?")) return json(200, { instagram_business_account: { id: "ig1" } });
      if (url.includes("fields=status_code")) return json(200, { status_code: "FINISHED" });
      if (url.endsWith("/ig1/media")) return json(200, { id: `c${++childCounter}` });
      if (url.endsWith("/ig1/media_publish")) return json(200, { id: "post9" });
      return json(404, {});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("carousel", () => {
  it("creates a child per image, then a CAROUSEL container listing them in order, then publishes it", async () => {
    const r = await adapter().post(request() as never);
    expect(r).toEqual({ success: true, platformPostId: "post9", errorMessage: null });
    const creates = calls.filter((c) => c.url.endsWith("/ig1/media"));
    expect(creates).toHaveLength(4); // 3 images + the carousel
    expect(creates.slice(0, 3).map((c) => c.body!.get("image_url"))).toEqual([
      "https://cdn.example.com/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg",
    ]);
    expect(creates.slice(0, 3).every((c) => c.body!.get("is_carousel_item") === "true")).toBe(true);
    const parent = creates[3].body!;
    expect(parent.get("media_type")).toBe("CAROUSEL");
    expect(parent.get("children")).toBe("c1,c2,c3");
    expect(parent.get("caption")).toBe("Caption");
    expect(calls.filter((c) => c.url.endsWith("/ig1/media_publish"))[0].body!.get("creation_id")).toBe("c4");
  });

  it("stops and reports the platform's reason if one image is refused, without publishing", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? new URLSearchParams(init.body) : null });
      if (url.includes("/me?")) return json(200, { instagram_business_account: { id: "ig1" } });
      if (url.endsWith("/ig1/media")) return json(400, { error: { message: "Only photo or video can be accepted as media type." } });
      return json(404, {});
    });
    const r = await adapter().post(request() as never);
    expect(r).toMatchObject({ success: false, errorMessage: "Only photo or video can be accepted as media type." });
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
  });

  it("a normal single-image post is unchanged (no carousel calls)", async () => {
    const r = await adapter().post(request({ mediaUrls: [] }) as never);
    expect(r.success).toBe(true);
    const creates = calls.filter((c) => c.url.endsWith("/ig1/media"));
    expect(creates).toHaveLength(1);
    expect(creates[0].body!.get("image_url")).toBe("https://cdn.example.com/1.jpg");
    expect(creates[0].body!.get("is_carousel_item")).toBeNull();
  });
});
