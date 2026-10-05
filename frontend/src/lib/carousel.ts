// Multi-image posts (backend 0104, rules mirror backend/src/carousel.ts). A post's
// main media plus extra media, up to each platform's own total. Instagram and
// Threads allow videos among the slides; the rest are images only. A platform not
// listed here (TikTok, Pinterest and so on) gets the main media only.

export interface MultiMediaRule {
  max: number; // total items, main one included
  videos: boolean;
}

export const MULTI_MEDIA_RULES: Record<string, MultiMediaRule> = {
  instagram: { max: 10, videos: true },
  threads: { max: 20, videos: true }, // Threads API docs: 2 to 20 items (checked 2026-10-02; was 10)
  facebook: { max: 10, videos: false },
  tumblr: { max: 10, videos: false },
  linkedin: { max: 9, videos: false },
  bluesky: { max: 4, videos: false },
  mastodon: { max: 4, videos: false },
  x: { max: 4, videos: false },
  wordpress: { max: 10, videos: false },
  devto: { max: 10, videos: false },
  hashnode: { max: 10, videos: false },
  lemmy: { max: 10, videos: false },
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  threads: "Threads",
  facebook: "Facebook",
  tumblr: "Tumblr",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  x: "X",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  youtube: "YouTube",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  wordpress: "WordPress",
  devto: "dev.to",
  hashnode: "Hashnode",
  lemmy: "Lemmy",
  nostr: "Nostr",
  whop: "Whop",
  snapchat: "Snapchat",
  reddit: "Reddit",
};

const label = (p: string) => PLATFORM_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

export function isVideoFile(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

export interface CarouselPlan {
  /** True when at least one selected platform takes several images. */
  available: boolean;
  /** Most EXTRA items that fit every selected platform that takes several. */
  maxExtra: number;
  /** Whether videos may be added (every selected multi-image platform allows them). */
  videosAllowed: boolean;
  /** Selected platforms that will post the main media only. */
  mainOnly: string[];
  /** A short line about the limits, for the composer. */
  note: string;
}

/** What the composer should offer for the platforms selected right now. */
export function carouselPlan(platforms: Array<string | undefined>): CarouselPlan {
  const chosen = [...new Set(platforms.filter((p): p is string => !!p))];
  const multi = chosen.filter((p) => MULTI_MEDIA_RULES[p]);
  const mainOnly = chosen.filter((p) => !MULTI_MEDIA_RULES[p]);
  if (multi.length === 0) return { available: false, maxExtra: 0, videosAllowed: false, mainOnly, note: "" };
  const maxExtra = Math.min(...multi.map((p) => MULTI_MEDIA_RULES[p].max)) - 1;
  const videosAllowed = multi.every((p) => MULTI_MEDIA_RULES[p].videos);
  const limits = multi.map((p) => `${label(p)} ${MULTI_MEDIA_RULES[p].max}`).join(", ");
  const parts = [`Up to ${maxExtra} more (${limits} in total).`, videosAllowed ? "Images or videos." : "Images only."];
  if (mainOnly.length > 0) parts.push(`${mainOnly.map((p) => label(p)).join(", ")} will post the main image only.`);
  return { available: true, maxExtra, videosAllowed, mainOnly, note: parts.join(" ") };
}

/** Whether the composer should offer "add more images" for these selected platforms and this main file. */
export function canShowCarousel(platforms: Array<string | undefined>, mediaUrl: string | null): boolean {
  if (!mediaUrl) return false;
  const plan = carouselPlan(platforms);
  if (!plan.available) return false;
  return plan.videosAllowed || !isVideoFile(mediaUrl);
}

/** The request field for one post: only platforms that take several images carry the extras. */
export function carouselFields(platform: string | undefined, extra: string[]): { mediaUrls?: string[] } {
  return platform && MULTI_MEDIA_RULES[platform] && extra.length > 0 ? { mediaUrls: extra } : {};
}
