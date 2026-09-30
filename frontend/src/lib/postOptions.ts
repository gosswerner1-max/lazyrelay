// Platform-specific post options (backend 0106, rules mirror backend/src/postOptions.ts):
// TikTok's AI label, YouTube visibility / made-for-kids / tags, Instagram and Facebook
// Stories, Instagram trial reels, thread chains, LinkedIn PDF documents. The composer keeps
// one PostOptions object; each post sends only the key its own platform reads.

export interface PostOptions {
  tiktok?: { aiGenerated?: boolean };
  youtube?: { title?: string; privacy?: "public" | "unlisted" | "private"; madeForKids?: boolean; tags?: string[]; aiGenerated?: boolean };
  instagram?: { placement?: "feed" | "reel" | "story"; trialReel?: boolean; trialGraduation?: "manual" | "auto" };
  facebook?: { placement?: "feed" | "story" };
  linkedin?: { documentUrl?: string; documentTitle?: string };
  wordpress?: { title?: string; status?: "publish" | "draft"; categories?: string[]; tags?: string[] };
  devto?: { title?: string; published?: boolean; tags?: string[]; series?: string; canonicalUrl?: string };
  hashnode?: { title?: string; subtitle?: string; tags?: string[]; canonicalUrl?: string; draft?: boolean };
  lemmy?: { community?: string; title?: string; url?: string; nsfw?: boolean };
  chain?: string[];
}

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

export const CHAIN_ITEM_MAX_LENGTH: Record<string, number> = { threads: 500, bluesky: 300, mastodon: 500, x: 280 };
export const MAX_CHAIN_ITEMS = 10;

const LABELS: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", threads: "Threads", bluesky: "Bluesky", mastodon: "Mastodon", x: "X", wordpress: "WordPress", devto: "dev.to", hashnode: "Hashnode", lemmy: "Lemmy" };
export const platformLabel = (p: string) => LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

export interface OptionGroups {
  tiktok: boolean;
  youtube: boolean;
  instagram: boolean;
  facebook: boolean;
  linkedin: boolean;
  wordpress: boolean;
  devto: boolean;
  hashnode: boolean;
  lemmy: boolean;
  /** Platforms selected that can post a thread, in order. */
  chainPlatforms: string[];
}

/** Which option groups the composer should show for the platforms selected right now. */
export function optionGroupsFor(platforms: Array<string | undefined>): OptionGroups {
  const chosen = [...new Set(platforms.filter((p): p is string => !!p))];
  return {
    tiktok: chosen.includes("tiktok"),
    youtube: chosen.includes("youtube"),
    instagram: chosen.includes("instagram"),
    facebook: chosen.includes("facebook"),
    linkedin: chosen.includes("linkedin"),
    wordpress: chosen.includes("wordpress"),
    devto: chosen.includes("devto"),
    hashnode: chosen.includes("hashnode"),
    lemmy: chosen.includes("lemmy"),
    chainPlatforms: chosen.filter((p) => OPTION_KEY_FOR_PLATFORM[p] === "chain"),
  };
}

/** The shortest follow-up limit among the selected thread platforms (so one text fits them all). */
export function chainLimitFor(chainPlatforms: string[]): number {
  return chainPlatforms.length === 0 ? 0 : Math.min(...chainPlatforms.map((p) => CHAIN_ITEM_MAX_LENGTH[p]));
}

const isEmptyValue = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isEmptyValue));

/** Drops empty settings so nothing meaningless is stored or sent. */
export function cleanOptions(o: PostOptions): PostOptions {
  const out: Record<string, unknown> = {};
  for (const [group, value] of Object.entries(o)) {
    if (Array.isArray(value)) {
      const items = value.map((t) => String(t).trim()).filter(Boolean);
      if (items.length > 0) out[group] = items;
    } else if (value && typeof value === "object") {
      const inner: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        // madeForKids and published: false are real answers ("not for kids", "save as a draft"), unlike the other switches.
        if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "" && (v !== false || k === "madeForKids" || k === "published")) inner[k] = v;
      }
      if (!isEmptyValue(inner)) out[group] = inner;
    }
  }
  return out as PostOptions;
}

/** The `options` request field for ONE post: only the key its platform reads, or nothing. */
export function optionsFieldFor(platform: string | undefined, all: PostOptions): { options?: PostOptions } {
  const key = platform ? OPTION_KEY_FOR_PLATFORM[platform] : undefined;
  if (!key) return {};
  const cleaned = cleanOptions({ [key]: all[key] } as PostOptions);
  return cleaned[key] === undefined ? {} : { options: cleaned };
}

/** A draft keeps every group; they are split per platform when it is scheduled. */
export function optionsFieldForDraft(all: PostOptions): { options: PostOptions } {
  return { options: cleanOptions(all) };
}

/** Parses the comma-separated YouTube tags box. */
export function parseTagList(text: string): string[] {
  return [...new Set(text.split(",").map((t) => t.trim().replace(/^#+/, "")).filter(Boolean))];
}

/** Short lines for the posts list. `chainResult` is what the scheduler recorded after the main post. */
export function describeOptions(
  o: PostOptions | null | undefined,
  chainResult?: { posted: number | null; error: string | null } | null,
): string[] {
  const out: string[] = [];
  if (!o) return out;
  if (o.tiktok?.aiGenerated) out.push("Labelled as AI-generated");
  if (o.youtube) {
    const y = o.youtube;
    if (y.privacy && y.privacy !== "public") out.push(`YouTube: ${y.privacy}`);
    if (y.madeForKids !== undefined) out.push(y.madeForKids ? "Made for kids" : "Not made for kids");
    if (y.aiGenerated) out.push("Labelled as AI-generated");
  }
  if (o.instagram?.placement === "story") out.push("Instagram Story");
  if (o.instagram?.placement === "reel" && !o.instagram.trialReel) out.push("Instagram Reel");
  if (o.instagram?.trialReel) out.push(`Trial reel (${o.instagram.trialGraduation === "auto" ? "graduates automatically" : "you graduate it"})`);
  if (o.facebook?.placement === "story") out.push("Facebook Story");
  if (o.linkedin?.documentUrl) out.push(`PDF document${o.linkedin.documentTitle ? `: ${o.linkedin.documentTitle}` : ""}`);
  if (o.wordpress?.status === "draft") out.push("WordPress: saved as a draft");
  if (o.devto?.published === false) out.push("dev.to: saved as a draft");
  if (o.hashnode?.draft) out.push("Hashnode: saved as a draft");
  if (o.lemmy?.community) out.push(`Lemmy: ${o.lemmy.community}`);
  if (o.chain && o.chain.length > 0) {
    const total = o.chain.length;
    if (chainResult && chainResult.posted !== null && chainResult.posted !== undefined) {
      out.push(chainResult.error ? `Thread: ${chainResult.posted} of ${total} follow-ups posted (${chainResult.error})` : `Thread: ${chainResult.posted + 1} posts`);
    } else {
      out.push(`Thread: ${total + 1} posts`);
    }
  }
  return out;
}
