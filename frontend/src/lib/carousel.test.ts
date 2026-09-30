import { describe, it, expect } from "vitest";
import { canShowCarousel, carouselFields, carouselPlan } from "./carousel";

describe("carouselPlan", () => {
  it("is not offered when no selected platform takes several images", () => {
    expect(carouselPlan(["tiktok", "pinterest"]).available).toBe(false);
    expect(carouselPlan([]).available).toBe(false);
  });
  it("caps the extras at the smallest limit among the selected platforms", () => {
    expect(carouselPlan(["instagram"]).maxExtra).toBe(9);
    expect(carouselPlan(["instagram", "bluesky"]).maxExtra).toBe(3);
    expect(carouselPlan(["instagram", "x", "linkedin"]).maxExtra).toBe(3);
  });
  it("allows videos only when every selected multi-image platform does", () => {
    expect(carouselPlan(["instagram", "threads"]).videosAllowed).toBe(true);
    expect(carouselPlan(["instagram", "facebook"]).videosAllowed).toBe(false);
  });
  it("says which platforms will post the main image only", () => {
    const p = carouselPlan(["instagram", "tiktok"]);
    expect(p.mainOnly).toEqual(["tiktok"]);
    expect(p.note).toMatch(/TikTok will post the main image only/);
  });
});

describe("canShowCarousel", () => {
  it("needs a platform that takes several images and a main file", () => {
    expect(canShowCarousel(["instagram"], "https://x/a.jpg")).toBe(true);
    expect(canShowCarousel(["facebook", "bluesky"], "https://x/a.jpg")).toBe(true);
    expect(canShowCarousel(["tiktok"], "https://x/a.jpg")).toBe(false);
    expect(canShowCarousel(["instagram"], null)).toBe(false);
  });
  it("a video main file is fine for Instagram and Threads, not when an images-only platform is selected", () => {
    expect(canShowCarousel(["instagram", "threads"], "https://x/a.mp4")).toBe(true);
    expect(canShowCarousel(["instagram", "facebook"], "https://x/a.mp4")).toBe(false);
  });
});

describe("carouselFields", () => {
  it("only platforms that take several images carry the extras", () => {
    expect(carouselFields("instagram", ["https://x/b.jpg"])).toEqual({ mediaUrls: ["https://x/b.jpg"] });
    expect(carouselFields("bluesky", ["https://x/b.jpg"])).toEqual({ mediaUrls: ["https://x/b.jpg"] });
    expect(carouselFields("tiktok", ["https://x/b.jpg"])).toEqual({});
    expect(carouselFields("instagram", [])).toEqual({});
  });
});
