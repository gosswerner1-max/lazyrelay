// Instagram and Facebook media checks (fixed 2026-09-30): real accounts are stored as "instagram" and
// "facebook", which used to fall through to a generic 20 MB floor and refused every Reel over 20 MB.

import { describe, it, expect } from "vitest";
import { validateMediaForPlatform } from "./mediaLimits.js";

const MB = 1024 * 1024;
const video = (sizeMb: number, mimeType = "video/mp4") => ({ mimeType, sizeBytes: sizeMb * MB, width: null, height: null });
const image = (sizeMb: number, w = 1080, h = 1080, mimeType = "image/jpeg") => ({ mimeType, sizeBytes: sizeMb * MB, width: w, height: h });

describe("Instagram", () => {
  it("takes a normal Reel: a 50 MB and a 300 MB mp4 (it used to refuse anything over 20 MB)", () => {
    expect(validateMediaForPlatform("instagram", video(50)).valid).toBe(true);
    expect(validateMediaForPlatform("instagram", video(300)).valid).toBe(true);
    expect(validateMediaForPlatform("instagram", video(301)).valid).toBe(false);
  });
  it("takes mov, refuses formats Instagram does not take", () => {
    expect(validateMediaForPlatform("instagram", video(10, "video/quicktime")).valid).toBe(true);
    expect(validateMediaForPlatform("instagram", video(10, "video/webm")).valid).toBe(false);
  });
  it("refuses an image over 8 MB with Instagram's own limit, instead of failing later at Instagram", () => {
    const r = validateMediaForPlatform("instagram", image(9));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/8MB/);
    expect(validateMediaForPlatform("instagram", image(8)).valid).toBe(true);
  });
  it("never refuses a 9:16 Story image on shape (this check cannot tell a Story from a feed post)", () => {
    expect(validateMediaForPlatform("instagram", image(1, 1080, 1920)).valid).toBe(true);
  });
});

describe("Facebook", () => {
  it("takes a large video (300 MB) and keeps its previous formats", () => {
    expect(validateMediaForPlatform("facebook", video(50)).valid).toBe(true);
    expect(validateMediaForPlatform("facebook", video(300)).valid).toBe(true);
    expect(validateMediaForPlatform("facebook", video(301)).valid).toBe(false);
    expect(validateMediaForPlatform("facebook", video(10, "video/webm")).valid).toBe(true);
  });
  it("images are unchanged (generic floor)", () => {
    expect(validateMediaForPlatform("facebook", image(15, 4000, 500, "image/png")).valid).toBe(true);
    expect(validateMediaForPlatform("facebook", image(21)).valid).toBe(false);
  });
});
