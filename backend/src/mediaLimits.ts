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

export type Platform =
  | "meta"
  | "tiktok"
  | "pinterest"
  | "youtube"
  | "mastodon"
  | "bluesky"
  | "telegram"
  | "linkedin"
  | "threads"
  | "facebook"
  | "instagram"
  | "discord"
  | "tumblr"
  | "x"
  | "google-business";

// Platforms without a researched, bespoke rule yet fall back to the same
// 20MB size cap + mime allowlist LazyRelay's own /media/upload endpoint
// used to enforce app-wide (the app-wide cap itself was raised to 1GB
// 2026-09-05 — this fallback stays at the old, conservative 20MB rather than
// following it up, since a platform on this list has NOT been individually
// researched and 20MB is a safer floor than silently allowing up to 1GB
// against an unresearched real limit).
const GENERIC_FALLBACK_RULES: PlatformRules = {
  image: {
    maxSizeBytes: 20 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  video: {
    maxSizeBytes: 20 * 1024 * 1024,
    allowedMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
  },
};
// LinkedIn genuinely still unresearched for video (no video-posting code
// exists yet — see project-media-pipeline-video-support-2026-09-05, gated
// on its own Community Management API partner-tier approval).
const PLATFORMS_WITH_GENERIC_RULES: Platform[] = ["linkedin"];

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
  // Instagram Graph API, IG User Media / Reels reference — re-verified live
  // 2026-09-05 (developers.facebook.com/docs/instagram-platform/...). Real
  // accounts are stored as platform "meta" today, not split into separate
  // "facebook"/"instagram" rows (see file header) — this rule is what
  // actually governs every real Meta post right now. It uses Instagram's
  // numbers specifically because Facebook Page video has NO fixed published
  // limit at all (Meta's own docs point to a live `video-upload-limits`
  // Graph API node that must be queried per-account, not a static figure) —
  // Instagram's real 300MB/15min ceiling is used as the safer of the two
  // known real numbers until the "meta" schema splits and Facebook's own
  // live-queried limit can be wired in separately.
  meta: {
    image: { maxSizeBytes: 8 * MB, allowedMimeTypes: ["image/jpeg", "image/png"] },
    video: { maxSizeBytes: 300 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime"] },
  },
  // TikTok Content Posting API media transfer guide (developers.tiktok.com)
  // — re-verified live 2026-09-05, unchanged: 4GB max, 10min max duration.
  tiktok: {
    image: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["image/jpeg", "image/webp"] },
    video: { maxSizeBytes: 4 * 1024 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime", "video/webm"] },
  },
  // Pinterest — re-checked live 2026-09-05. The v5 API reference itself
  // (developers.pinterest.com/docs/api/v5/media-create) still documents no
  // numeric limit; the ~2GB figure below comes from Pinterest's own linked
  // "Pin specs" help-center page (help.pinterest.com), which the dev docs
  // cross-reference as the real source — same lower-confidence caveat as
  // before, now with a real (if softer-sourced) number instead of reusing
  // the image cap as a placeholder.
  pinterest: {
    image: {
      maxSizeBytes: 20 * MB,
      allowedMimeTypes: ["image/bmp", "image/jpeg", "image/png", "image/tiff", "image/webp"],
    },
    video: { maxSizeBytes: 2 * 1024 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime"] },
  },
  // YouTube Data API v3 (developers.google.com/youtube/v3/guides/uploading_a_video)
  // — researched live 2026-09-05. Real ceiling is 256GB/12hr for a verified
  // channel, far above anything relevant here; LazyRelay's own 1GB app-wide
  // cap binds first in every real case, so this rule exists mainly to stop
  // falling through to the (lower) generic floor. Real caveat that isn't a
  // size/format check this file can express: an UNVERIFIED YouTube channel
  // is hard-capped at 15 minutes by YouTube itself, with no API field to
  // check that in advance — worth a customer-facing warning when YouTube's
  // real upload code gets built, not something mediaLimits.ts can catch.
  youtube: {
    image: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["image/jpeg", "image/png"] },
    video: { maxSizeBytes: 256 * 1024 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime", "video/webm"] },
  },
  // Mastodon — researched live 2026-09-05. Real limit is genuinely
  // PER-INSTANCE (each server admin sets its own `video_size_limit` via
  // `GET /api/v2/instance`), not a protocol constant — federation means
  // there is no single correct static number here. 99MB (the documented
  // reference/flagship-instance default) is used as a reasonable static
  // floor for now; the real fix is a live per-connected-account instance
  // query, tracked as a known follow-up rather than silently assumed
  // correct for every instance a customer might connect.
  mastodon: {
    image: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
    video: { maxSizeBytes: 99 * MB, allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime"] },
  },
  // Bluesky (docs.bsky.app / bsky.network) — researched live 2026-09-05.
  // Real limit raised from 100MB/3min to 300MB/10min on 2026-08-25, ~2 weeks
  // before this check — the previous planning note's "100MB/3min" was
  // already stale. No video-posting code exists yet for Bluesky (see
  // project-media-pipeline-video-support-2026-09-05) — this rule is ready
  // for when that gets built.
  bluesky: {
    image: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
    video: { maxSizeBytes: 300 * MB, allowedMimeTypes: ["video/mp4"] },
  },
  // Telegram Bot API sendVideo (core.telegram.org/bots/api) — researched
  // live 2026-09-05. Real, HARD, sourced ceiling on the standard hosted Bot
  // API: 50MB, no way around it short of self-hosting a Bot API server
  // (out of scope). Must surface to the customer as Telegram's own limit,
  // not LazyRelay's, same pattern as this file already does for TikTok/X.
  telegram: {
    image: { maxSizeBytes: 10 * MB, allowedMimeTypes: ["image/jpeg", "image/png"] },
    video: { maxSizeBytes: 50 * MB, allowedMimeTypes: ["video/mp4"] },
  },
  // Threads (developers.facebook.com/documentation/threads/posts,
  // researched live 2026-09-05): 1GB max, 5min max duration. Video support
  // built the same day (see threads.ts).
  threads: {
    image: { maxSizeBytes: 8 * MB, allowedMimeTypes: ["image/jpeg", "image/png"] },
    video: { maxSizeBytes: 1024 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime"] },
  },
  // Tumblr — genuinely unconfirmed for video, same honesty pattern already
  // used for Pinterest above. The only documented number (500MB/10min) is
  // stated for a LEGACY endpoint, not the NPF video block this adapter
  // actually uses (tumblr.ts, built 2026-09-05) -- Tumblr's own docs never
  // confirm it applies there. Used as a conservative-but-unverified working
  // number rather than inventing a different one; spot-check against a real
  // post before trusting it for anything beyond a customer-facing warning.
  tumblr: {
    image: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["image/jpeg", "image/png", "image/gif"] },
    video: { maxSizeBytes: 500 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime"] },
  },
  // Discord (discord.com/developers/docs, researched live 2026-09-05):
  // there is no single real ceiling -- it depends entirely on the
  // DESTINATION SERVER's own boost tier (20MB unboosted, up to 100MB at max
  // boost, occasionally 250MB/500MB with a purchased add-on), which this
  // adapter has no way to know in advance from just a webhook URL. 20MB
  // (the real, universal floor every server supports) is used as the
  // conservative default so a customer is warned before scheduling rather
  // than finding out only when Discord itself rejects a bigger file at
  // send time -- their real server may well allow more.
  discord: {
    image: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"] },
    video: { maxSizeBytes: 20 * MB, allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime"] },
  },
  // The remaining platforms don't have a researched, bespoke rule yet — see
  // GENERIC_FALLBACK_RULES above. validateMediaForPlatform() surfaces this
  // via the `unchecked` field rather than pretending real limits exist.
  linkedin: GENERIC_FALLBACK_RULES,
  facebook: GENERIC_FALLBACK_RULES,
  instagram: GENERIC_FALLBACK_RULES,
  // X's own current v2 media API (docs.x.com/x-api/media/...) — RE-VERIFIED
  // live 2026-09-05 and CORRECTED: the old v1.1 chunked media-upload
  // endpoints this file's numbers were based on were sunset June 2025. Real
  // v2 numbers: 8GB default / 16GB for Premium/verified accounts. The `x`
  // adapter itself (platforms/x.ts) still calls the dead v1.1 endpoint as of
  // 2026-09-05 — X posting is not live for customers (not funded, see
  // registry.ts gating), so this is a real but not customer-impacting bug
  // today. Flagged for a full v2 migration + real chunking rebuild whenever
  // X gets funded, not patched here.
  x: {
    image: { maxSizeBytes: 5 * MB, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
    video: { maxSizeBytes: 8 * 1024 * MB, allowedMimeTypes: ["video/mp4", "video/quicktime"] },
  },
  // support.google.com/business/answer/6103862 (verified 2026-08-17, never
  // tested against a real account — API access itself is still gated, see
  // platforms/googleBusiness.ts). Local Posts document photo media only, no
  // video path, so the video rule here exists only so
  // validateMediaForPlatform() returns a clear rejection rather than an
  // undefined-rule crash if a customer tries to attach one.
  "google-business": {
    image: { maxSizeBytes: 5 * MB, allowedMimeTypes: ["image/jpeg", "image/png"] },
    video: { maxSizeBytes: 0, allowedMimeTypes: [] },
  },
};

// Instagram feed image dimension/aspect-ratio range — the one platform with
// an official, specific range found in this research pass.
const INSTAGRAM_IMAGE_WIDTH_RANGE = { min: 320, max: 1440 };
const INSTAGRAM_IMAGE_ASPECT_RATIO_RANGE = { min: 0.8, max: 1.91 }; // 4:5 to 1.91:1

export function validateMediaForPlatform(platform: Platform, media: MediaMeta): MediaValidationResult {
  const unchecked: string[] = [];
  if (PLATFORMS_WITH_GENERIC_RULES.includes(platform)) {
    unchecked.push(`${platform} has no researched platform-specific media rules yet — validated against a generic size/format floor only`);
  }
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
