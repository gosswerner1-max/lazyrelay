// GET /mentions: which posts to look at.
//
// The route used to take the newest 15 posted posts of every platform and let
// the dashboard hide the platforms it does not show yet. A customer whose newest
// 15 posts were all Facebook or Instagram therefore saw no dev.to, Hashnode,
// Mastodon, Bluesky or YouTube comments at all. When the caller names the
// platforms it wants, the filter now runs inside the database query, so the
// limit of 15 is applied to those platforms only. Without a platform list the
// behaviour is exactly as before (newest 15 across everything), which is what the
// public API, the MCP tool, the SDK and the Zapier trigger keep getting.

import type { SupabaseClient } from "@supabase/supabase-js";

export const MENTIONS_POST_LIMIT = 15;
// How many recent posts of the other platforms are counted for the dashboard's
// "Coming soon" rows. Only counted, never read for comments.
export const OTHER_PLATFORMS_SCAN_LIMIT = 200;

const PLATFORM_NAME = /^[a-z0-9_]{1,30}$/;
const MAX_PLATFORMS = 30;

export type PlatformsParam = { ok: true; platforms: string[] | null } | { ok: false };

// ?platforms=devto,hashnode : a comma list of platform ids (a repeated parameter
// also works). Missing or empty means "no filter". Anything that is not a plain
// platform id is refused, because the list is used inside a database filter.
export function parsePlatformsParam(raw: unknown): PlatformsParam {
  if (raw === undefined || raw === null || raw === "") return { ok: true, platforms: null };
  const text = Array.isArray(raw) ? raw.join(",") : raw;
  if (typeof text !== "string") return { ok: false };
  const items = text.split(",").map((p) => p.trim().toLowerCase());
  if (items.length === 0 || items.some((p) => !PLATFORM_NAME.test(p))) return { ok: false };
  const unique = [...new Set(items)];
  if (unique.length > MAX_PLATFORMS) return { ok: false };
  return { ok: true, platforms: unique };
}

type Db = Pick<SupabaseClient, "from">;

export interface MentionPostRow {
  id: string;
  content: string;
  scheduled_for: string;
  social_account_id: string;
  social_accounts: { platform?: string } | { platform?: string }[] | null;
  post_results: { platform_post_id: string | null; platform_post_url: string | null; verified_live: boolean }[] | null;
}

const POST_FIELDS = "id, content, scheduled_for, social_account_id";
const RESULT_FIELDS = "post_results(platform_post_id, platform_post_url, verified_live)";

// The newest MENTIONS_POST_LIMIT posted posts of this account. With a platform
// list, "!inner" makes the platform a real condition on the post (not just extra
// data on it), so the filter and then the limit are both applied by the database.
export async function fetchMentionPosts(db: Db, accountId: string, platforms: string[] | null) {
  const social = platforms ? "social_accounts!inner(platform)" : "social_accounts(platform)";
  let query = db.from("scheduled_posts").select(`${POST_FIELDS}, ${social}, ${RESULT_FIELDS}`);
  if (platforms) query = query.in("social_accounts.platform", platforms);
  const { data, error } = await query
    .eq("account_id", accountId)
    .eq("status", "posted")
    .order("scheduled_for", { ascending: false })
    .limit(MENTIONS_POST_LIMIT);
  return { data: (data ?? null) as unknown as MentionPostRow[] | null, error };
}

export interface OtherPlatformCount {
  platform: string;
  count: number;
}

// Recent posted posts that are live on a platform NOT in the list, counted per
// platform, for the dashboard's "Coming soon" rows. Failing here must never break
// the main answer, so an error gives an empty list.
export async function fetchOtherPlatformCounts(db: Db, accountId: string, platforms: string[]): Promise<OtherPlatformCount[]> {
  try {
    const { data, error } = await db
      .from("scheduled_posts")
      .select("id, social_accounts!inner(platform), post_results!inner(verified_live)")
      .eq("account_id", accountId)
      .eq("status", "posted")
      .eq("post_results.verified_live", true)
      .not("social_accounts.platform", "in", `(${platforms.join(",")})`)
      .order("scheduled_for", { ascending: false })
      .limit(OTHER_PLATFORMS_SCAN_LIMIT);
    if (error) {
      console.error("[mentions] other-platform count failed:", error.message);
      return [];
    }
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as unknown as { social_accounts: { platform?: string } | { platform?: string }[] | null }[]) {
      const sa = Array.isArray(row.social_accounts) ? row.social_accounts[0] : row.social_accounts;
      if (sa?.platform) counts.set(sa.platform, (counts.get(sa.platform) ?? 0) + 1);
    }
    return [...counts.entries()].map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count || a.platform.localeCompare(b.platform));
  } catch (err) {
    console.error("[mentions] other-platform count failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
