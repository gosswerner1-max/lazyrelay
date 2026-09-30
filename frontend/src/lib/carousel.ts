// Instagram carousels (backend 0104): the main image plus up to 9 more.

export const MAX_EXTRA_IMAGES = 9;

const isVideo = (url: string) => /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);

/** Whether the composer should offer "add more images": an Instagram account is selected and the main media is an image. */
export function canShowCarousel(platforms: Array<string | undefined>, mediaUrl: string | null): boolean {
  return !!mediaUrl && !isVideo(mediaUrl) && platforms.includes("instagram");
}

/** The request field for one post: only Instagram posts carry the extra images. */
export function carouselFields(platform: string | undefined, extra: string[]): { mediaUrls?: string[] } {
  return platform === "instagram" && extra.length > 0 ? { mediaUrls: extra } : {};
}
