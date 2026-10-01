// Platform rules lookup for the MCP server: "what does this platform accept?"
// so an AI agent can check BEFORE scheduling a post. Pure data, no database.
//
// Where a number already lives in the repo it is IMPORTED, not retyped:
//   - multi-item limits          -> MULTI_MEDIA_RULES (carousel.ts)
//   - thread follow-up length    -> CHAIN_ITEM_MAX_LENGTH, MAX_CHAIN_ITEMS, OPTION_KEY_FOR_PLATFORM (postOptions.ts)
//   - first comment length       -> MAX_FIRST_COMMENT_LENGTH, TIKTOK_PRIVACY_LEVELS (postCreation.ts)
//   - rolling 24h post cap       -> getRolling24hPostLimit (platformPostLimits.ts)
// mediaLimits.ts exports no getter (only validateMediaForPlatform), so the file
// size and format numbers below are copied from its RULES table and marked
// "mediaLimits.ts" in comments. Every other number was checked against the
// platform's official docs on 2026-09-30 (Slack on 2026-10-01) and the URL is in `sources`. A number
// that could not be verified is null and says "not verified" in its note.
//
// No em dash or en dash characters in any string value (a test enforces it).

import { MULTI_MEDIA_RULES } from "./carousel.js";
import { CHAIN_ITEM_MAX_LENGTH, MAX_CHAIN_ITEMS, OPTION_KEY_FOR_PLATFORM } from "./postOptions.js";
import { MAX_FIRST_COMMENT_LENGTH, MAX_POST_CONTENT_LENGTH, TIKTOK_PRIVACY_LEVELS } from "./postCreation.js";
import { NOSTR_TEXT_LIMIT } from "./platforms/nostrConstants.js";
import { WHOP_TEXT_LIMIT } from "./platforms/whopApi.js";
import { getRolling24hPostLimit, PINTEREST_WARMUP_DAYS, PINTEREST_WARMUP_RAMP } from "./platformPostLimits.js";

export type LookupTool = "list_pinterest_boards" | "get_tiktok_creator_info" | "list_connected_accounts" | "get_next_free_slot";

export interface PlatformRuleSet {
  platform: string;
  label: string;
  text: { maxLength: number | null; note: string };
  media: {
    textOnlyAllowed: boolean;
    image: { supported: boolean; formats: string[]; maxSizeMb: number | null };
    video: { supported: boolean; formats: string[]; maxSizeMb: number | null; maxDurationSec: number | null };
    multiItem: { maxItems: number; videosAllowed: boolean } | null;
    notes: string;
  };
  /** Post-request fields that must be sent for this platform, in the API's own field names. */
  required: string[];
  features: string[];
  /** "<options key>: what it does". The key is the one this platform reads inside `options`. */
  options: string[];
  limits: { rollingPostsPer24h: number | null; note: string };
  lookups: LookupTool[];
  notes: string[];
  sources: string[];
}

const MB = 1; // sizes below are in megabytes
const GB = 1024;

// Fields every scheduled post needs (validatePostFields in postCreation.ts).
const BASE_REQUIRED = ["socialAccountId", "content", "scheduledFor"];

const multiItem = (platform: string): { maxItems: number; videosAllowed: boolean } | null => {
  const rule = MULTI_MEDIA_RULES[platform];
  return rule ? { maxItems: rule.max, videosAllowed: rule.videos } : null;
};

const optionsFor = (platform: string, description: string): string[] => {
  const key = OPTION_KEY_FOR_PLATFORM[platform];
  return key ? [`${key}: ${description}`] : [];
};

const noRepoCap = (note: string): PlatformRuleSet["limits"] => ({ rollingPostsPer24h: null, note });

const CHAIN_DESCRIPTION = `list of up to ${MAX_CHAIN_ITEMS} follow-up posts that reply to the main post in order (a thread); each item is limited to the platform's own post length`;

const IG_DOCS = "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing";
const IG_MEDIA_DOCS = "https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media";

function buildRules(): PlatformRuleSet[] {
  const rules: PlatformRuleSet[] = [
    {
      platform: "instagram",
      label: "Instagram",
      text: {
        maxLength: 2200,
        note: "Caption: 2200 characters, at most 30 hashtags and 20 @mentions (Meta docs). Stories carry no caption.",
      },
      media: {
        textOnlyAllowed: false,
        // Meta docs: JPEG only, 8 MB (mediaLimits.ts enforces 8 MB and lets png through, Instagram itself wants JPEG, so JPEG is listed).
        image: { supported: true, formats: ["jpeg"], maxSizeMb: 8 * MB },
        // mediaLimits.ts (fixed 2026-09-30) and Meta: 300 MB for Reels, mp4/mov. Story video is 100 MB and 60 s. Reels max 15 min (900 s).
        video: { supported: true, formats: ["mp4", "mov"], maxSizeMb: 300 * MB, maxDurationSec: 900 },
        multiItem: multiItem("instagram"),
        notes:
          "Needs an image or a video. A single video posts as a Reel or a Story, not to the feed. Feed images must be 4:5 to 1.91:1 and 320 to 1440 px wide. Reels: 3 s to 15 min, 9:16 recommended. Story video: 3 to 60 s. Story video is limited to 100 MB by Meta.",
      },
      required: [...BASE_REQUIRED, "mediaUrl"],
      features: ["first comment", "delayed first comment", "self-reply at N likes", "story", "reel", "trial reel", "carousel", "post tags"],
      options: optionsFor(
        "instagram",
        "placement (feed, reel or story); trialReel (true shows a Reel to non-followers first, single video Reels only); trialGraduation (manual or auto, only with trialReel)",
      ),
      limits: noRepoCap("LazyRelay enforces no cap. Instagram itself allows 100 API-published posts per rolling 24 hours (a carousel counts as one); Meta's carousel section of the same page says 50, so treat 50 as the safe number."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "Instagram needs an image or video: text-only posts are refused.",
        "Stories carry no caption.",
        "A trial reel must be a single video with placement reel.",
        `firstComment is limited to ${MAX_FIRST_COMMENT_LENGTH} characters; firstCommentDelayMinutes (0 to 1440) holds the comment back that many minutes after the post goes live; selfReplyText/selfReplyAtLikes add a reply once the post reaches N likes (checked at the metrics poll, not instantly).`,
        "Carousel images are all cropped to the first image's ratio (1:1 by default).",
      ],
      sources: [IG_DOCS, IG_MEDIA_DOCS],
    },
    {
      platform: "facebook",
      label: "Facebook Page",
      text: {
        maxLength: null,
        note: `Post text limit is not verified: Meta's Page feed docs state none. LazyRelay itself refuses content over ${MAX_POST_CONTENT_LENGTH} characters.`,
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: images use the generic floor (20 MB, jpeg/png/webp/gif); video is 300 MB (fixed 2026-09-30, was a 20 MB floor), mp4/mov/webm.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 20 * MB },
        video: { supported: true, formats: ["mp4", "mov", "webm"], maxSizeMb: 300 * MB, maxDurationSec: null },
        multiItem: multiItem("facebook"),
        notes:
          "The image limit is LazyRelay's generic 20 MB floor (mediaLimits.ts), not a verified Facebook limit. Meta publishes no fixed video size limit, so LazyRelay uses 300 MB. Video duration not verified. Multi-photo posts take images only. A Story is one image or one video.",
      },
      required: [...BASE_REQUIRED],
      features: ["first comment", "delayed first comment", "self-reply at N likes", "story", "multi-photo post", "post tags"],
      options: optionsFor("facebook", "placement (feed or story); a story needs one image or video and no extra images"),
      limits: noRepoCap("LazyRelay enforces no cap. Facebook's own posting rate limit is not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "Posts go to the connected Facebook Page, not a personal profile.",
        `firstComment is limited to ${MAX_FIRST_COMMENT_LENGTH} characters; firstCommentDelayMinutes (0 to 1440) holds it back that many minutes after the post goes live.`,
        "A Facebook Story needs an image or a video and cannot carry several files.",
      ],
      sources: ["https://developers.facebook.com/docs/graph-api/reference/page/feed/"],
    },
    {
      platform: "tiktok",
      label: "TikTok",
      text: {
        maxLength: 2200,
        note: "Video title/caption: 2200 UTF-16 characters (TikTok Direct Post reference). LazyRelay sends the post text as the title.",
      },
      media: {
        textOnlyAllowed: false,
        // The adapter (platforms/tiktok.ts) only posts video ("TikTok posts require a video URL"), so images are not supported.
        image: { supported: false, formats: [], maxSizeMb: null },
        // mediaLimits.ts: 4 GB. TikTok media transfer guide: MP4/WebM/MOV, 10 min max via the upload endpoint.
        video: { supported: true, formats: ["mp4", "mov", "webm"], maxSizeMb: 4 * GB, maxDurationSec: 600 },
        multiItem: multiItem("tiktok"),
        notes: "Video only. 23 to 60 fps, 360 to 4096 px per side. Photo posts and text-only posts are not supported by LazyRelay's TikTok adapter.",
      },
      required: [...BASE_REQUIRED, "mediaUrl", "tiktokPrivacyLevel"],
      features: [
        "privacy level choice",
        "disable comments, duet and stitch",
        "commercial content disclosure",
        "AI-generated label",
      ],
      options: optionsFor("tiktok", "aiGenerated (true labels the video as AI-generated content)"),
      limits: noRepoCap("LazyRelay enforces no cap. TikTok's per-account posting cap is not verified."),
      lookups: ["get_tiktok_creator_info", "list_connected_accounts", "get_next_free_slot"],
      notes: [
        `tiktokPrivacyLevel has no default and must be one of: ${TIKTOK_PRIVACY_LEVELS.join(", ")}. Call get_tiktok_creator_info first: the levels a creator may pick vary by account.`,
        "tiktokDisableComment, tiktokDisableDuet and tiktokDisableStitch default to true (interactions off); tiktokBrandOrganic and tiktokBrandContent default to false.",
        "Branded content (tiktokBrandContent true) cannot be SELF_ONLY.",
        "TikTok's own docs also list FOLLOWER_OF_CREATOR as a privacy level, which LazyRelay does not accept.",
      ],
      sources: [
        "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
        "https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide/",
      ],
    },
    {
      platform: "youtube",
      label: "YouTube",
      text: {
        maxLength: 5000,
        note: "The post text becomes the video description (5000 bytes, YouTube Data API; no < or > characters). The title is options.youtube.title or the first 100 characters of the text (title max 100 characters).",
      },
      media: {
        textOnlyAllowed: false,
        image: { supported: false, formats: [], maxSizeMb: null },
        // mediaLimits.ts: 256 GB (YouTube's own ceiling); LazyRelay's app-wide upload cap is lower in practice.
        video: { supported: true, formats: ["mp4", "mov", "webm"], maxSizeMb: 256 * GB, maxDurationSec: null },
        multiItem: multiItem("youtube"),
        notes:
          "Video only. YouTube allows up to 256 GB; LazyRelay's own upload cap binds first. Duration limit not verified (YouTube caps unverified channels at a shorter length).",
      },
      required: [...BASE_REQUIRED, "mediaUrl"],
      features: ["custom title", "visibility (public, unlisted, private)", "made for kids flag", "tags", "AI-generated label"],
      options: optionsFor(
        "youtube",
        "title (max 100 chars); privacy (public, unlisted or private); madeForKids (true or false); tags (up to 15 tags, 30 chars each); aiGenerated (true or false)",
      ),
      limits: noRepoCap("LazyRelay enforces no cap. YouTube's upload quota is not verified for this project."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "Videos uploaded by an unverified API project are restricted to private until the project passes YouTube's audit.",
        "Tags share a 500 character combined limit on YouTube's side.",
      ],
      sources: ["https://developers.google.com/youtube/v3/docs/videos", "https://developers.google.com/youtube/v3/docs/videos/insert"],
    },
    {
      platform: "pinterest",
      label: "Pinterest",
      text: {
        maxLength: 500,
        note: "LazyRelay sends the first 100 characters of the text as the Pin title and the first 500 as the description. Pinterest's own API allows a description up to 800 characters, title 100, alt text 500.",
      },
      media: {
        textOnlyAllowed: false,
        // mediaLimits.ts: 20 MB, bmp/jpeg/png/tiff/webp images (minimum 100 x 200 px); 2 GB mp4/mov video (Pinterest help-center figure, lower confidence).
        image: { supported: true, formats: ["bmp", "jpeg", "png", "tiff", "webp"], maxSizeMb: 20 * MB },
        video: { supported: true, formats: ["mp4", "mov"], maxSizeMb: 2 * GB, maxDurationSec: null },
        multiItem: multiItem("pinterest"),
        notes: "A Pin needs an image or video. A video Pin also needs coverImageUrl (a still image). Images must be at least 100 x 200 px. Video duration not verified.",
      },
      required: [...BASE_REQUIRED, "mediaUrl", "boardId"],
      features: ["board choice", "destination link", "video Pin with cover image"],
      options: [],
      limits: {
        rollingPostsPer24h: getRolling24hPostLimit("pinterest"),
        note: `LazyRelay caps Pinterest at this many pins per account per rolling 24 hours (env PINTEREST_DAILY_POST_LIMIT can change it). A new connection also has a warm-up ramp: ${PINTEREST_WARMUP_RAMP.map((r) => `${r.limit} a day until day ${r.untilDay}`).join(", ")}, then the full cap from day ${PINTEREST_WARMUP_DAYS}. Use get_next_free_slot to find an open time.`,
      },
      lookups: ["list_pinterest_boards", "list_connected_accounts", "get_next_free_slot"],
      notes: [
        "boardId is required for a predictable result: the backend accepts a post without it and falls back to the account's first board, but an agent should always choose a board with list_pinterest_boards.",
        "destinationLink (max 2048 chars) is the Pin's click-through address.",
        "coverImageUrl is required when mediaUrl is a video.",
        "Pinterest is strict with brand-new accounts and domains: a real rejection read that only 10 posts in 24 hours are allowed.",
      ],
      sources: ["https://developers.pinterest.com/docs/api/v5/pins-create"],
    },
    {
      platform: "linkedin",
      label: "LinkedIn",
      text: {
        maxLength: null,
        note: `Post commentary limit not verified: LinkedIn's Posts API page only says over-long commentary returns FIELD_LENGTH_TOO_LONG. LazyRelay itself refuses content over ${MAX_POST_CONTENT_LENGTH} characters.`,
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: linkedin uses the generic fallback (20 MB, jpeg/png/webp/gif). The adapter posts images only, no video.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 20 * MB },
        video: { supported: false, formats: [], maxSizeMb: null, maxDurationSec: null },
        multiItem: multiItem("linkedin"),
        notes: "Images only in LazyRelay (no video posting yet). Image size is LazyRelay's generic 20 MB floor, not a verified LinkedIn limit. A post carries either images or a PDF document, not both.",
      },
      required: [...BASE_REQUIRED],
      features: ["PDF document", "multi-image post", "post tags"],
      options: optionsFor("linkedin", "documentUrl (https address of a PDF); documentTitle (max 100 chars, needs documentUrl)"),
      limits: noRepoCap("LazyRelay enforces no cap. LinkedIn's own posting limits are not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "options.linkedin.documentUrl must be an https link ending in .pdf.",
        "A document post cannot also carry mediaUrl or mediaUrls.",
      ],
      sources: ["https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api"],
    },
    {
      platform: "threads",
      label: "Threads",
      text: {
        maxLength: CHAIN_ITEM_MAX_LENGTH.threads,
        note: "Text posts are limited to 500 characters (Threads API docs).",
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: 8 MB jpeg/png images; 1 GB mp4/mov video. Threads docs: video up to 300 s.
        image: { supported: true, formats: ["jpeg", "png"], maxSizeMb: 8 * MB },
        video: { supported: true, formats: ["mp4", "mov"], maxSizeMb: 1 * GB, maxDurationSec: 300 },
        multiItem: multiItem("threads"),
        notes: "Images 320 to 1440 px wide. Threads' own docs allow carousels of up to 20 items; LazyRelay allows up to the number shown here.",
      },
      required: [...BASE_REQUIRED],
      features: ["thread chain", "carousel with videos", "post tags"],
      options: optionsFor("threads", CHAIN_DESCRIPTION),
      limits: noRepoCap("LazyRelay enforces no cap. Threads allows 250 published posts per rolling 24 hours (Threads API docs)."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [`options.chain follow-ups are each limited to ${CHAIN_ITEM_MAX_LENGTH.threads} characters, at most ${MAX_CHAIN_ITEMS} items.`],
      sources: ["https://developers.facebook.com/documentation/threads/posts"],
    },
    {
      platform: "bluesky",
      label: "Bluesky",
      text: {
        maxLength: CHAIN_ITEM_MAX_LENGTH.bluesky,
        note: "300 graphemes (what a person sees as characters), also at most 3000 bytes (Bluesky post lexicon).",
      },
      media: {
        textOnlyAllowed: true,
        // Bluesky's image blob limit is 2 MB (lexicon). mediaLimits.ts allows 20 MB for bluesky images, which is higher than Bluesky accepts.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 2 * MB },
        // mediaLimits.ts: 300 MB mp4. The 10 minute duration comes from the mediaLimits.ts comment (raised 2026-08-25), not re-verified against Bluesky docs.
        video: { supported: true, formats: ["mp4"], maxSizeMb: 300 * MB, maxDurationSec: 600 },
        multiItem: multiItem("bluesky"),
        notes:
          "Image blobs are limited to 2 MB by Bluesky (LazyRelay's own check allows up to 20 MB, so a larger image passes LazyRelay and fails at Bluesky). Video needs the account's email to be confirmed. Alt text applies to the first image only.",
      },
      required: [...BASE_REQUIRED],
      features: ["thread chain", "alt text", "multi-image post", "post tags"],
      options: optionsFor("bluesky", CHAIN_DESCRIPTION),
      limits: noRepoCap("LazyRelay enforces no cap. Bluesky's own posting limits are not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        `options.chain follow-ups are each limited to ${CHAIN_ITEM_MAX_LENGTH.bluesky} characters, at most ${MAX_CHAIN_ITEMS} items.`,
        "mediaAltText (max 1000 chars) is sent as the alt text.",
      ],
      sources: [
        "https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json",
        "https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json",
      ],
    },
    {
      platform: "mastodon",
      label: "Mastodon",
      text: {
        maxLength: CHAIN_ITEM_MAX_LENGTH.mastodon,
        note: "500 characters is the default (mastodon.social); each Mastodon server sets its own limit, so a customer's server may differ.",
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: 20 MB images, 99 MB video (mastodon.social's 103809024 bytes). Mastodon.social's image limit is 16 MB. Every limit is per instance.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 20 * MB },
        video: { supported: true, formats: ["mp4", "webm", "mov"], maxSizeMb: 99 * MB, maxDurationSec: null },
        multiItem: multiItem("mastodon"),
        notes:
          "All media limits are set per server. LazyRelay's numbers are a static floor: 99 MB video matches mastodon.social, whose image limit is 16 MB (LazyRelay's check allows 20 MB). Video duration not verified.",
      },
      required: [...BASE_REQUIRED],
      features: ["thread chain", "alt text", "multi-image post", "post tags"],
      options: optionsFor("mastodon", CHAIN_DESCRIPTION),
      limits: noRepoCap("LazyRelay enforces no cap. Rate limits are set per Mastodon server."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        `options.chain follow-ups are each limited to ${CHAIN_ITEM_MAX_LENGTH.mastodon} characters, at most ${MAX_CHAIN_ITEMS} items.`,
        "mediaAltText (max 1000 chars) is sent as the media description.",
        "Up to 4 media attachments per status.",
      ],
      sources: ["https://docs.joinmastodon.org/entities/Instance/"],
    },
    {
      platform: "x",
      label: "X",
      text: { maxLength: CHAIN_ITEM_MAX_LENGTH.x, note: "280 characters per post (X API)." },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: 5 MB images, 8 GB video. X docs: default accounts 20 minutes / 8 GB (Premium: 125 minutes / 16 GB).
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 5 * MB },
        video: { supported: true, formats: ["mp4", "mov"], maxSizeMb: 8 * GB, maxDurationSec: 1200 },
        multiItem: multiItem("x"),
        notes: "Up to 4 photos, or 1 animated GIF, or 1 video per post. Video limits shown are for default accounts. Image size limit is LazyRelay's own figure and was not confirmed in X's docs.",
      },
      required: [...BASE_REQUIRED],
      features: ["thread chain", "multi-image post", "post tags"],
      options: optionsFor("x", CHAIN_DESCRIPTION),
      limits: noRepoCap("LazyRelay enforces no cap. X's own posting limits are not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [`options.chain follow-ups are each limited to ${CHAIN_ITEM_MAX_LENGTH.x} characters, at most ${MAX_CHAIN_ITEMS} items.`],
      sources: ["https://docs.x.com/x-api/posts/create-post"],
    },
    {
      platform: "tumblr",
      label: "Tumblr",
      text: {
        maxLength: null,
        note: `Tumblr publishes no text limit that could be verified. LazyRelay itself refuses content over ${MAX_POST_CONTENT_LENGTH} characters. Not verified.`,
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: 20 MB gif/jpeg/png; 500 MB mp4/mov video (Tumblr's docs confirm 500 MB only for a legacy endpoint, so unverified for the NPF blocks LazyRelay uses).
        image: { supported: true, formats: ["jpeg", "png", "gif"], maxSizeMb: 20 * MB },
        video: { supported: true, formats: ["mp4", "mov"], maxSizeMb: 500 * MB, maxDurationSec: null },
        multiItem: multiItem("tumblr"),
        notes: "Video size is a working number from a legacy endpoint, not verified for the current post format. Video duration not verified.",
      },
      required: [...BASE_REQUIRED],
      features: ["multi-image post", "blog choice at connect time", "post tags"],
      options: [],
      limits: noRepoCap("LazyRelay enforces no cap. Tumblr's own limits are not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: ["A Tumblr login can cover several blogs: the connected account is tied to the blog the customer picked."],
      sources: [],
    },
    {
      platform: "wordpress",
      label: "WordPress",
      text: {
        maxLength: null,
        note: `WordPress publishes no post length limit that could be verified. Not verified. LazyRelay itself refuses content over ${MAX_POST_CONTENT_LENGTH} characters. The post text becomes the article body (the first line is the title unless options.wordpress.title is set).`,
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: generic floor (20 MB, jpeg/png/webp/gif images, 20 MB mp4/mov/webm video). Each site sets its own upload limit.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 20 * MB },
        video: { supported: true, formats: ["mp4", "mov", "webm"], maxSizeMb: 20 * MB, maxDurationSec: null },
        multiItem: multiItem("wordpress"),
        notes: "Self-hosted WordPress sites only (version 5.6 or newer, https). The first image is the featured image; extra images are added at the end of the article. Upload limits are set by each site's host, so a larger file may be refused by the site itself. WordPress.com blogs are not supported yet.",
      },
      required: [...BASE_REQUIRED],
      features: ["article title", "categories and tags", "draft instead of publish", "featured image", "multi-image post"],
      options: optionsFor("wordpress", "title (optional, defaults to the first line of the post); status (publish or draft); categories and tags (lists of names, created when missing)"),
      limits: noRepoCap("LazyRelay enforces no cap. Rate limits depend on each site's host."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "The customer connects with a WordPress Application Password created in Users, Profile on their own site.",
        "A draft is saved on the site but cannot be proven live, so it is reported as saved, not published.",
      ],
      sources: ["https://developer.wordpress.org/rest-api/reference/posts/", "https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/"],
    },
    {
      platform: "devto",
      label: "dev.to",
      text: {
        maxLength: null,
        note: `dev.to states no body length limit (not verified beyond its docs). LazyRelay itself refuses content over ${MAX_POST_CONTENT_LENGTH} characters. The body is markdown; the first line is the title unless options.devto.title is set (LazyRelay caps titles at 250 characters, dev.to publishes no title limit).`,
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: generic image floor (20 MB); no video route.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 20 * MB },
        video: { supported: false, formats: [], maxSizeMb: null, maxDurationSec: null },
        multiItem: multiItem("devto"),
        notes: "Images are shown by address: the first is the cover image, the rest appear inside the article. dev.to has no video upload through its API, so a video is refused. Image size limit is LazyRelay's generic figure, not a verified dev.to limit.",
      },
      required: [...BASE_REQUIRED],
      features: ["article title", "up to 4 tags", "series", "canonical link", "draft instead of publish"],
      options: optionsFor("devto", "title (optional); published (false saves a draft); tags (up to 4); series; canonicalUrl (an https address)"),
      limits: noRepoCap("LazyRelay enforces no cap. dev.to's rate limits are not documented."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: ["The customer connects by pasting a dev.to API key from Settings, Extensions.", "dev.to has no scheduling field, so LazyRelay publishes at the scheduled time."],
      sources: ["https://developers.forem.com/api/v1"],
    },
    {
      platform: "hashnode",
      label: "Hashnode",
      text: {
        maxLength: null,
        note: `Hashnode's post length limit is not verified. LazyRelay itself refuses content over ${MAX_POST_CONTENT_LENGTH} characters. The body is markdown; the first line is the title unless options.hashnode.title is set.`,
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: generic image floor (20 MB); no video route.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 20 * MB },
        video: { supported: false, formats: [], maxSizeMb: null, maxDurationSec: null },
        multiItem: multiItem("hashnode"),
        notes: "The first image is the cover; the rest appear inside the article. No video. Image size limit is LazyRelay's generic figure, not verified.",
      },
      required: [...BASE_REQUIRED],
      features: ["article title", "subtitle", "up to 5 tags", "canonical link", "draft instead of publish"],
      options: optionsFor("hashnode", "title (optional); subtitle; tags (up to 5); canonicalUrl (an https address); draft (true saves a draft)"),
      limits: noRepoCap("LazyRelay enforces no cap. Hashnode's rate limits are not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: ["Since May 2026 Hashnode charges for API access: the customer's blog needs Hashnode's Pro plan.", "The customer connects with a personal access token from Hashnode's developer settings."],
      sources: ["https://hashnode.com/changelog/2026-05-13-graphql-api-paid-access"],
    },
    {
      platform: "lemmy",
      label: "Lemmy",
      text: {
        maxLength: 200,
        note: "Title: 200 characters (the first line of the post unless options.lemmy.title is set). Body: the rest of the text, as markdown, up to 10000 characters (LazyRelay's own cap).",
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: generic image floor (20 MB); no video route.
        image: { supported: true, formats: ["jpeg", "png", "webp", "gif"], maxSizeMb: 20 * MB },
        video: { supported: false, formats: [], maxSizeMb: null, maxDurationSec: null },
        multiItem: multiItem("lemmy"),
        notes: "An image is uploaded to the customer's Lemmy server. No video. Each server sets its own upload limit, so a larger file may be refused by the server itself.",
      },
      required: [...BASE_REQUIRED],
      features: ["community choice", "link post", "NSFW flag"],
      options: optionsFor("lemmy", "community (name or name@instance, needed unless one was saved when connecting); title; url (an https link to share); nsfw"),
      limits: noRepoCap("LazyRelay enforces no cap. Each Lemmy server sets its own rate limits."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "The customer connects with their server, username and password; LazyRelay keeps a login token, not the password.",
        "Lemmy expects automated posts to come from an account marked as a bot (Settings, Profile, Bot account).",
        "Each community has its own rules; a moderator can remove a post, which LazyRelay reports as not live.",
      ],
      sources: ["https://join-lemmy.org/docs/", "https://github.com/LemmyNet/lemmy-js-client"],
    },
    {
      platform: "slack",
      label: "Slack",
      text: {
        maxLength: 4000,
        note: "Message text: 4000 characters, which is Slack's own recommended limit for the text field (its hard limit is higher, LazyRelay uses 4000). The characters &, < and > are escaped so the text can never ping @channel, @here or a person, or hide a link.",
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: images and videos are refused. Slack's file upload flow needs an extra permission and is not built yet.
        image: { supported: false, formats: [], maxSizeMb: null },
        video: { supported: false, formats: [], maxSizeMb: null, maxDurationSec: null },
        multiItem: multiItem("slack"),
        notes: "Text and links only. Images and videos are not supported yet. A link in the text shows a preview in Slack.",
      },
      required: [...BASE_REQUIRED],
      features: ["posts to one public channel chosen when connecting", "link previews", "proof link to the live message"],
      options: [],
      limits: noRepoCap("LazyRelay enforces no cap. Slack allows about one message per second per channel."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "One connected account is one Slack workspace and one public channel. To post to another channel, connect Slack again and pick it.",
        "Private channels are not offered in the picker. If a private channel is ever used, the Slack app has to be invited to it first.",
        "Slack formats text with its own mrkdwn (*bold*, _italic_), not standard Markdown. The text is sent as typed.",
      ],
      sources: [
        "https://docs.slack.dev/reference/methods/chat.postMessage/",
        "https://docs.slack.dev/reference/methods/chat.getPermalink/",
        "https://docs.slack.dev/authentication/installing-with-oauth/",
      ],
    },
    {
      platform: "nostr",
      label: "Nostr",
      text: {
        maxLength: NOSTR_TEXT_LIMIT,
        note: "Plain text notes (kind 1): 4000 characters (at most 12000 bytes), LazyRelay's own cap (relays set their own limits, commonly 8 to 16 KB per event, so this stays safely under them). No markup: Nostr clients show the text as typed.",
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: images and videos are refused. Media on Nostr needs an upload host and imeta tags (NIP-92), which are not built yet.
        image: { supported: false, formats: [], maxSizeMb: null },
        video: { supported: false, formats: [], maxSizeMb: null, maxDurationSec: null },
        multiItem: multiItem("nostr"),
        notes: "Text only in this version. Images and videos are not supported yet. A link in the text is shown as a link by Nostr clients.",
      },
      required: [...BASE_REQUIRED],
      features: ["posts as the customer's own Nostr identity, signed in their own signer app (NIP-46)", "sent to the customer's own relays (NIP-65)", "proof link to the note, confirmed by reading it back from relays"],
      options: [],
      limits: noRepoCap("LazyRelay enforces no cap. Each relay sets its own rate limits."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "The customer's private key never reaches LazyRelay. They paste a bunker:// link from a signer app (such as Amber, nsec.app or Alby); LazyRelay keeps only that connection and a disposable key.",
        "The signer app must be online, and set to allow LazyRelay to sign notes without asking each time, whenever a scheduled post goes out. If it is offline the post is retried; if it refuses the post fails and the account needs reconnecting.",
        "A relay's OK is not proof. A post counts as live only when the same signed note is read back from a relay by its id.",
      ],
      sources: [
        "https://github.com/nostr-protocol/nips/blob/master/01.md",
        "https://github.com/nostr-protocol/nips/blob/master/46.md",
        "https://github.com/nostr-protocol/nips/blob/master/65.md",
        "https://github.com/nostr-protocol/nips/blob/master/19.md",
      ],
    },
    {
      platform: "whop",
      label: "Whop",
      text: {
        maxLength: WHOP_TEXT_LIMIT,
        note: "Forum post text in Markdown: 4000 characters. Whop states no limit of its own, so 4000 is LazyRelay's own conservative number. Posts are sent as typed; the characters <@ are broken with an invisible space so text can never turn into a mention, and nobody is notified.",
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: images and videos are refused. Whop's file upload flow is not built yet.
        image: { supported: false, formats: [], maxSizeMb: null },
        video: { supported: false, formats: [], maxSizeMb: null, maxDurationSec: null },
        multiItem: multiItem("whop"),
        notes: "Text only in this version. Images and videos are not supported yet.",
      },
      required: [...BASE_REQUIRED],
      features: ["posts to one forum in the customer's own Whop community, chosen when connecting", "Markdown text", "proof link to the live forum post"],
      options: [],
      limits: noRepoCap("LazyRelay enforces no cap. Whop allows 600 requests per minute per operation."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: [
        "One connected account is one forum in one Whop community. To post to another forum, connect Whop again and pick it.",
        "The community owner installs the LazyRelay app in Whop and approves three permissions (post in forums, read forums, read the community's forum list). LazyRelay then asks the owner or an admin to post a one-time code in a forum, to prove the community is theirs. One community can be connected to one LazyRelay account at a time.",
        "Posts appear in the forum under the LazyRelay app's name, not the customer's own name.",
        "A post counts as live only when it is read back from Whop with the same text as a top-level forum post. If the LazyRelay app is removed from the community, Whop stops accepting posts and the account needs reconnecting.",
      ],
      sources: [
        "https://docs.whop.com/api-reference/forum-posts/create-forum-post",
        "https://docs.whop.com/api-reference/forum-posts/list-forum-posts",
        "https://docs.whop.com/api-reference/experiences/list-experiences",
        "https://docs.whop.com/developer/api/idempotency",
        "https://docs.whop.com/developer/api/rate-limits",
      ],
    },
    {
      platform: "telegram",
      label: "Telegram",
      text: {
        maxLength: 4096,
        note: "Text messages: 4096 characters. When a photo or video is attached the text becomes a caption of at most 1024 characters (Telegram Bot API).",
      },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: 10 MB jpeg/png photos, 50 MB mp4 video (Telegram Bot API cloud limits).
        image: { supported: true, formats: ["jpeg", "png"], maxSizeMb: 10 * MB },
        video: { supported: true, formats: ["mp4"], maxSizeMb: 50 * MB, maxDurationSec: null },
        multiItem: multiItem("telegram"),
        notes: "One photo or one video per post. The 50 MB video ceiling is Telegram's own on the standard Bot API.",
      },
      required: [...BASE_REQUIRED],
      features: ["channel or group posting via the customer's own bot"],
      options: [],
      limits: noRepoCap("LazyRelay enforces no cap. Telegram's own limits are not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: ["Each customer connects their own bot token; the bot must be able to post in the target chat."],
      sources: ["https://core.telegram.org/bots/api"],
    },
    {
      platform: "discord",
      label: "Discord",
      text: { maxLength: 2000, note: "Message content: 2000 characters (Discord webhook docs)." },
      media: {
        textOnlyAllowed: true,
        // mediaLimits.ts: 20 MB for images and video. Real limit depends on the destination server's boost tier, so 20 MB is the universal floor.
        image: { supported: true, formats: ["jpeg", "png", "gif", "webp"], maxSizeMb: 20 * MB },
        video: { supported: true, formats: ["mp4", "webm", "mov"], maxSizeMb: 20 * MB, maxDurationSec: null },
        multiItem: multiItem("discord"),
        notes: "The upload limit depends on the destination server's boost tier. 20 MB is the floor every server supports, and what LazyRelay enforces.",
      },
      required: [...BASE_REQUIRED],
      features: ["posting through a channel webhook"],
      options: [],
      limits: noRepoCap("LazyRelay enforces no cap. Discord's webhook rate limits are not verified."),
      lookups: ["list_connected_accounts", "get_next_free_slot"],
      notes: ["Posts go to the channel behind the connected webhook URL."],
      sources: ["https://docs.discord.com/developers/resources/webhook"],
    },
  ];
  // The repo cap (if any) always wins over what was typed above.
  return rules.map((r) => ({ ...r, limits: { ...r.limits, rollingPostsPer24h: getRolling24hPostLimit(r.platform) } }));
}

/** All platforms when `platform` is omitted, one entry when given, an empty list for an unknown platform. */
export function getPlatformRules(platform?: string): PlatformRuleSet[] {
  const all = buildRules();
  if (platform === undefined) return all;
  const wanted = platform.trim().toLowerCase();
  return all.filter((p) => p.platform === wanted);
}
