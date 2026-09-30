import { describe, it, expect } from "vitest";
import { canShowCarousel, carouselFields } from "./carousel";

describe("canShowCarousel", () => {
  it("needs an Instagram account and an image as the main media", () => {
    expect(canShowCarousel(["instagram", "facebook"], "https://x/a.jpg")).toBe(true);
    expect(canShowCarousel(["facebook"], "https://x/a.jpg")).toBe(false);
    expect(canShowCarousel(["instagram"], null)).toBe(false);
    expect(canShowCarousel(["instagram"], "https://x/a.mp4")).toBe(false);
  });
});

describe("carouselFields", () => {
  it("only Instagram posts carry the extra images", () => {
    expect(carouselFields("instagram", ["https://x/b.jpg"])).toEqual({ mediaUrls: ["https://x/b.jpg"] });
    expect(carouselFields("facebook", ["https://x/b.jpg"])).toEqual({});
    expect(carouselFields("instagram", [])).toEqual({});
  });
});
