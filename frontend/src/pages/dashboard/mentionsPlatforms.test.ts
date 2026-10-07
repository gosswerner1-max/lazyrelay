import { describe, it, expect } from "vitest";
import { MENTIONS_LIVE_PLATFORMS, MENTIONS_COMING_SOON_PLATFORMS } from "./mentionsPlatforms";

describe("which platforms the Mentions tab lists", () => {
  it("shows comments for exactly these nine platforms", () => {
    expect([...MENTIONS_LIVE_PLATFORMS].sort()).toEqual(
      ["bluesky", "devto", "discord", "hashnode", "lemmy", "mastodon", "telegram", "wordpress", "youtube"],
    );
  });

  it("keeps only the three Meta platforms as Coming soon", () => {
    expect([...MENTIONS_COMING_SOON_PLATFORMS].sort()).toEqual(["facebook", "instagram", "threads"]);
  });

  it("never lists a platform as both live and Coming soon", () => {
    for (const p of MENTIONS_COMING_SOON_PLATFORMS) expect(MENTIONS_LIVE_PLATFORMS).not.toContain(p);
  });

  it("has no row at all for platforms without a comment API", () => {
    for (const p of ["tiktok", "pinterest", "slack", "tumblr"]) {
      expect(MENTIONS_LIVE_PLATFORMS).not.toContain(p);
      expect(MENTIONS_COMING_SOON_PLATFORMS).not.toContain(p);
    }
  });
});
