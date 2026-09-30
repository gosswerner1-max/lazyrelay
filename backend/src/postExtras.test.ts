// The shared checker for tags, extra images and self-replies, used by new posts,
// promoted drafts and duplicates. supabase is the in-memory fake; DNS is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("./urlSafety.js", () => ({
  isSafeMediaUrl: async (u: string) => (u.includes("internal") ? { safe: false, reason: "must not point at a private, internal, or reserved address" } : { safe: true, addresses: ["8.8.8.8"] }),
}));

const { resolvePostExtras, normalizeDraftExtras, extrasToColumns } = await import("./postExtras.js");

const main = "https://cdn.example.com/a.jpg";
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("resolvePostExtras (a post on a known platform)", () => {
  it("returns clean values for a good request", async () => {
    const r = await resolvePostExtras(
      { tags: [" #Launch ", "launch"], mediaUrls: ["https://cdn.example.com/b.jpg"], selfReplyText: " Thanks! ", selfReplyAtLikes: "20" },
      "instagram",
      main,
    );
    expect(r).toEqual({ ok: true, extras: { tags: ["launch"], mediaUrls: ["https://cdn.example.com/b.jpg"], selfReplyText: "Thanks!", selfReplyAtLikes: 20 } });
  });

  it("gives nothing when nothing is asked for", async () => {
    const r = await resolvePostExtras({}, "tiktok", null);
    expect(r).toEqual({ ok: true, extras: { tags: [], mediaUrls: [], selfReplyText: null, selfReplyAtLikes: null } });
  });

  it("applies each platform's own rules", async () => {
    const tiktok = await resolvePostExtras({ mediaUrls: ["https://cdn.example.com/b.jpg"] }, "tiktok", main);
    expect(tiktok.ok).toBe(false);
    const bluesky = await resolvePostExtras({ mediaUrls: Array.from({ length: 4 }, (_, i) => `https://cdn.example.com/${i}.jpg`) }, "bluesky", main);
    expect(bluesky.ok).toBe(false); // 5 in total, Bluesky takes 4
    const selfReply = await resolvePostExtras({ selfReplyText: "hi", selfReplyAtLikes: 5 }, "tiktok", main);
    expect(selfReply.ok).toBe(false);
  });

  it("refuses an extra image on an internal address", async () => {
    const r = await resolvePostExtras({ mediaUrls: ["https://internal.example.com/x.jpg"] }, "instagram", main);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.body.error).toMatch(/mediaUrls must not point/);
  });

  it("checks each extra file against the platform's file rules when we hold its details", async () => {
    tables.media_uploads = [{ url: "https://cdn.example.com/huge.png", mime_type: "image/png", size_bytes: 900_000_000, width: 1000, height: 1000 }];
    const r = await resolvePostExtras({ mediaUrls: ["https://cdn.example.com/huge.png"] }, "instagram", main);
    expect(r.ok).toBe(false);
  });
});

describe("normalizeDraftExtras (a draft, no platform yet)", () => {
  it("keeps the values so they survive until the draft is scheduled", async () => {
    const r = await normalizeDraftExtras({ tags: ["a", "b"], mediaUrls: ["https://cdn.example.com/b.jpg"], selfReplyText: "Thanks", selfReplyAtLikes: 10 });
    expect(r).toEqual({ ok: true, extras: { tags: ["a", "b"], mediaUrls: ["https://cdn.example.com/b.jpg"], selfReplyText: "Thanks", selfReplyAtLikes: 10 } });
  });
  it("rejects bad shapes and unsafe addresses", async () => {
    expect((await normalizeDraftExtras({ tags: "x" })).ok).toBe(false);
    expect((await normalizeDraftExtras({ mediaUrls: "x" })).ok).toBe(false);
    expect((await normalizeDraftExtras({ mediaUrls: Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.jpg`) })).ok).toBe(false);
    expect((await normalizeDraftExtras({ mediaUrls: ["https://internal.example.com/x.jpg"] })).ok).toBe(false);
    expect((await normalizeDraftExtras({ selfReplyText: "hi" })).ok).toBe(false);
    expect((await normalizeDraftExtras({ selfReplyText: "hi", selfReplyAtLikes: 0 })).ok).toBe(false);
  });
});

describe("extrasToColumns", () => {
  it("maps to the database columns", () => {
    expect(extrasToColumns({ tags: ["a"], mediaUrls: ["u"], selfReplyText: "t", selfReplyAtLikes: 3 })).toEqual({
      tags: ["a"],
      media_urls: ["u"],
      self_reply_text: "t",
      self_reply_at_likes: 3,
    });
  });
});
