// RSS feeds (backend 0103): new feed items become drafts.

export interface RssFeed {
  id: string;
  url: string;
  label: string | null;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface RssFeedList {
  maxFeeds: number;
  feeds: RssFeed[];
}

/** A short plain-language status line for one feed. */
export function describeFeedStatus(f: Pick<RssFeed, "enabled" | "lastCheckedAt" | "lastError">): string {
  if (!f.enabled) return "Paused";
  if (f.lastError) return `Problem: ${f.lastError}`;
  if (!f.lastCheckedAt) return "Not checked yet";
  return `Last checked ${new Date(f.lastCheckedAt).toLocaleString()}`;
}
