// Channel logic behind the Posting workspace (pure, no network): which channels are connected for the selected brand, what stays ticked when the
// brand changes, the tightest character limit, and the queue numbers shown next to the composer.

import type { ScheduledPost, SocialAccount } from "./api";
import { accountMatchesBrand } from "../pages/dashboard/dashboardHelpers";

export interface ComposerChannel {
  id: string;
  label: string;
  /** Character limit used for the counter and the previews. Guidance only: the server and the platform stay the authority. */
  limit: number;
}

/** The 18 distribution platforms plus WhatsApp (messaging), in one fixed order so the grid never changes size or position. */
export const COMPOSER_CHANNELS: ComposerChannel[] = [
  { id: "tiktok", label: "TikTok", limit: 2200 },
  { id: "instagram", label: "Instagram", limit: 2200 },
  { id: "facebook", label: "Facebook", limit: 63206 },
  { id: "youtube", label: "YouTube", limit: 5000 },
  { id: "linkedin", label: "LinkedIn", limit: 3000 },
  { id: "pinterest", label: "Pinterest", limit: 500 },
  { id: "mastodon", label: "Mastodon", limit: 500 },
  { id: "bluesky", label: "Bluesky", limit: 300 },
  { id: "threads", label: "Threads", limit: 500 },
  { id: "x", label: "X", limit: 280 },
  { id: "telegram", label: "Telegram", limit: 4096 },
  { id: "discord", label: "Discord", limit: 2000 },
  { id: "wordpress", label: "WordPress", limit: 100000 },
  { id: "devto", label: "dev.to", limit: 100000 },
  { id: "hashnode", label: "Hashnode", limit: 100000 },
  { id: "lemmy", label: "Lemmy", limit: 10000 },
  { id: "slack", label: "Slack", limit: 40000 },
  { id: "tumblr", label: "Tumblr", limit: 4096 },
  { id: "whatsapp", label: "WhatsApp", limit: 4096 },
];

export interface ChannelState extends ComposerChannel {
  /** Usable accounts of this platform for the selected brand (accounts that need reconnecting are not included). */
  accounts: SocialAccount[];
  connected: boolean;
  /** True when the brand has an account on this platform but it can no longer be used until the customer reconnects it. */
  needsReconnect: boolean;
}

/** All channels, always in the same order, each marked connected or not for the brand filter ("" = every account). */
export function channelStates(accounts: SocialAccount[], brandFilter: string): ChannelState[] {
  return COMPOSER_CHANNELS.map((c) => {
    const mine = accounts.filter((a) => a.platform === c.id && accountMatchesBrand(a, brandFilter));
    const usable = mine.filter((a) => !a.needs_reconnect_at);
    return { ...c, accounts: usable, connected: usable.length > 0, needsReconnect: mine.length > 0 && usable.length === 0 };
  });
}

/** After a brand switch: keep the ticks that are still connected; if none are left, tick the first few connected channels so the composer is never empty. */
export function reconcileSelection(previous: string[], states: ChannelState[], fallbackCount = 3): string[] {
  const connected = states.filter((s) => s.connected).map((s) => s.id);
  const kept = previous.filter((id) => connected.includes(id));
  return kept.length > 0 ? kept : connected.slice(0, fallbackCount);
}

/** The channel with the smallest character limit among the ticked ones, or null when nothing is ticked. */
export function tightestLimit(selectedIds: string[]): ComposerChannel | null {
  const chosen = COMPOSER_CHANNELS.filter((c) => selectedIds.includes(c.id));
  if (chosen.length === 0) return null;
  return chosen.reduce((a, b) => (b.limit < a.limit ? b : a));
}

export interface QueueStats {
  paused: number;
  scheduled: number;
  published30d: number;
  drafts: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Numbers beside the composer. Drafts have no account yet, so they are always counted in full; everything else follows the brand filter. */
export function queueStats(posts: ScheduledPost[], accounts: SocialAccount[], brandFilter: string, now: Date): QueueStats {
  const out: QueueStats = { paused: 0, scheduled: 0, published30d: 0, drafts: 0 };
  const since = now.getTime() - 30 * DAY_MS;
  for (const p of posts) {
    if (p.status === "draft") {
      out.drafts += 1;
      continue;
    }
    const account = accounts.find((a) => a.id === p.social_account_id);
    if (!accountMatchesBrand(account, brandFilter) && !(brandFilter === "" && !account)) continue;
    if (p.status === "pending") {
      if (p.paused_at) out.paused += 1;
      else out.scheduled += 1;
    } else if (p.status === "posted" && p.scheduled_for) {
      const t = new Date(p.scheduled_for).getTime();
      if (t >= since && t <= now.getTime()) out.published30d += 1;
    }
  }
  return out;
}
