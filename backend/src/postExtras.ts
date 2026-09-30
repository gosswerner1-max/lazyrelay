// The optional extras a post can carry beyond its text and main media: tags,
// extra images (multi-image / carousel) and a self-reply at N likes. One place
// checks them, so a new post, a promoted draft and a duplicate all follow the
// same rules. (Master list #16, #17, #19.)

import { supabase } from "./supabase.js";
import { isSafeMediaUrl } from "./urlSafety.js";
import { validateMediaForPlatform, type Platform } from "./mediaLimits.js";
import { normalizeTags } from "./postTags.js";
import { normalizeCarousel, MAX_EXTRA_CAROUSEL_IMAGES } from "./carousel.js";
import { normalizeSelfReply, MAX_SELF_REPLY_LENGTH, MAX_SELF_REPLY_LIKES } from "./selfReply.js";
import { normalizePostOptions, normalizeStoredOptions, optionsForPlatform, type PostOptions } from "./postOptions.js";

export interface PostExtrasInput {
  tags?: unknown;
  mediaUrls?: unknown;
  selfReplyText?: unknown;
  selfReplyAtLikes?: unknown;
  options?: unknown;
}

export interface PostExtras {
  tags: string[];
  mediaUrls: string[];
  selfReplyText: string | null;
  selfReplyAtLikes: number | null;
  options: PostOptions;
}

type Failure = { status: number; body: { error: string } };

/** Full check for a post that is about to be scheduled on a known platform. */
export async function resolvePostExtras(
  input: PostExtrasInput,
  platform: string,
  mediaUrl: string | null,
): Promise<{ ok: true; extras: PostExtras } | { ok: false; failure: Failure }> {
  const fail = (error: string): { ok: false; failure: Failure } => ({ ok: false, failure: { status: 400, body: { error } } });

  const tags = normalizeTags(input.tags);
  if (!tags.ok) return fail(tags.error);

  const carousel = normalizeCarousel(mediaUrl, input.mediaUrls, platform);
  if (!carousel.ok) return fail(carousel.error);
  for (const extra of carousel.urls) {
    const safe = await isSafeMediaUrl(extra);
    if (!safe.safe) return fail(`mediaUrls ${safe.reason}`);
    // Same file rules as the main media (size, format, shape for this platform).
    const { data: media } = await supabase.from("media_uploads").select("mime_type, size_bytes, width, height").eq("url", extra).maybeSingle();
    if (media) {
      const check = validateMediaForPlatform(platform as Platform, {
        mimeType: media.mime_type,
        sizeBytes: media.size_bytes,
        width: media.width,
        height: media.height,
      });
      if (!check.valid) return fail(check.reason ?? "One of the extra files does not meet this platform's requirements");
    }
  }

  const selfReply = normalizeSelfReply(input.selfReplyText, input.selfReplyAtLikes, platform);
  if (!selfReply.ok) return fail(selfReply.error);

  const options = normalizePostOptions(input.options, platform, { mediaUrl, mediaUrls: carousel.urls });
  if (!options.ok) return fail(options.error);
  const docUrl = options.options.linkedin?.documentUrl;
  if (docUrl) {
    const safe = await isSafeMediaUrl(docUrl);
    if (!safe.safe) return fail(`The document address ${safe.reason}`);
  }

  return {
    ok: true,
    extras: {
      tags: tags.tags,
      mediaUrls: carousel.urls,
      selfReplyText: selfReply.value?.text ?? null,
      selfReplyAtLikes: selfReply.value?.atLikes ?? null,
      options: options.options,
    },
  };
}

/**
 * Shape-only check for a DRAFT, which has no platform yet. The full platform rules run
 * when the draft is scheduled. Returns the values to store (null/empty when not given).
 */
export async function normalizeDraftExtras(
  input: PostExtrasInput,
): Promise<{ ok: true; extras: PostExtras } | { ok: false; failure: Failure }> {
  const fail = (error: string): { ok: false; failure: Failure } => ({ ok: false, failure: { status: 400, body: { error } } });

  const tags = normalizeTags(input.tags);
  if (!tags.ok) return fail(tags.error);

  let mediaUrls: string[] = [];
  if (input.mediaUrls !== undefined && input.mediaUrls !== null) {
    if (!Array.isArray(input.mediaUrls) || input.mediaUrls.some((u) => typeof u !== "string" || u.trim() === "")) {
      return fail("mediaUrls must be a list of file addresses");
    }
    if (input.mediaUrls.length > MAX_EXTRA_CAROUSEL_IMAGES) return fail(`A post can have up to ${MAX_EXTRA_CAROUSEL_IMAGES + 1} images`);
    mediaUrls = (input.mediaUrls as string[]).map((u) => u.trim());
    for (const u of mediaUrls) {
      const safe = await isSafeMediaUrl(u);
      if (!safe.safe) return fail(`mediaUrls ${safe.reason}`);
    }
  }

  const text = typeof input.selfReplyText === "string" ? input.selfReplyText.trim() : "";
  const likesRaw = input.selfReplyAtLikes;
  const hasLikes = likesRaw !== undefined && likesRaw !== null && likesRaw !== "";
  let selfReplyText: string | null = null;
  let selfReplyAtLikes: number | null = null;
  if (text || hasLikes) {
    const n = Number(likesRaw);
    if (!text || !hasLikes) return fail("A self-reply needs both selfReplyText and selfReplyAtLikes");
    if (!Number.isInteger(n) || n < 1 || n > MAX_SELF_REPLY_LIKES) return fail(`selfReplyAtLikes must be a whole number from 1 to ${MAX_SELF_REPLY_LIKES}`);
    if (text.length > MAX_SELF_REPLY_LENGTH) return fail(`selfReplyText must be ${MAX_SELF_REPLY_LENGTH} characters or fewer`);
    selfReplyText = text;
    selfReplyAtLikes = n;
  }
  const options = normalizeStoredOptions(input.options);
  if (!options.ok) return fail(options.error);
  return { ok: true, extras: { tags: tags.tags, mediaUrls, selfReplyText, selfReplyAtLikes, options: options.options } };
}

/** Database column values for a post row. */
export function extrasToColumns(e: PostExtras) {
  return { tags: e.tags, media_urls: e.mediaUrls, self_reply_text: e.selfReplyText, self_reply_at_likes: e.selfReplyAtLikes, options: e.options };
}

/**
 * For a RECURRING schedule that targets several platforms: the extras that apply to
 * ONE target platform. A schedule can list tags, extra images and a self-reply once;
 * each platform gets what it supports (tags always; extra images only where the
 * platform takes that many; a self-reply only on Facebook and Instagram) and quietly
 * leaves out the rest, so one schedule can cover platforms with different abilities.
 */
export function extrasForPlatform(
  slot: { tags?: string[] | null; media_urls?: string[] | null; self_reply_text?: string | null; self_reply_at_likes?: number | null; options?: PostOptions | null },
  platform: string,
  mediaUrl: string | null,
) {
  const carousel = normalizeCarousel(mediaUrl, slot.media_urls ?? [], platform);
  const selfReply = normalizeSelfReply(slot.self_reply_text ?? null, slot.self_reply_at_likes ?? null, platform);
  return {
    tags: slot.tags ?? [],
    media_urls: carousel.ok ? carousel.urls : [],
    self_reply_text: selfReply.ok ? (selfReply.value?.text ?? null) : null,
    self_reply_at_likes: selfReply.ok ? (selfReply.value?.atLikes ?? null) : null,
    options: optionsForPlatform(slot.options, platform, { mediaUrl, mediaUrls: carousel.ok ? carousel.urls : [] }),
  };
}
