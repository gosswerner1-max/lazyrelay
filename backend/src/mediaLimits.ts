/** Pre-flight media validation — checks a file against each platform's real,
 *  published posting requirements BEFORE a post is scheduled, so a customer
 *  finds out immediately (at /scheduled-posts creation time) rather than
 *  discovering it only after a scheduled post silently fails hours later.
 *
 *  SCOPE — what this does and does not check (researched 2026-07-23):
 *  - File size and format/mime type: checked for every platform.
 *  - Image dimensions/aspect ratio: checked where an official range exists
 *    (currently only Instagram's documented feed-image range).
 *  - Video DURATION and RESOLUTION are NOT checked. Reliably reading those
 *    requires ffprobe (a native binary) — a real infra decision (adding
 *    ffmpeg to the Render deploy) not yet made, and not worth making before
 *    real video-platform posting exists (still blocked on Phase 0 developer
 *    app registration). validateMediaForPlatform() returns `unchecked` notes
 *    for this rather than silently pretending video is fully validated.
 *  - "meta" doesn't distinguish Facebook Page vs Instagram in the current
 *    schema (see PlatformAdapter's platform union) — this validates against
 *    Instagram's documented limits as the stricter, more-likely-hit default;
 *    a genuine Facebook-only post could be more lenient than what's enforced
 *    here. Revisit if/when the schema splits "meta" into fb/instagram.
 *
 *  Sources: developers.tiktok.com (Content Posting API media transfer guide),
 *  developers.facebook.com (Reels Publishing API, IG User Media reference).
 *  Pinterest's numbers come from Pinterest's own consumer help center, NOT
 *  the developers.pinterest.com API reference page (which didn't render
 *  extractable content when researched) — flagged as lower-confidence below.
 */

export type Platform = "meta" | "tiktok" | "pinterest";

export interface MediaMeta {
  mimeType: string;
  sizeBytes: number;
  width: number | null; // null for video, or if dimensions couldn't be read
  height: number | null;
}

export interface MediaValidationResult {
  valid: boolean;
  /** Customer-facing reason the post was rejected, if invalid. */
  reason: string | null;
  /** Things this check does NOT cover for this media, so callers/logs never
   *  imply full coverage that doesn't exist (e.g. video duration). */
  unchecked: string[];
}

const MB = 1024 * 1024;
const isImage = (mimeType: string) => mimeType.startsWith("image/");
const isVideo = (mimeType: string) => mimeType.startsWith("video/");

interface PlatformRules {
  image: { maxSizeBytes: number; allowedMimeTypes: string[] };
  video: { maxSizeBytes: number; allowedMimeTypes: string[] };
}

const RULES: Record<Platform, PlatformRules> = {
  // Instagram Graph API, IG User Media reference (developers.facebook.com).
  meta: {
    image: { maxSizeBytes: 8 * MB, allowedMimeTypes: ["image/jpeg", "image/png"] },
    // Reels: 300MB max, MP4/MOV — but LazyRelay's own upload endpoint caps
    // ALL uploads at 20MB today (see MEDIA_UPLOAD_MAX_BYTES in routes.ts),
    // far below this — a real video Reel would already be rejected by our
    // own cap long before reaching this platform-specific one.
    video: { maxSizeBytes: 300 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime"] },
  },
  // TikTok Content Posting API media transfer guide (developers.tiktok.com).
  tiktok: {
    image: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["image/jpeg", "image/webp"] },
    video: { maxSizeBytes: 4 * 1024 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime", "video/webm"] },
  },
  // Pinterest consumer help center (help.pinterest.com) — the actual
  // developers.pinterest.com media-create API reference didn't render
  // extractable content when researched; treat these as lower-confidence
  // than the TikTok/Meta numbers above and spot-check before relying on
  // them for anything beyond a customer-facing pre-flight warning.
  pinterest: {
    image: {
      maxSizeBytes: 20 * MB,
      allowedMimeTypes: ["image/bmp", "image/jpeg", "image/png", "image/tiff", "image/webp"],
    },
    video: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime"] }, // video Pin max size unconfirmed — using the image cap as a conservative floor, not a sourced number
  },
};

// Instagram feed image dimension/aspect-ratio range — the one platform with
// an official, specific range found in this research pass.
const INSTAGRAM_IMAGE_WIDTH_RANGE = { min: 320, max: 1440 };
const INSTAGRAM_IMAGE_ASPECT_RATIO_RANGE = { min: 0.8, max: 1.91 }; // 4:5 to 1.91:1

export function validateMediaForPlatform(platform: Platform, media: MediaMeta): MediaValidationResult {
  const unchecked: string[] = [];
  const rules = RULES[platform];

  if (isImage(media.mimeType)) {
    if (!rules.image.allowedMimeTypes.includes(media.mimeType)) {
      return {
        valid: false,
        reason: `${platform} doesn't accept ${media.mimeType} images — use one of: ${rules.image.allowedMimeTypes.join(", ")}.`,
        unchecked,
      };
    }
    if (media.sizeBytes > rules.image.maxSizeBytes) {
      return {
        valid: false,
        reason: `Image is ${(media.sizeBytes / MB).toFixed(1)}MB, which exceeds ${platform}'s ${(rules.image.maxSizeBytes / MB).toFixed(0)}MB limit for images.`,
        unchecked,
      };
    }
    if (platform === "meta" && media.width != null && media.height != null) {
      if (media.width < INSTAGRAM_IMAGE_WIDTH_RANGE.min || media.width > INSTAGRAM_IMAGE_WIDTH_RANGE.max) {
        return {
          valid: false,
          reason: `Image width is ${media.width}px — Instagram requires between ${INSTAGRAM_IMAGE_WIDTH_RANGE.min}px and ${INSTAGRAM_IMAGE_WIDTH_RANGE.max}px.`,
          unchecked,
        };
      }
      const aspectRatio = media.width / media.height;
      if (aspectRatio < INSTAGRAM_IMAGE_ASPECT_RATIO_RANGE.min || aspectRatio > INSTAGRAM_IMAGE_ASPECT_RATIO_RANGE.max) {
        return {
          valid: false,
          reason: `Image aspect ratio (${aspectRatio.toFixed(2)}:1) is outside Instagram's accepted range (4:5 to 1.91:1).`,
          unchecked,
        };
      }
    } else if (platform !== "meta") {
      unchecked.push("image dimensions/aspect ratio (no official range confirmed for this platform)");
    }
    return { valid: true, reason: null, unchecked };
  }

  if (isVideo(media.mimeType)) {
    unchecked.push("video duration", "video resolution/aspect ratio");
    if (!rules.video.allowedMimeTypes.includes(media.mimeType)) {
      return {
        valid: false,
        reason: `${platform} doesn't accept ${media.mimeType} videos — use one of: ${rules.video.allowedMimeTypes.join(", ")}.`,
        unchecked,
      };
    }
    if (media.sizeBytes > rules.video.maxSizeBytes) {
      return {
        valid: false,
        reason: `Video is ${(media.sizeBytes / MB).toFixed(1)}MB, which exceeds ${platform}'s ${(rules.video.maxSizeBytes / MB).toFixed(0)}MB limit for videos.`,
        unchecked,
      };
    }
    return { valid: true, reason: null, unchecked };
  }

  return { valid: true, reason: null, unchecked: ["unrecognized media type — no platform rules applied"] };
}
