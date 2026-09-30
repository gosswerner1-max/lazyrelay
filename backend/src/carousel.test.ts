import { describe, it, expect } from "vitest";
import { normalizeCarousel, MULTI_MEDIA_RULES } from "./carousel.js";

const main = "https://cdn.example.com/a.jpg";
const more = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn.example.com/${i}.jpg`);

describe("normalizeCarousel", () => {
  it("is optional: no extra images means a normal post, on any platform", () => {
    expect(normalizeCarousel(main, undefined, "pinterest")).toEqual({ ok: true, urls: [] });
    expect(normalizeCarousel(main, [], "tiktok")).toEqual({ ok: true, urls: [] });
  });

  it("each platform allows exactly its own total, main image included", () => {
    for (const [platform, rule] of Object.entries(MULTI_MEDIA_RULES)) {
      expect(normalizeCarousel(main, more(rule.max - 1), platform).ok, `${platform} at max`).toBe(true);
      const over = normalizeCarousel(main, more(rule.max), platform);
      expect(over.ok, `${platform} over max`).toBe(false);
    }
    expect(MULTI_MEDIA_RULES.instagram.max).toBe(10);
    expect(MULTI_MEDIA_RULES.bluesky.max).toBe(4);
    expect(MULTI_MEDIA_RULES.x.max).toBe(4);
  });

  it("videos are allowed among the slides only where the platform allows it", () => {
    const video = "https://cdn.example.com/v.mp4";
    expect(normalizeCarousel(main, [video], "instagram").ok).toBe(true);
    expect(normalizeCarousel(video, more(1), "threads").ok).toBe(true);
    for (const p of ["facebook", "tumblr", "linkedin", "bluesky", "mastodon", "x"]) {
      expect(normalizeCarousel(main, [video], p).ok, p).toBe(false);
      expect(normalizeCarousel(video, more(1), p).ok, p).toBe(false);
    }
  });

  it("refuses platforms with no multi-image support, a missing main image and bad input", () => {
    expect(normalizeCarousel(main, more(2), "tiktok").ok).toBe(false);
    expect(normalizeCarousel(main, more(2), "pinterest").ok).toBe(false);
    expect(normalizeCarousel(undefined, more(2), "instagram").ok).toBe(false);
    expect(normalizeCarousel(main, "nope", "instagram").ok).toBe(false);
    expect(normalizeCarousel(main, [""], "instagram").ok).toBe(false);
  });
});
