import { supabase } from "./supabase.js";
import { PINTEREST_BLOCKED_LINK_MESSAGE } from "./postErrors.js";

// Scheduling-time heads-up for Pinterest pins. Pinterest blocks link domains
// for spam, and a blocked pin only fails later, at post time. If ANY account
// had a blocked-link failure on a host in the last 30 days, a customer
// scheduling a pin that links to that host is told it may fail. It is only a
// warning: the post is never blocked, changed or delayed because of it, and a
// failed lookup means no warning (fail open), never a failed request.
//
// Privacy: the lookup reads other customers' failed posts, but only ever
// returns host names that also appear in the links of the post being
// scheduled. No account ids and no content leave this module.

export const BLOCKED_LINK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
// Enough recent failures to cover a real incident; also keeps the follow-up
// `in (...)` lookups well inside the URL length limit.
const MAX_FAILURES_READ = 100;
const MAX_LINKS_CHECKED = 20;

export interface PostWarning {
  code: "pinterest_link_recently_blocked";
  host: string;
  message: string;
}

export function pinterestLinkWarningMessage(host: string): string {
  return `Pinterest recently blocked links to ${host} on some pins. Your pin may fail. You can still schedule it. If it fails, ask Pinterest to review the website address in Pinterest's Help Center.`;
}

/** Lowercase host names of the http/https links in `text`, www. dropped,
 *  without duplicates. Anything that is not a parseable web link is ignored. */
export function extractLinkHosts(text: string | null | undefined): string[] {
  if (!text) return [];
  const hosts = new Set<string>();
  for (const match of (text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []).slice(0, MAX_LINKS_CHECKED)) {
    try {
      // Trailing sentence punctuation is not part of the address.
      const host = new URL(match.replace(/[.,;:!?]+$/, "")).hostname.toLowerCase().replace(/^www\./, "");
      if (host) hosts.add(host);
    } catch {
      // Not a real link, nothing to check.
    }
  }
  return [...hosts];
}

/** True when `host` is the blocked host itself or a subdomain of it. */
function isSameOrSubdomain(host: string, blocked: string): boolean {
  return host === blocked || host.endsWith(`.${blocked}`);
}

/** Which of `hosts` appear in the links of a Pinterest pin that failed with
 *  the blocked-link message in the last 30 days (any account). Throws on a
 *  lookup error; checkPinterestLinkWarnings is the fail-open wrapper. */
async function findRecentlyBlockedHosts(hosts: string[]): Promise<string[]> {
  const since = new Date(Date.now() - BLOCKED_LINK_LOOKBACK_MS).toISOString();
  // Three shapes of the same failure: the reason LazyRelay writes now, the raw
  // Pinterest text kept next to it, and older rows that only hold the raw text.
  const shapes = [
    () => supabase.from("post_results").select("scheduled_post_id").eq("error_message", PINTEREST_BLOCKED_LINK_MESSAGE),
    () => supabase.from("post_results").select("scheduled_post_id").ilike("raw_error_message", "%blocked this link%"),
    () => supabase.from("post_results").select("scheduled_post_id").ilike("error_message", "%blocked this link%"),
  ];
  const postIds = new Set<string>();
  for (const shape of shapes) {
    const { data, error } = await shape().gt("created_at", since).order("created_at", { ascending: false }).limit(MAX_FAILURES_READ);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) postIds.add(row.scheduled_post_id as string);
  }
  if (postIds.size === 0) return [];

  const { data: posts, error: postsError } = await supabase
    .from("scheduled_posts")
    .select("social_account_id, content, destination_link")
    .in("id", [...postIds])
    .eq("status", "failed");
  if (postsError) throw new Error(postsError.message);
  if (!posts || posts.length === 0) return [];

  // The blocked-link wording is Pinterest's; ignore any other platform's row
  // that happens to carry similar raw text.
  const accountIds = [...new Set(posts.map((p) => p.social_account_id as string).filter(Boolean))];
  const { data: pinterestAccounts, error: accountsError } = await supabase
    .from("social_accounts")
    .select("id")
    .in("id", accountIds)
    .eq("platform", "pinterest");
  if (accountsError) throw new Error(accountsError.message);
  const pinterestIds = new Set((pinterestAccounts ?? []).map((a) => a.id as string));

  const blockedHosts = new Set<string>();
  for (const post of posts) {
    if (!pinterestIds.has(post.social_account_id as string)) continue;
    for (const h of [...extractLinkHosts(post.content as string), ...extractLinkHosts(post.destination_link as string)]) blockedHosts.add(h);
  }
  // Only hosts the customer is actually linking to ever leave this function.
  return [...blockedHosts].filter((blocked) => hosts.some((h) => isSameOrSubdomain(h, blocked)));
}

/** Warnings for a Pinterest pin being scheduled or rescheduled. Always
 *  resolves: any problem means "no warning". */
export async function checkPinterestLinkWarnings(input: {
  platform: string;
  content: string | null | undefined;
  destinationLink?: string | null;
}): Promise<PostWarning[]> {
  if (input.platform !== "pinterest") return [];
  const hosts = [...new Set([...extractLinkHosts(input.content), ...extractLinkHosts(input.destinationLink)])];
  if (hosts.length === 0) return [];
  try {
    const blocked = await findRecentlyBlockedHosts(hosts);
    return blocked.map((host) => ({ code: "pinterest_link_recently_blocked" as const, host, message: pinterestLinkWarningMessage(host) }));
  } catch (err) {
    console.warn("[pinterestLinkWarnings] lookup failed, no warning shown:", err instanceof Error ? err.message : err);
    return [];
  }
}
