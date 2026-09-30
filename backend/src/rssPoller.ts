// RSS-to-drafts worker (master list #18). Every cycle, each enabled feed is
// fetched (safely), its new items become DRAFTS, and the feed remembers what it
// has already seen. Nothing here posts anything.

import { supabase } from "./supabase.js";
import { isSafeMediaUrl } from "./urlSafety.js";
import { draftTextFor, parseFeed, type FeedItem } from "./rssFeed.js";

export const RSS_CHECK_INTERVAL_MS = 30 * 60_000;
export const MAX_NEW_DRAFTS_PER_CHECK = 5;
export const MAX_DRAFTS_PER_ACCOUNT = 100;
const MAX_SEEN_IDS = 300;
const MAX_FEED_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** Fetches a feed as text. Every hop (including redirects) is checked against the private-address rules first. */
export async function fetchFeedText(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safety = await isSafeMediaUrl(current);
    if (!safety.safe) return { ok: false, error: `The feed address is not allowed: ${safety.reason}.` };
    let res: Response;
    try {
      res = await fetch(current, {
        headers: { "User-Agent": "LazyRelay-Feeds/1.0", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (err) {
      return { ok: false, error: `Could not reach the feed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: "The feed redirected without saying where." };
      try {
        current = new URL(loc, current).toString();
      } catch {
        return { ok: false, error: "The feed redirected to an invalid address." };
      }
      continue;
    }
    if (!res.ok) return { ok: false, error: `The feed answered ${res.status}.` };
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_FEED_BYTES) return { ok: false, error: "The feed is too large." };
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) return { ok: false, error: "The feed is too large." };
    return { ok: true, text };
  }
  return { ok: false, error: "The feed redirected too many times." };
}

export interface FeedPlan {
  newItems: FeedItem[]; // to draft, oldest first
  seenIds: string[]; // the updated memory
}

/**
 * Decides what to draft. A feed's FIRST successful check only learns what is already
 * there (no drafts), so adding a feed never floods the drafts. After that, unseen items
 * become drafts, at most `cap` per check; items over the cap stay unseen and are picked up
 * next check.
 */
export function planFeedCheck(items: FeedItem[], seenIds: string[], primed: boolean, cap: number): FeedPlan {
  const seen = new Set(seenIds);
  if (!primed) return { newItems: [], seenIds: trimSeen([...seenIds, ...items.map((i) => i.id)]) };
  const fresh = items.filter((i) => !seen.has(i.id)).reverse(); // feeds list newest first
  const take = fresh.slice(0, Math.max(0, cap));
  return { newItems: take, seenIds: trimSeen([...seenIds, ...take.map((i) => i.id)]) };
}

function trimSeen(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  return unique.length > MAX_SEEN_IDS ? unique.slice(unique.length - MAX_SEEN_IDS) : unique;
}

interface FeedRow {
  id: string;
  account_id: string;
  url: string;
  seen_ids: string[] | null;
  primed: boolean;
}

/** Checks one feed now. Returns how many drafts were created, or an error message. */
export async function checkFeed(feed: FeedRow): Promise<{ drafts: number; error: string | null }> {
  const fetched = await fetchFeedText(feed.url);
  const now = new Date().toISOString();
  if (!fetched.ok) {
    await supabase.from("rss_feeds").update({ last_checked_at: now, last_error: fetched.error }).eq("id", feed.id);
    return { drafts: 0, error: fetched.error };
  }
  const items = parseFeed(fetched.text);
  if (items.length === 0) {
    const error = "No posts were found in this feed. Check that the address is an RSS or Atom feed.";
    await supabase.from("rss_feeds").update({ last_checked_at: now, last_error: error }).eq("id", feed.id);
    return { drafts: 0, error };
  }

  const { count } = await supabase.from("scheduled_posts").select("id", { count: "exact", head: true }).eq("account_id", feed.account_id).eq("status", "draft");
  const room = MAX_DRAFTS_PER_ACCOUNT - (count ?? 0);
  const plan = planFeedCheck(items, feed.seen_ids ?? [], feed.primed, Math.min(MAX_NEW_DRAFTS_PER_CHECK, room));

  if (plan.newItems.length > 0) {
    const rows = plan.newItems.map((item) => ({
      account_id: feed.account_id,
      social_account_id: null,
      content: draftTextFor(item).slice(0, 2000),
      status: "draft",
    }));
    const { error } = await supabase.from("scheduled_posts").insert(rows);
    if (error) {
      console.error(`[rss] feed ${feed.id}: could not save drafts: ${error.message}`);
      await supabase.from("rss_feeds").update({ last_checked_at: now, last_error: "Something went wrong saving drafts. It will try again." }).eq("id", feed.id);
      return { drafts: 0, error: "save failed" };
    }
  }
  await supabase.from("rss_feeds").update({ seen_ids: plan.seenIds, primed: true, last_checked_at: now, last_error: null }).eq("id", feed.id);
  return { drafts: plan.newItems.length, error: null };
}

/** One worker pass: every enabled feed not checked in the last interval. */
export async function runRssCycle(): Promise<{ checked: number; drafts: number }> {
  const cutoff = new Date(Date.now() - RSS_CHECK_INTERVAL_MS + 60_000).toISOString();
  const { data } = await supabase
    .from("rss_feeds")
    .select("id, account_id, url, seen_ids, primed")
    .eq("enabled", true)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .limit(100);
  let drafts = 0;
  const feeds = (data ?? []) as FeedRow[];
  for (const feed of feeds) {
    try {
      drafts += (await checkFeed(feed)).drafts;
    } catch (err) {
      console.error(`[rss] feed ${feed.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: feeds.length, drafts };
}
