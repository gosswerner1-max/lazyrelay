// Platform-specific post options (master list #20). One `options` object per post
// holds the settings only one platform understands: TikTok's AI label, YouTube's
// visibility / made-for-kids / tags, Instagram and Facebook Stories, Instagram trial
// reels, thread chains, LinkedIn PDF documents. Each platform reads ONLY its own
// key, and a key that belongs to another platform is refused with a clear message
// so an API caller finds out instead of being silently ignored.

import { isVideoFile } from "./carousel.js";

export interface PostOptions {
  tiktok?: { aiGenerated?: boolean };
  youtube?: {
    title?: string;
    privacy?: "public" | "unlisted" | "private";
    madeForKids?: boolean;
    tags?: string[];
    aiGenerated?: boolean;
  };
  instagram?: {
    placement?: "feed" | "reel" | "story";
    /** A trial reel is shown to non-followers first. Reels only. */
    trialReel?: boolean;
    /** How a trial reel graduates to followers: by hand, or automatically when it performs well. */
    trialGraduation?: "manual" | "auto";
  };
  facebook?: { placement?: "feed" | "story" };
  linkedin?: { documentUrl?: string; documentTitle?: string };
  /** Article platforms (master list #27). The post text is the body; the title defaults to its first line. */
  wordpress?: { title?: string; status?: "publish" | "draft"; categories?: string[]; tags?: string[] };
  devto?: { title?: string; published?: boolean; tags?: string[]; series?: string; canonicalUrl?: string };
  hashnode?: { title?: string; subtitle?: string; tags?: string[]; canonicalUrl?: string; draft?: boolean };
  /** Lemmy: the community to post in (name or name@instance). Falls back to the community saved when connecting. */
  lemmy?: { community?: string; title?: string; url?: string; nsfw?: boolean };
  /** Follow-up posts that reply to the main post in order (a thread). Threads, Bluesky, Mastodon and X. */
  chain?: string[];
}

/** Which option key each platform reads. A platform not listed takes no options. */
export const OPTION_KEY_FOR_PLATFORM: Record<string, keyof PostOptions> = {
  tiktok: "tiktok",
  youtube: "youtube",
  instagram: "instagram",
  facebook: "facebook",
  linkedin: "linkedin",
  wordpress: "wordpress",
  devto: "devto",
  hashnode: "hashnode",
  lemmy: "lemmy",
  threads: "chain",
  bluesky: "chain",
  mastodon: "chain",
  x: "chain",
};

/** Longest text of one follow-up post, per platform (the platform's own post limit). */
export const CHAIN_ITEM_MAX_LENGTH: Record<string, number> = { threads: 500, bluesky: 300, mastodon: 500, x: 280 };
export const MAX_CHAIN_ITEMS = 10;

const YOUTUBE_PRIVACY = ["public", "unlisted", "private"] as const;
const IG_PLACEMENTS = ["feed", "reel", "story"] as const;
const FB_PLACEMENTS = ["feed", "story"] as const;
const MAX_YOUTUBE_TITLE = 100;
const MAX_YOUTUBE_TAGS = 15;
const MAX_YOUTUBE_TAG_LENGTH = 30;
const MAX_DOCUMENT_TITLE = 100;

type Ok = { ok: true; options: PostOptions };
type Fail = { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface OptionsContext {
  mediaUrl: string | null;
  mediaUrls: string[];
}

/**
 * Checks the options for ONE target platform. Returns just that platform's key,
 * cleaned, or a plain-language reason. `input` may be undefined or empty.
 */
export function normalizePostOptions(input: unknown, platform: string, ctx: OptionsContext): Ok | Fail {
  if (input === undefined || input === null) return { ok: true, options: {} };
  if (!isObject(input)) return { ok: false, error: "options must be an object" };

  const allowedKey = OPTION_KEY_FOR_PLATFORM[platform];
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || input[key] === null) continue;
    if (key !== allowedKey) {
      return { ok: false, error: allowedKey ? `options.${key} is not used by this platform (it takes options.${allowedKey})` : `This platform has no extra post options (options.${key} was sent)` };
    }
  }
  if (!allowedKey || input[allowedKey] === undefined || input[allowedKey] === null) return { ok: true, options: {} };
  const raw = input[allowedKey];

  switch (allowedKey) {
    case "tiktok":
      return checkTikTok(raw);
    case "youtube":
      return checkYouTube(raw);
    case "instagram":
      return checkInstagram(raw, ctx);
    case "facebook":
      return checkFacebook(raw, ctx);
    case "linkedin":
      return checkLinkedIn(raw, ctx);
    case "wordpress":
      return checkWordPress(raw);
    case "devto":
      return checkDevTo(raw);
    case "hashnode":
      return checkHashnode(raw);
    case "lemmy":
      return checkLemmy(raw);
    case "chain":
      return checkChain(raw, platform);
  }
  return { ok: true, options: {} };
}

function checkTikTok(raw: unknown): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.tiktok must be an object" };
  if (raw.aiGenerated !== undefined && typeof raw.aiGenerated !== "boolean") return { ok: false, error: "options.tiktok.aiGenerated must be true or false" };
  return { ok: true, options: raw.aiGenerated === undefined ? {} : { tiktok: { aiGenerated: raw.aiGenerated } } };
}

function checkYouTube(raw: unknown): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.youtube must be an object" };
  const out: NonNullable<PostOptions["youtube"]> = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string") return { ok: false, error: "options.youtube.title must be text" };
    const title = raw.title.trim();
    if (title.length > MAX_YOUTUBE_TITLE) return { ok: false, error: `The YouTube title must be ${MAX_YOUTUBE_TITLE} characters or fewer` };
    if (title) out.title = title;
  }
  if (raw.privacy !== undefined) {
    if (!(YOUTUBE_PRIVACY as readonly unknown[]).includes(raw.privacy)) return { ok: false, error: "options.youtube.privacy must be public, unlisted or private" };
    out.privacy = raw.privacy as "public" | "unlisted" | "private";
  }
  for (const flag of ["madeForKids", "aiGenerated"] as const) {
    if (raw[flag] !== undefined) {
      if (typeof raw[flag] !== "boolean") return { ok: false, error: `options.youtube.${flag} must be true or false` };
      out[flag] = raw[flag] as boolean;
    }
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string")) return { ok: false, error: "options.youtube.tags must be a list of text tags" };
    const tags = [...new Set((raw.tags as string[]).map((t) => t.trim().replace(/^#+/, "")).filter(Boolean))];
    if (tags.length > MAX_YOUTUBE_TAGS) return { ok: false, error: `A YouTube video can have up to ${MAX_YOUTUBE_TAGS} tags` };
    if (tags.some((t) => t.length > MAX_YOUTUBE_TAG_LENGTH)) return { ok: false, error: `Each YouTube tag must be ${MAX_YOUTUBE_TAG_LENGTH} characters or fewer` };
    if (tags.length > 0) out.tags = tags;
  }
  return { ok: true, options: Object.keys(out).length > 0 ? { youtube: out } : {} };
}

function checkInstagram(raw: unknown, ctx: OptionsContext): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.instagram must be an object" };
  const out: NonNullable<PostOptions["instagram"]> = {};
  if (raw.placement !== undefined) {
    if (!(IG_PLACEMENTS as readonly unknown[]).includes(raw.placement)) return { ok: false, error: "options.instagram.placement must be feed, reel or story" };
    out.placement = raw.placement as "feed" | "reel" | "story";
  }
  if (raw.trialReel !== undefined) {
    if (typeof raw.trialReel !== "boolean") return { ok: false, error: "options.instagram.trialReel must be true or false" };
    out.trialReel = raw.trialReel;
  }
  if (raw.trialGraduation !== undefined) {
    if (raw.trialGraduation !== "manual" && raw.trialGraduation !== "auto") return { ok: false, error: "options.instagram.trialGraduation must be manual or auto" };
    out.trialGraduation = raw.trialGraduation;
  }
  const isVideo = !!ctx.mediaUrl && isVideoFile(ctx.mediaUrl);
  if (out.placement === "story") {
    if (!ctx.mediaUrl) return { ok: false, error: "An Instagram Story needs an image or a video" };
    if (ctx.mediaUrls.length > 0) return { ok: false, error: "An Instagram Story is one image or video, not several" };
  }
  if (out.placement === "reel" && !isVideo) return { ok: false, error: "An Instagram Reel needs a video" };
  if (out.placement === "feed" && ctx.mediaUrls.length === 0 && isVideo) return { ok: false, error: "A single video posts to Instagram as a Reel or a Story, not the feed. Choose Reel or Story." };
  if (out.trialReel) {
    if (out.placement === "story" || out.placement === "feed") return { ok: false, error: "A trial reel must be a Reel" };
    if (!isVideo || ctx.mediaUrls.length > 0) return { ok: false, error: "A trial reel needs a single video" };
  }
  if (out.trialGraduation && !out.trialReel) return { ok: false, error: "trialGraduation only applies to a trial reel" };
  return { ok: true, options: Object.keys(out).length > 0 ? { instagram: out } : {} };
}

function checkFacebook(raw: unknown, ctx: OptionsContext): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.facebook must be an object" };
  if (raw.placement === undefined) return { ok: true, options: {} };
  if (!(FB_PLACEMENTS as readonly unknown[]).includes(raw.placement)) return { ok: false, error: "options.facebook.placement must be feed or story" };
  if (raw.placement === "story") {
    if (!ctx.mediaUrl) return { ok: false, error: "A Facebook Story needs an image or a video" };
    if (ctx.mediaUrls.length > 0) return { ok: false, error: "A Facebook Story is one image or video, not several" };
  }
  return { ok: true, options: { facebook: { placement: raw.placement as "feed" | "story" } } };
}

function checkLinkedIn(raw: unknown, ctx: OptionsContext): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.linkedin must be an object" };
  const out: NonNullable<PostOptions["linkedin"]> = {};
  if (raw.documentUrl !== undefined) {
    if (typeof raw.documentUrl !== "string" || !/^https:\/\/\S+\.pdf(\?\S*)?$/i.test(raw.documentUrl.trim())) {
      return { ok: false, error: "options.linkedin.documentUrl must be an https address of a PDF file" };
    }
    out.documentUrl = raw.documentUrl.trim();
  }
  if (raw.documentTitle !== undefined) {
    if (typeof raw.documentTitle !== "string") return { ok: false, error: "options.linkedin.documentTitle must be text" };
    const t = raw.documentTitle.trim();
    if (t.length > MAX_DOCUMENT_TITLE) return { ok: false, error: `The document title must be ${MAX_DOCUMENT_TITLE} characters or fewer` };
    if (t) out.documentTitle = t;
  }
  if (out.documentTitle && !out.documentUrl) return { ok: false, error: "A document title needs a document" };
  if (out.documentUrl && (ctx.mediaUrl || ctx.mediaUrls.length > 0)) return { ok: false, error: "A LinkedIn post can carry a PDF document or images, not both" };
  return { ok: true, options: Object.keys(out).length > 0 ? { linkedin: out } : {} };
}

const MAX_ARTICLE_TITLE = 250;
const MAX_LEMMY_TITLE = 200;
const MAX_DEVTO_TAGS = 4;
const MAX_ARTICLE_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_SERIES_LENGTH = 100;
const MAX_COMMUNITY_LENGTH = 200;

/** Optional text field: returns the trimmed text (undefined when empty), or a plain-language error. */
function textField(raw: Record<string, unknown>, group: string, name: string, max: number): { value?: string } | Fail {
  if (raw[name] === undefined) return {};
  if (typeof raw[name] !== "string") return { ok: false, error: `options.${group}.${name} must be text` };
  const v = (raw[name] as string).trim();
  if (v.length > max) return { ok: false, error: `options.${group}.${name} must be ${max} characters or fewer` };
  return v ? { value: v } : {};
}

function flagField(raw: Record<string, unknown>, group: string, name: string): { value?: boolean } | Fail {
  if (raw[name] === undefined) return {};
  if (typeof raw[name] !== "boolean") return { ok: false, error: `options.${group}.${name} must be true or false` };
  return { value: raw[name] as boolean };
}

/** Optional list of short tags: trimmed, leading # removed, duplicates dropped. */
function tagsField(raw: Record<string, unknown>, group: string, name: string, maxCount: number): { value?: string[] } | Fail {
  if (raw[name] === undefined) return {};
  if (!Array.isArray(raw[name]) || (raw[name] as unknown[]).some((t) => typeof t !== "string")) return { ok: false, error: `options.${group}.${name} must be a list of text values` };
  const items = [...new Set((raw[name] as string[]).map((t) => t.trim().replace(/^#+/, "")).filter(Boolean))];
  if (items.length > maxCount) return { ok: false, error: `options.${group}.${name} can have up to ${maxCount} entries on this platform` };
  if (items.some((t) => t.length > MAX_TAG_LENGTH)) return { ok: false, error: `Each entry in options.${group}.${name} must be ${MAX_TAG_LENGTH} characters or fewer` };
  return items.length > 0 ? { value: items } : {};
}

const isFail = (v: unknown): v is Fail => typeof v === "object" && v !== null && (v as Fail).ok === false;

function checkHttpsUrl(raw: Record<string, unknown>, group: string, name: string): { value?: string } | Fail {
  const t = textField(raw, group, name, 2000);
  if (isFail(t)) return t;
  if (t.value && !/^https:\/\/\S+$/i.test(t.value)) return { ok: false, error: `options.${group}.${name} must be an https address` };
  return t;
}

function checkWordPress(raw: unknown): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.wordpress must be an object" };
  const out: NonNullable<PostOptions["wordpress"]> = {};
  const title = textField(raw, "wordpress", "title", MAX_ARTICLE_TITLE);
  if (isFail(title)) return title;
  if (title.value) out.title = title.value;
  if (raw.status !== undefined) {
    if (raw.status !== "publish" && raw.status !== "draft") return { ok: false, error: "options.wordpress.status must be publish or draft" };
    out.status = raw.status;
  }
  for (const name of ["categories", "tags"] as const) {
    const list = tagsField(raw, "wordpress", name, MAX_ARTICLE_TAGS);
    if (isFail(list)) return list;
    if (list.value) out[name] = list.value;
  }
  return { ok: true, options: Object.keys(out).length > 0 ? { wordpress: out } : {} };
}

function checkDevTo(raw: unknown): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.devto must be an object" };
  const out: NonNullable<PostOptions["devto"]> = {};
  const title = textField(raw, "devto", "title", MAX_ARTICLE_TITLE);
  if (isFail(title)) return title;
  if (title.value) out.title = title.value;
  const published = flagField(raw, "devto", "published");
  if (isFail(published)) return published;
  if (published.value !== undefined) out.published = published.value;
  const tags = tagsField(raw, "devto", "tags", MAX_DEVTO_TAGS);
  if (isFail(tags)) return tags;
  if (tags.value) out.tags = tags.value;
  const series = textField(raw, "devto", "series", MAX_SERIES_LENGTH);
  if (isFail(series)) return series;
  if (series.value) out.series = series.value;
  const canonical = checkHttpsUrl(raw, "devto", "canonicalUrl");
  if (isFail(canonical)) return canonical;
  if (canonical.value) out.canonicalUrl = canonical.value;
  return { ok: true, options: Object.keys(out).length > 0 ? { devto: out } : {} };
}

function checkHashnode(raw: unknown): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.hashnode must be an object" };
  const out: NonNullable<PostOptions["hashnode"]> = {};
  const title = textField(raw, "hashnode", "title", MAX_ARTICLE_TITLE);
  if (isFail(title)) return title;
  if (title.value) out.title = title.value;
  const subtitle = textField(raw, "hashnode", "subtitle", 250);
  if (isFail(subtitle)) return subtitle;
  if (subtitle.value) out.subtitle = subtitle.value;
  const tags = tagsField(raw, "hashnode", "tags", 5);
  if (isFail(tags)) return tags;
  if (tags.value) out.tags = tags.value;
  const canonical = checkHttpsUrl(raw, "hashnode", "canonicalUrl");
  if (isFail(canonical)) return canonical;
  if (canonical.value) out.canonicalUrl = canonical.value;
  const draft = flagField(raw, "hashnode", "draft");
  if (isFail(draft)) return draft;
  if (draft.value !== undefined) out.draft = draft.value;
  return { ok: true, options: Object.keys(out).length > 0 ? { hashnode: out } : {} };
}

function checkLemmy(raw: unknown): Ok | Fail {
  if (!isObject(raw)) return { ok: false, error: "options.lemmy must be an object" };
  const out: NonNullable<PostOptions["lemmy"]> = {};
  const community = textField(raw, "lemmy", "community", MAX_COMMUNITY_LENGTH);
  if (isFail(community)) return community;
  if (community.value) {
    const c = community.value.replace(/^!/, "");
    if (!/^[A-Za-z0-9_]+(@[A-Za-z0-9.-]+)?$/.test(c)) return { ok: false, error: "options.lemmy.community must look like name or name@instance.example" };
    out.community = c;
  }
  const title = textField(raw, "lemmy", "title", MAX_LEMMY_TITLE);
  if (isFail(title)) return title;
  if (title.value) out.title = title.value;
  const url = checkHttpsUrl(raw, "lemmy", "url");
  if (isFail(url)) return url;
  if (url.value) out.url = url.value;
  const nsfw = flagField(raw, "lemmy", "nsfw");
  if (isFail(nsfw)) return nsfw;
  if (nsfw.value !== undefined) out.nsfw = nsfw.value;
  return { ok: true, options: Object.keys(out).length > 0 ? { lemmy: out } : {} };
}

function checkChain(raw: unknown, platform: string): Ok | Fail {
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) return { ok: false, error: "options.chain must be a list of follow-up texts" };
  const items = (raw as string[]).map((t) => t.trim());
  if (items.some((t) => t === "")) return { ok: false, error: "A follow-up post in the thread cannot be empty" };
  if (items.length === 0) return { ok: true, options: {} };
  if (items.length > MAX_CHAIN_ITEMS) return { ok: false, error: `A thread can have up to ${MAX_CHAIN_ITEMS} follow-up posts` };
  const max = CHAIN_ITEM_MAX_LENGTH[platform];
  if (items.some((t) => t.length > max)) return { ok: false, error: `Each follow-up post must be ${max} characters or fewer on this platform` };
  return { ok: true, options: { chain: items } };
}

/**
 * Shape-only check for a DRAFT or a recurring schedule, which has no single platform yet
 * (or several): keeps each platform's key that is well formed and drops nothing. The
 * platform's own rules run when the post is scheduled or generated.
 */
export function normalizeStoredOptions(input: unknown): Ok | Fail {
  if (input === undefined || input === null) return { ok: true, options: {} };
  if (!isObject(input)) return { ok: false, error: "options must be an object" };
  const out: PostOptions = {};
  const known = new Set<string>(Object.values(OPTION_KEY_FOR_PLATFORM));
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || input[key] === null) continue;
    if (!known.has(key)) return { ok: false, error: `Unknown option group options.${key}` };
    // Reuse the per-platform check with a platform that reads this key and no media context.
    const platform = Object.entries(OPTION_KEY_FOR_PLATFORM).find(([, k]) => k === key)![0];
    const checked = normalizePostOptions({ [key]: input[key] }, platform, { mediaUrl: null, mediaUrls: [] });
    // Media-dependent rules cannot be judged without a post; only shape problems count here.
    if (!checked.ok && !isMediaDependent(checked.error)) return checked;
    Object.assign(out, checked.ok ? checked.options : shapeOnly(key, input[key]));
  }
  return { ok: true, options: out };
}

function isMediaDependent(message: string): boolean {
  return /needs an image or a video|needs a video|needs a single video|as a Reel or a Story|not both/.test(message);
}

function shapeOnly(key: string, value: unknown): PostOptions {
  return { [key]: value } as PostOptions;
}

/** For a RECURRING schedule fanned out to one platform: just that platform's options, or nothing if they do not fit. */
export function optionsForPlatform(stored: PostOptions | null | undefined, platform: string, ctx: OptionsContext): PostOptions {
  if (!stored) return {};
  const key = OPTION_KEY_FOR_PLATFORM[platform];
  if (!key || stored[key] === undefined) return {};
  const checked = normalizePostOptions({ [key]: stored[key] }, platform, ctx);
  return checked.ok ? checked.options : {};
}
