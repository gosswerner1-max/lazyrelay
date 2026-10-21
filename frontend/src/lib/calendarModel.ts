// Date and grouping logic behind the Calendar workspace (pure, no network). Days are keyed "YYYY-MM-DD" in the viewer's local time zone, the same
// key the rest of the dashboard uses (localDateKey), so a post lands on the day the customer sees on their own clock.

import type { ScheduledPost, SocialAccount } from "./api";
import { accountMatchesBrand, localDateKey } from "../pages/dashboard/dashboardHelpers";

/** Cards a weekly column shows before it says "+N more". */
export const PER_DAY_CARDS = 5;

/** Brand dots. Orange, teal, amber, sky, rose and green only: the banned hue family is not part of the palette. */
export const BRAND_PALETTE = ["#ff5630", "#3f8fa6", "#f5b942", "#6cb6ff", "#ff7aa8", "#2fd47a"];

export function brandColor(brand: string | null | undefined, brandNames: string[]): string {
  if (!brand) return "#64748b";
  const i = brandNames.indexOf(brand);
  if (i >= 0) return BRAND_PALETTE[i % BRAND_PALETTE.length];
  let h = 0;
  for (const ch of brand) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRAND_PALETTE[h % BRAND_PALETTE.length];
}

// Platforms with a banned brand hue (Mastodon, Discord, Slack, Nostr): their icons are drawn in slate, never in the brand colour.
export const MONO_ICON_PLATFORMS = new Set(["mastodon", "discord", "slack", "nostr"]);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const DOW3 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKeyOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The Monday of the week that contains d, at local midnight. */
export function startOfWeek(d: Date): Date {
  const offset = (d.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}

/** The seven day keys, Monday to Sunday, of the week that contains d. */
export function weekDays(d: Date): string[] {
  const start = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => dayKeyOf(addDays(start, i)));
}

/** Every day key shown in the month matrix: whole Monday-to-Sunday rows covering the month of d (five or six rows). */
export function monthMatrix(d: Date): string[] {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const rows = Math.ceil((lead + daysInMonth) / 7);
  return Array.from({ length: rows * 7 }, (_, i) => dayKeyOf(addDays(first, i - lead)));
}

export function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Mon 9 to Sun 15 Mar 2026", or "Mon 30 Mar to Sun 5 Apr 2026" when the week crosses a month. */
export function weekLabel(d: Date): string {
  const a = startOfWeek(d);
  const b = addDays(a, 6);
  const left = a.getMonth() === b.getMonth() ? `Mon ${a.getDate()}` : `Mon ${a.getDate()} ${MON3[a.getMonth()]}`;
  return `${left} to Sun ${b.getDate()} ${MON3[b.getMonth()]} ${b.getFullYear()}`;
}

/** Move the anchor by one week, or by one month (always landing on the 1st, so the 31st never drifts). */
export function shiftAnchor(d: Date, view: "week" | "month", direction: 1 | -1): Date {
  if (view === "week") return addDays(d, direction * 7);
  return new Date(d.getFullYear(), d.getMonth() + direction, 1);
}

/** "Fri 13 Mar" for a day key. */
export function dayTitle(key: string): string {
  const [y, m, day] = key.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  return `${DOW3[(d.getDay() + 6) % 7]} ${day} ${MON3[m - 1]}`;
}

function sortKey(p: ScheduledPost): string {
  // A planned draft has a day but no time, so it sorts ahead of timed posts.
  return p.scheduled_for ? new Date(p.scheduled_for).toISOString() : "";
}

/** Posts grouped by local day, each day sorted by time. Drafts count only when they have a planned day. */
export function postsByDay(posts: ScheduledPost[], accounts: SocialAccount[], brandFilter: string): Map<string, ScheduledPost[]> {
  const map = new Map<string, ScheduledPost[]>();
  for (const p of posts) {
    const key = p.scheduled_for ? localDateKey(p.scheduled_for) : p.planned_date;
    if (!key) continue;
    if (!accountMatchesBrand(accounts.find((a) => a.id === p.social_account_id), brandFilter) && !(brandFilter === "" && !p.social_account_id)) continue;
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return map;
}

export interface DayStats {
  total: number;
  published: number;
  paused: number;
  scheduled: number;
  failed: number;
  drafts: number;
}

export function dayStats(dayPosts: ScheduledPost[]): DayStats {
  const out: DayStats = { total: dayPosts.length, published: 0, paused: 0, scheduled: 0, failed: 0, drafts: 0 };
  for (const p of dayPosts) {
    if (p.status === "posted") out.published += 1;
    else if (p.status === "failed") out.failed += 1;
    else if (p.status === "draft") out.drafts += 1;
    else if (p.status === "pending" && p.paused_at) out.paused += 1;
    else out.scheduled += 1;
  }
  return out;
}

/** For each given day, how many posts came from a Google Calendar event. */
export function googleSyncByDay(byDay: Map<string, ScheduledPost[]>, days: string[]): Array<{ day: string; count: number }> {
  return days.map((day) => ({ day, count: (byDay.get(day) ?? []).filter((p) => !!p.google_event_id).length }));
}

