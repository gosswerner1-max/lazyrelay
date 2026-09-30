// Post tags (backend 0101): up to 5 short labels per post, used to filter analytics.

export const MAX_TAGS_PER_POST = 5;

/** Turns the composer's comma-separated text into a clean tag list (the backend cleans it again). */
export function parseTags(text: string): string[] | undefined {
  const tags = [...new Set(text.split(",").map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase()).filter(Boolean))];
  return tags.length > 0 ? tags : undefined;
}
