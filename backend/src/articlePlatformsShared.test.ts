// Shared rules for the article and forum platforms (master list #27): the per-post options each one reads
// and the media rules that refuse a video the platform cannot take.

import { describe, it, expect } from "vitest";
import { normalizePostOptions, normalizeStoredOptions } from "./postOptions.js";
import { validateMediaForPlatform } from "./mediaLimits.js";

const none = { mediaUrl: null, mediaUrls: [] };
const MB = 1024 * 1024;

describe("WordPress options", () => {
  it("cleans a title, status, categories and tags", () => {
    const r = normalizePostOptions({ wordpress: { title: "  Launch day  ", status: "draft", categories: ["News", "News", " Updates "], tags: ["#seo", "  "] } }, "wordpress", none);
    expect(r).toEqual({ ok: true, options: { wordpress: { title: "Launch day", status: "draft", categories: ["News", "Updates"], tags: ["seo"] } } });
  });
  it("refuses a bad status and another platform's key", () => {
    expect(normalizePostOptions({ wordpress: { status: "private" } }, "wordpress", none).ok).toBe(false);
    expect(normalizePostOptions({ devto: { tags: ["a"] } }, "wordpress", none)).toEqual({ ok: false, error: "options.devto is not used by this platform (it takes options.wordpress)" });
  });
});

describe("dev.to options", () => {
  it("allows at most 4 tags and keeps published:false (a draft)", () => {
    expect(normalizePostOptions({ devto: { tags: ["a", "b", "c", "d", "e"] } }, "devto", none).ok).toBe(false);
    expect(normalizePostOptions({ devto: { published: false, tags: ["js"] } }, "devto", none)).toEqual({ ok: true, options: { devto: { published: false, tags: ["js"] } } });
  });
  it("only takes an https canonical address", () => {
    expect(normalizePostOptions({ devto: { canonicalUrl: "http://example.com/a" } }, "devto", none).ok).toBe(false);
    expect(normalizePostOptions({ devto: { canonicalUrl: "https://example.com/a" } }, "devto", none).ok).toBe(true);
  });
});

describe("Hashnode options", () => {
  it("allows at most 5 tags and takes a draft flag and subtitle", () => {
    expect(normalizePostOptions({ hashnode: { tags: ["1", "2", "3", "4", "5", "6"] } }, "hashnode", none).ok).toBe(false);
    expect(normalizePostOptions({ hashnode: { draft: true, subtitle: "A subtitle" } }, "hashnode", none)).toEqual({ ok: true, options: { hashnode: { draft: true, subtitle: "A subtitle" } } });
  });
});

describe("Lemmy options", () => {
  it("accepts name or name@instance (a leading ! is dropped) and refuses anything else", () => {
    expect(normalizePostOptions({ lemmy: { community: "!programming@programming.dev" } }, "lemmy", none)).toEqual({ ok: true, options: { lemmy: { community: "programming@programming.dev" } } });
    expect(normalizePostOptions({ lemmy: { community: "https://evil.example/c/x" } }, "lemmy", none).ok).toBe(false);
    expect(normalizePostOptions({ lemmy: { community: "a b" } }, "lemmy", none).ok).toBe(false);
  });
  it("limits the title to 200 characters and needs an https link", () => {
    expect(normalizePostOptions({ lemmy: { title: "x".repeat(201) } }, "lemmy", none).ok).toBe(false);
    expect(normalizePostOptions({ lemmy: { url: "ftp://example.com" } }, "lemmy", none).ok).toBe(false);
  });
});

describe("drafts and recurring schedules keep the new groups", () => {
  it("normalizeStoredOptions accepts each new group", () => {
    const r = normalizeStoredOptions({ wordpress: { status: "draft" }, devto: { tags: ["a"] }, hashnode: { draft: true }, lemmy: { nsfw: true } });
    expect(r).toEqual({ ok: true, options: { wordpress: { status: "draft" }, devto: { tags: ["a"] }, hashnode: { draft: true }, lemmy: { nsfw: true } } });
  });
});

describe("media rules", () => {
  const video = { mimeType: "video/mp4", sizeBytes: 5 * MB, width: null, height: null };
  const image = { mimeType: "image/png", sizeBytes: 2 * MB, width: 800, height: 600 };
  it("dev.to, Hashnode and Lemmy refuse video up front with a plain reason", () => {
    for (const p of ["devto", "hashnode", "lemmy"] as const) {
      const r = validateMediaForPlatform(p, video);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/does not accept video/);
    }
  });
  it("WordPress takes a small video, and every one of them takes a normal image", () => {
    expect(validateMediaForPlatform("wordpress", video).valid).toBe(true);
    for (const p of ["wordpress", "devto", "hashnode", "lemmy"] as const) expect(validateMediaForPlatform(p, image).valid).toBe(true);
  });
  it("says these platforms have only generic rules", () => {
    expect(validateMediaForPlatform("devto", image).unchecked.join(" ")).toMatch(/generic/);
  });
});
