// The platform rules an agent reads must never promise MORE than LazyRelay itself enforces:
// if the rules say an image may be 20 MB but LazyRelay refuses anything over 8 MB, an agent
// that trusts the lookup schedules a post that is then rejected. This checks every size the
// rules state against the real validator (validateMediaForPlatform), so the two cannot drift.

import { describe, it, expect } from "vitest";
import { getPlatformRules } from "./platformRules.js";
import { validateMediaForPlatform, type Platform } from "./mediaLimits.js";

const MB = 1024 * 1024;
const MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

describe("platform rules never promise more than LazyRelay enforces", () => {
  for (const rules of getPlatformRules()) {
    const p = rules.platform as Platform;

    it(`${rules.platform}: image size and formats`, () => {
      if (!rules.media.image.supported || rules.media.image.maxSizeMb === null) return;
      for (const fmt of rules.media.image.formats) {
        const mime = MIME[fmt];
        expect(mime, `unknown format ${fmt}`).toBeTruthy();
        const atLimit = validateMediaForPlatform(p, { mimeType: mime, sizeBytes: rules.media.image.maxSizeMb * MB, width: 1080, height: 1080 });
        expect(atLimit.valid, `${rules.platform} says ${fmt} images up to ${rules.media.image.maxSizeMb} MB but LazyRelay refuses one at that size: ${atLimit.reason}`).toBe(true);
      }
    });

    it(`${rules.platform}: video size and formats`, () => {
      if (!rules.media.video.supported || rules.media.video.maxSizeMb === null) return;
      for (const fmt of rules.media.video.formats) {
        const mime = MIME[fmt];
        expect(mime, `unknown format ${fmt}`).toBeTruthy();
        const atLimit = validateMediaForPlatform(p, { mimeType: mime, sizeBytes: rules.media.video.maxSizeMb * MB, width: null, height: null });
        expect(atLimit.valid, `${rules.platform} says ${fmt} video up to ${rules.media.video.maxSizeMb} MB but LazyRelay refuses one at that size: ${atLimit.reason}`).toBe(true);
      }
    });
  }
});
