// The numbers and lists behind the Overview page: what posts next, what went out, and what needs attention. Pure: posts and accounts in,
// plain data out. A paused post is "paused", never "scheduled", because the scheduler skips it.

import type { ScheduledPost, SocialAccount } from "./api";

export interface OverviewRow {
  id: string;
  platform: string;
  account: string;
  text: string;
  when: string | null;
  url: string | null;
  verified: boolean;
}

export interface OverviewModel {
  next: OverviewRow | null;
  upcoming: OverviewRow[];
  latest: OverviewRow[];
  scheduled: number;
  paused: number;
  drafts: number;
  failed: number;
  postedToday: number;
  dueToday: number;
  needsReconnect: number;
  allClear: boolean;
}

const LIST_LENGTH = 8;

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function buildOverviewModel(posts: ScheduledPost[], accounts: SocialAccount[], brand: string, now: Date): OverviewModel {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const inBrand = (accountId: string | null): boolean => {
    if (!brand) return true;
    const acc = accountId ? byId.get(accountId) : undefined;
    return !!acc && acc.brand_label === brand;
  };
  const row = (p: ScheduledPost): OverviewRow => {
    const acc = p.social_account_id ? byId.get(p.social_account_id) : undefined;
    const result = p.post_results?.find((r) => !r.saved_as_draft);
    return {
      id: p.id,
      platform: acc?.platform ?? "",
      account: acc?.display_name ?? acc?.brand_label ?? "",
      text: p.content.replace(/\s+/g, " ").trim(),
      when: p.scheduled_for,
      url: result?.platform_post_url ?? null,
      verified: !!result?.verified_live,
    };
  };

  const mine = posts.filter((p) => inBrand(p.social_account_id) || (p.status === "draft" && !brand));
  const waiting = mine.filter((p) => p.status === "pending" && !p.paused_at && p.scheduled_for);
  const nowMs = now.getTime();
  const upcomingPosts = waiting
    .filter((p) => new Date(p.scheduled_for as string).getTime() >= nowMs)
    .sort((a, b) => new Date(a.scheduled_for as string).getTime() - new Date(b.scheduled_for as string).getTime());
  const postedPosts = mine
    .filter((p) => p.status === "posted" && p.scheduled_for)
    .sort((a, b) => new Date(b.scheduled_for as string).getTime() - new Date(a.scheduled_for as string).getTime());

  const failed = mine.filter((p) => p.status === "failed").length;
  const paused = mine.filter((p) => p.status === "pending" && !!p.paused_at).length;
  const needsReconnect = accounts.filter((a) => !!a.needs_reconnect_at && (!brand || a.brand_label === brand)).length;

  return {
    next: upcomingPosts[0] ? row(upcomingPosts[0]) : null,
    upcoming: upcomingPosts.slice(0, LIST_LENGTH).map(row),
    latest: postedPosts.slice(0, LIST_LENGTH).map(row),
    scheduled: upcomingPosts.length,
    paused,
    drafts: mine.filter((p) => p.status === "draft").length,
    failed,
    postedToday: postedPosts.filter((p) => sameLocalDay(new Date(p.scheduled_for as string), now)).length,
    dueToday: upcomingPosts.filter((p) => sameLocalDay(new Date(p.scheduled_for as string), now)).length,
    needsReconnect,
    allClear: failed === 0 && needsReconnect === 0 && paused === 0,
  };
}

/** "in 2 h 5 min", "in 3 days", "now": how long until a time, in words a person says. */
export function untilText(iso: string | null, now: Date): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return "";
  if (ms < 60_000) return "now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  const d = Math.round(h / 24);
  return `in ${d} ${d === 1 ? "day" : "days"}`;
}
