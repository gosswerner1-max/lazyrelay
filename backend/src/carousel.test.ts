import { describe, it, expect } from "vitest";
import { normalizeCarousel } from "./carousel.js";

const main = "https://cdn.example.com/a.jpg";
const more = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn.example.com/${i}.jpg`);

describe("normalizeCarousel", () => {
  it("is optional: no extra images means a normal post", () => {
    expect(normalizeCarousel(main, undefined, "tiktok")).toEqual({ ok: true, urls: [] });
    expect(normalizeCarousel(main, [], "tiktok")).toEqual({ ok: true, urls: [] });
  });
  it("accepts 1 to 9 extra images on Instagram", () => {
    expect(normalizeCarousel(main, more(1), "instagram")).toEqual({ ok: true, urls: more(1) });
    expect(normalizeCarousel(main, more(9), "instagram").ok).toBe(true);
  });
  it("refuses more than 10 images in total", () => {
    const r = normalizeCarousel(main, more(10), "instagram");
    expect(r.ok).toBe(false);
  });
  it("refuses other platforms, a missing main image, videos and bad input", () => {
    expect(normalizeCarousel(main, more(2), "facebook").ok).toBe(false);
    expect(normalizeCarousel(undefined, more(2), "instagram").ok).toBe(false);
    expect(normalizeCarousel("https://cdn.example.com/v.mp4", more(2), "instagram").ok).toBe(false);
    expect(normalizeCarousel(main, ["https://cdn.example.com/v.mov"], "instagram").ok).toBe(false);
    expect(normalizeCarousel(main, "nope", "instagram").ok).toBe(false);
    expect(normalizeCarousel(main, [""], "instagram").ok).toBe(false);
  });
});
