// Post tags (master list #16): short labels a customer puts on a post so
// analytics can be filtered by campaign.

export const MAX_TAGS_PER_POST = 5;
export const MAX_TAG_LENGTH = 30;

/** Cleans a tag list: trims, drops a leading #, lowercases, collapses spaces, removes blanks and repeats. */
export function normalizeTags(input: unknown): { ok: true; tags: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, tags: [] };
  if (!Array.isArray(input) || input.some((t) => typeof t !== "string")) {
    return { ok: false, error: "tags must be a list of text labels" };
  }
  const seen = new Set<string>();
  for (const raw of input as string[]) {
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) return { ok: false, error: `Each tag must be ${MAX_TAG_LENGTH} characters or fewer` };
    seen.add(tag);
  }
  if (seen.size > MAX_TAGS_PER_POST) return { ok: false, error: `A post can have up to ${MAX_TAGS_PER_POST} tags` };
  return { ok: true, tags: [...seen] };
}
