// Multi-image posts (master list #19). A post's main media (mediaUrl) plus extra
// media (mediaUrls), up to each platform's own limit in total. Instagram and
// Threads allow videos among the slides; every other platform is images only.

export interface MultiMediaRule {
  /** Most items in total, including the main one. */
  max: number;
  /** Whether videos may be among them. */
  videos: boolean;
}

export const MULTI_MEDIA_RULES: Record<string, MultiMediaRule> = {
  instagram: { max: 10, videos: true },
  threads: { max: 10, videos: true },
  facebook: { max: 10, videos: false },
  tumblr: { max: 10, videos: false },
  linkedin: { max: 9, videos: false },
  bluesky: { max: 4, videos: false },
  mastodon: { max: 4, videos: false },
  x: { max: 4, videos: false },
};

export const CAROUSEL_PLATFORMS = Object.keys(MULTI_MEDIA_RULES);
/** Largest number of EXTRA items any platform takes (the frontend's overall cap). */
export const MAX_EXTRA_CAROUSEL_IMAGES = 9;

export function isVideoFile(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

/** Checks the shape of a multi-media request. URL safety and file rules are checked separately (they need DNS and the database). */
export function normalizeCarousel(
  mediaUrl: unknown,
  mediaUrls: unknown,
  platform: string,
): { ok: true; urls: string[] } | { ok: false; error: string } {
  if (mediaUrls === undefined || mediaUrls === null) return { ok: true, urls: [] };
  if (!Array.isArray(mediaUrls) || mediaUrls.some((u) => typeof u !== "string" || u.trim() === "")) {
    return { ok: false, error: "mediaUrls must be a list of file addresses" };
  }
  if (mediaUrls.length === 0) return { ok: true, urls: [] };
  const rule = MULTI_MEDIA_RULES[platform];
  if (!rule) {
    return { ok: false, error: "This platform does not take several images in one post" };
  }
  if (typeof mediaUrl !== "string" || mediaUrl === "") {
    return { ok: false, error: "A post with several images needs a main image (mediaUrl) as well as mediaUrls" };
  }
  if (mediaUrls.length + 1 > rule.max) {
    return { ok: false, error: `This platform allows up to ${rule.max} images in one post` };
  }
  const urls = (mediaUrls as string[]).map((u) => u.trim());
  if (!rule.videos && (isVideoFile(mediaUrl) || urls.some(isVideoFile))) {
    return { ok: false, error: "This platform only takes images in a multi-image post, not videos" };
  }
  return { ok: true, urls };
}
