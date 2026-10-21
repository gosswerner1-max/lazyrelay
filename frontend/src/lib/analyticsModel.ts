// Numbers behind the Insights workspace (pure, no network): growth text, KPI figures, the per-day series, channel rows, brand shares, account
// health, the day-of-week x hour posting windows and the proof-of-publish list. Everything copes with an empty account (zeros, empty lists, never NaN).

import type { AnalyticsSummary, ScheduledPost, SocialAccount } from "./api";
import { COMPOSER_CHANNELS } from "./postingChannels";
import { accountMatchesBrand } from "../pages/dashboard/dashboardHelpers";

export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const DASH = "—";
/** A rise above this many percent is shown as ">+999%" instead of a long number. */
const GROWTH_CAP = 999;

export type GrowthTone = "up" | "down" | "flat" | "na";
export interface Growth {
  text: string;
  tone: GrowthTone;
}

/** Growth against the previous equal period. A previous period of 0 or missing is "N/A", never a percentage. */
export function growthLabel(current: number | null | undefined, previous: number | null | undefined): Growth {
  if (current == null || !Number.isFinite(current) || previous == null || !Number.isFinite(previous) || previous === 0) return { text: "N/A", tone: "na" };
  const pct = ((current - previous) / previous) * 100;
  if (pct > GROWTH_CAP) return { text: `>+${GROWTH_CAP}%`, tone: "up" };
  const rounded = Math.round(pct);
  if (rounded > 0) return { text: `+${rounded}%`, tone: "up" };
  if (rounded < 0) return { text: `${rounded}%`, tone: "down" };
  return { text: "0%", tone: "flat" };
}

/** A 0..1 rate as a whole percent; a dash when there is no data. */
export function formatPercent(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return DASH;
  return `${Math.round(rate * 100)}%`;
}

const safeCount = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export interface PreviousFigures {
  published: number;
  failed: number;
  verifiedLiveRate: number | null;
}

const sumPlatforms = (s: AnalyticsSummary, key: "posted" | "verifiedLive"): number =>
  Object.values(s.byPlatform ?? {}).reduce((total, p) => total + safeCount(p?.[key]), 0);

/**
 * The previous equal period, worked out as (a window twice as long) minus (the current window). null when either summary is missing.
 * Counts never go below zero; the rate is null when nothing was posted in the previous period.
 */
export function derivePrevious(current: AnalyticsSummary | null, doubled: AnalyticsSummary | null): PreviousFigures | null {
  if (!current || !doubled) return null;
  const published = Math.max(0, safeCount(doubled.byStatus?.posted) - safeCount(current.byStatus?.posted));
  const failed = Math.max(0, safeCount(doubled.byStatus?.failed) - safeCount(current.byStatus?.failed));
  const posted = sumPlatforms(doubled, "posted") - sumPlatforms(current, "posted");
  const verified = sumPlatforms(doubled, "verifiedLive") - sumPlatforms(current, "verifiedLive");
  return { published, failed, verifiedLiveRate: posted > 0 ? Math.min(1, Math.max(0, verified) / posted) : null };
}

export interface KpiFigure {
  value: number;
  display: string;
  growth: Growth;
}
export interface KpiFigures {
  published: KpiFigure;
  verified: KpiFigure;
  failed: KpiFigure;
}

/** The three tiles. Published is byStatus.posted: totalPosts counts every status and over-counts. */
export function kpiFigures(summary: AnalyticsSummary | null, previous: PreviousFigures | null): KpiFigures {
  const published = safeCount(summary?.byStatus?.posted);
  const failed = safeCount(summary?.byStatus?.failed);
  const rate = summary?.verifiedLiveRate ?? null;
  return {
    published: { value: published, display: published.toLocaleString("en-US"), growth: growthLabel(summary ? published : null, previous?.published) },
    verified: { value: rate != null && Number.isFinite(rate) ? rate : 0, display: formatPercent(rate), growth: growthLabel(rate, previous?.verifiedLiveRate) },
    failed: { value: failed, display: failed.toLocaleString("en-US"), growth: growthLabel(summary ? failed : null, previous?.failed) },
  };
}

export interface DayPoint {
  date: string;
  count: number;
}

/** One point per day of the range (UTC dates, like the server's keys), oldest first, days without posts as 0 so the line is continuous. */
export function dailySeries(dailyCounts: Record<string, number> | undefined, rangeDays: number, now: Date): DayPoint[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: DayPoint[] = [];
  for (let i = rangeDays - 1; i >= 0; i -= 1) {
    const date = new Date(todayUtc - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ date, count: safeCount(dailyCounts?.[date]) });
  }
  return out;
}

export interface ChannelRow {
  id: string;
  label: string;
  count: number;
  /** 0 to 100, relative to the busiest channel. */
  widthPct: number;
}

export const platformLabel = (id: string): string => COMPOSER_CHANNELS.find((c) => c.id === id)?.label ?? id;

/** Every platform in byPlatform by published count (biggest first, then by name), with bar widths relative to the biggest. */
export function channelRows(byPlatform: AnalyticsSummary["byPlatform"] | undefined): ChannelRow[] {
  const rows = Object.entries(byPlatform ?? {}).map(([id, p]) => ({ id, label: platformLabel(id), count: safeCount(p?.posted) }));
  rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const top = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return rows.map((r) => ({ ...r, widthPct: top > 0 ? (r.count / top) * 100 : 0 }));
}

export interface BrandCount {
  name: string;
  published: number;
}
export interface BrandShare {
  name: string;
  published: number;
  pct: number;
}

export function brandShares(counts: BrandCount[]): { total: number; rows: BrandShare[] } {
  const total = counts.reduce((t, c) => t + safeCount(c.published), 0);
  return {
    total,
    rows: counts.map((c) => ({ name: c.name, published: safeCount(c.published), pct: total > 0 ? Math.round((safeCount(c.published) / total) * 100) : 0 })),
  };
}

export interface NetworkHealth {
  active: number;
  paused: number;
  errors: number;
  total: number;
  microText: string;
}

/**
 * Accounts for the brand filter: "Errors" need a reconnect; "Paused" are usable accounts whose queued posts are all paused;
 * everything else is "Active". The account record itself has no pause flag, so this is worked out from the queue.
 */
export function networkHealth(accounts: SocialAccount[], posts: ScheduledPost[], brandFilter: string): NetworkHealth {
  let active = 0;
  let paused = 0;
  let errors = 0;
  for (const a of accounts) {
    if (!accountMatchesBrand(a, brandFilter)) continue;
    if (a.needs_reconnect_at) {
      errors += 1;
      continue;
    }
    const queued = posts.filter((p) => p.status === "pending" && p.social_account_id === a.id);
    if (queued.length > 0 && queued.every((p) => !!p.paused_at)) paused += 1;
    else active += 1;
  }
  return { active, paused, errors, total: active + paused + errors, microText: `${active} Active / ${paused} Paused / ${errors} Errors` };
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const pad = (n: number): string => String(n).padStart(2, "0");

export interface PostingWindows {
  /** [weekday Monday..Sunday][hour 0..23] */
  grid: number[][];
  max: number;
  total: number;
  busiest: { dayIndex: number; hour: number; count: number; label: string } | null;
}

/** Published posts of the range, counted by local weekday and hour. The post's scheduled time is the best time the dashboard list has. */
export function postingWindows(posts: ScheduledPost[], accounts: SocialAccount[], brandFilter: string, rangeDays: number, now: Date): PostingWindows {
  const grid = WEEKDAYS.map(() => new Array<number>(24).fill(0));
  const since = now.getTime() - rangeDays * DAY_MS;
  let total = 0;
  for (const p of posts) {
    if (p.status !== "posted" || !p.scheduled_for) continue;
    const account = accounts.find((a) => a.id === p.social_account_id);
    if (!accountMatchesBrand(account, brandFilter)) continue;
    const when = new Date(p.scheduled_for);
    const t = when.getTime();
    if (Number.isNaN(t) || t < since || t > now.getTime()) continue;
    grid[(when.getDay() + 6) % 7][when.getHours()] += 1;
    total += 1;
  }
  let busiest: PostingWindows["busiest"] = null;
  grid.forEach((row, dayIndex) =>
    row.forEach((count, hour) => {
      if (count > 0 && (!busiest || count > busiest.count)) busiest = { dayIndex, hour, count, label: `${WEEKDAYS[dayIndex]} ${pad(hour)}:00 to ${pad((hour + 1) % 24)}:00` };
    }),
  );
  return { grid, max: busiest ? (busiest as { count: number }).count : 0, total, busiest };
}

export interface ProofItem {
  id: string;
  platform: string;
  when: string | null;
  url: string;
}

function safeWebUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The most recent verified-live posts that have a web link, newest first. */
export function proofList(posts: ScheduledPost[], accounts: SocialAccount[], brandFilter: string, limit: number): ProofItem[] {
  const items: ProofItem[] = [];
  for (const p of posts) {
    if (p.status !== "posted") continue;
    const account = accounts.find((a) => a.id === p.social_account_id);
    if (!accountMatchesBrand(account, brandFilter)) continue;
    const result = (p.post_results ?? []).find((r) => r.verified_live && safeWebUrl(r.platform_post_url));
    const url = safeWebUrl(result?.platform_post_url);
    if (!url) continue;
    items.push({ id: p.id, platform: account?.platform ?? "unknown", when: p.scheduled_for, url });
  }
  items.sort((a, b) => (Date.parse(b.when ?? "") || 0) - (Date.parse(a.when ?? "") || 0));
  return items.slice(0, Math.max(0, limit));
}
