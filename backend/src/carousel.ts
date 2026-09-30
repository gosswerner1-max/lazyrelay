// Instagram carousels (master list #19, first version: Instagram, images only).
// A carousel is the post's main image (mediaUrl) plus 1 to 9 more (mediaUrls),
// so 2 to 10 images in all, which is Instagram's own limit.

export const MAX_EXTRA_CAROUSEL_IMAGES = 9;
export const CAROUSEL_PLATFORMS = ["instagram"];

export function isVideoFile(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

/** Checks the shape of a carousel request. URL safety is checked separately (it needs DNS). */
export function normalizeCarousel(
  mediaUrl: unknown,
  mediaUrls: unknown,
  platform: string,
): { ok: true; urls: string[] } | { ok: false; error: string } {
  if (mediaUrls === undefined || mediaUrls === null) return { ok: true, urls: [] };
  if (!Array.isArray(mediaUrls) || mediaUrls.some((u) => typeof u !== "string" || u.trim() === "")) {
    return { ok: false, error: "mediaUrls must be a list of image addresses" };
  }
  if (mediaUrls.length === 0) return { ok: true, urls: [] };
  if (!CAROUSEL_PLATFORMS.includes(platform)) {
    return { ok: false, error: "Posts with several images are only available for Instagram right now" };
  }
  if (typeof mediaUrl !== "string" || mediaUrl === "") {
    return { ok: false, error: "A carousel needs a main image (mediaUrl) as well as mediaUrls" };
  }
  if (mediaUrls.length > MAX_EXTRA_CAROUSEL_IMAGES) {
    return { ok: false, error: `A carousel can have up to ${MAX_EXTRA_CAROUSEL_IMAGES + 1} images in total` };
  }
  const urls = (mediaUrls as string[]).map((u) => u.trim());
  if (isVideoFile(mediaUrl) || urls.some(isVideoFile)) {
    return { ok: false, error: "Carousels can only contain images for now, not videos" };
  }
  return { ok: true, urls };
}
