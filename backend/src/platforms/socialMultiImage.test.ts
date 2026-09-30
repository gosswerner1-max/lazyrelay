// Multi-image posting for Bluesky, Mastodon and X. Media fetching
// (fetchMediaForStreaming) and global fetch are stubbed; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));
vi.mock("./streamUpload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streamUpload.js")>();
  return { ...actual, fetchMediaForStreaming: vi.fn() };
});

import { fetchMediaForStreaming } from "./streamUpload.js";
import { BlueskyAdapter } from "./bluesky.js";
import { MastodonAdapter } from "./mastodon.js";
import { XAdapter } from "./x.js";

const U = (n: number) => `https://cdn.example.com/${n}.jpg`;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

function mockMedia(refuse: string[] = []) {
  (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
    if (refuse.includes(url)) return null;
    const bytes = new TextEncoder().encode(url);
    return {
      body: new Blob([bytes]).stream(),
      sizeBytes: bytes.byteLength,
      contentType: "image/jpeg",
    };
  });
}

const req = (over: Record<string, unknown> = {}) =>
  ({
    socialAccountId: "sa1",
    content: "Hello",
    mediaUrl: U(1),
    mediaUrls: [U(2), U(3)],
    mediaAltText: "first alt",
    accessToken: "tok",
    ...over,
  }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Bluesky multi-image", () => {
  let blobCount: number;
  let uploadedBodies: string[];
  let records: Array<{ record: { embed?: { $type: string; images: Array<{ alt: string; image: { n: number } }> } } }>;

  beforeEach(() => {
    blobCount = 0;
    uploadedBodies = [];
    records = [];
    mockMedia();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: unknown }) => {
        if (url.endsWith("com.atproto.server.getSession")) return json(200, { did: "did:plc:abc" });
        if (url.endsWith("com.atproto.repo.uploadBlob")) {
          uploadedBodies.push(await new Response(init?.body as ReadableStream).text());
          return json(200, { blob: { $type: "blob", ref: { $link: `l${++blobCount}` }, mimeType: "image/jpeg", size: 1, n: blobCount } });
        }
        if (url.endsWith("com.atproto.repo.createRecord")) {
          records.push(JSON.parse(init!.body as string));
          return json(200, { uri: "at://did:plc:abc/app.bsky.feed.post/rk" });
        }
        return json(404, {});
      }),
    );
  });

  it("uploads each image in order and posts one record with all of them", async () => {
    const r = await new BlueskyAdapter("https://x").post(req());
    expect(r.success).toBe(true);
    expect(uploadedBodies).toEqual([U(1), U(2), U(3)]);
    expect(records).toHaveLength(1);
    const embed = records[0].record.embed!;
    expect(embed.$type).toBe("app.bsky.embed.images");
    expect(embed.images.map((i) => i.image.n)).toEqual([1, 2, 3]);
    expect(embed.images.map((i) => i.alt)).toEqual(["first alt", "", ""]);
  });

  it("a refused upload fails clearly and creates no post", async () => {
    mockMedia([U(3)]);
    const r = await new BlueskyAdapter("https://x").post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain(U(3));
    expect(records).toHaveLength(0);
  });

  it("single image path is unchanged", async () => {
    await new BlueskyAdapter("https://x").post(req({ mediaUrls: undefined }));
    expect(uploadedBodies).toEqual([U(1)]);
    expect(records[0].record.embed!.images).toHaveLength(1);
    expect(records[0].record.embed!.images[0].alt).toBe("first alt");
  });
});

describe("Mastodon multi-image", () => {
  let uploads: Array<{ text: string }>;
  let statuses: Array<{ media_ids?: string[] }>;
  let n: number;

  beforeEach(() => {
    uploads = [];
    statuses = [];
    n = 0;
    mockMedia();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: unknown }) => {
        if (url.endsWith("/api/v2/media")) {
          uploads.push({ text: await new Response(init?.body as ReadableStream).text() });
          return json(200, { id: `m${++n}` });
        }
        if (url.endsWith("/api/v1/statuses")) {
          statuses.push(JSON.parse(init!.body as string));
          return json(200, { id: "s1" });
        }
        return json(404, {});
      }),
    );
  });

  it("uploads each image in order and sends all media_ids in order", async () => {
    const r = await new MastodonAdapter("https://cb").post(req());
    expect(r.success).toBe(true);
    expect(uploads.map((u) => u.text.includes(U(1)) ? 1 : u.text.includes(U(2)) ? 2 : 3)).toEqual([1, 2, 3]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].media_ids).toEqual(["m1", "m2", "m3"]);
  });

  it("alt text only on the first upload", async () => {
    await new MastodonAdapter("https://cb").post(req());
    expect(uploads[0].text).toContain('name="description"');
    expect(uploads[0].text).toContain("first alt");
    expect(uploads[1].text).not.toContain('name="description"');
    expect(uploads[2].text).not.toContain('name="description"');
  });

  it("a refused upload fails clearly and creates no status", async () => {
    mockMedia([U(2)]);
    const r = await new MastodonAdapter("https://cb").post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain(U(2));
    expect(statuses).toHaveLength(0);
  });

  it("single image path is unchanged", async () => {
    await new MastodonAdapter("https://cb").post(req({ mediaUrls: undefined }));
    expect(statuses[0].media_ids).toEqual(["m1"]);
  });
});

describe("X multi-image", () => {
  let inits: string[];
  let tweets: Array<{ text: string; media?: { media_ids: string[] } }>;
  let n: number;

  beforeEach(() => {
    inits = [];
    tweets = [];
    n = 0;
    mockMedia();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: unknown }) => {
        if (url.includes("media/upload.json")) {
          if (url.includes("command=INIT")) return json(200, { media_id_string: `x${++n}` });
          if (url.includes("command=FINALIZE")) return json(200, {});
          return json(200, {}); // APPEND
        }
        if (url.endsWith("/2/tweets")) {
          tweets.push(JSON.parse(init!.body as string));
          return json(201, { data: { id: "t1" } });
        }
        return json(404, {});
      }),
    );
    // record INIT order via the media mock's call order
    (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      inits.push(url);
      const bytes = new TextEncoder().encode(url);
      return { body: new Blob([bytes]).stream(), sizeBytes: bytes.byteLength, contentType: "image/jpeg" };
    });
  });

  const adapter = () => new XAdapter("id", "secret", "https://cb");

  it("uploads each image in order and tweets once with all media ids in order", async () => {
    const r = await adapter().post(req());
    expect(r.success).toBe(true);
    expect(inits).toEqual([U(1), U(2), U(3)]);
    expect(tweets).toHaveLength(1);
    expect(tweets[0].media).toEqual({ media_ids: ["x1", "x2", "x3"] });
  });

  it("a refused upload fails clearly and creates no tweet", async () => {
    (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url === U(2)) return null;
      const bytes = new TextEncoder().encode(url);
      return { body: new Blob([bytes]).stream(), sizeBytes: bytes.byteLength, contentType: "image/jpeg" };
    });
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain(U(2));
    expect(tweets).toHaveLength(0);
  });

  it("single image path is unchanged", async () => {
    await adapter().post(req({ mediaUrls: undefined }));
    expect(tweets[0].media).toEqual({ media_ids: ["x1"] });
  });

  it("text-only post sends no media", async () => {
    await adapter().post(req({ mediaUrl: null, mediaUrls: undefined }));
    expect(tweets[0].media).toBeUndefined();
  });
});
