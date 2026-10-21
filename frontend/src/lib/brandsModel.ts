// Numbers and shapes behind the Brands workspace (pure, no network): one card per brand, the "n of cap" label, and the published-per-day series.

import type { Brand, BrandCapacity, ScheduledPost, SocialAccount } from "./api";
import { accountMatchesBrand } from "../pages/dashboard/dashboardHelpers";
import { channelStates } from "./postingChannels";

/** Brand dot colours: orange, teal, amber, sky, rose, green. Purple and violet are not part of the Midnight Canvas palette. */
export const BRAND_PALETTE = ["#ff5630", "#2dd4bf", "#fbbf24", "#38bdf8", "#fb7185", "#4ade80"] as const;

export interface BrandCard {
  brand: Brand;
  color: string;
  /** Every account assigned to the brand, including ones that need reconnecting. */
  accountCount: number;
  /** Platforms with at least one usable account for the brand. */
  channelCount: number;
}

/** One card per brand, in the order given (the colour follows the position, so it stays stable while the list does). */
export function brandCards(brands: Brand[], accounts: SocialAccount[]): BrandCard[] {
  return brands.map((brand, i) => ({
    brand,
    color: BRAND_PALETTE[i % BRAND_PALETTE.length],
    accountCount: accounts.filter((a) => accountMatchesBrand(a, brand.name)).length,
    channelCount: channelStates(accounts, brand.name).filter((s) => s.connected).length,
  }));
}

/** "2 of 5 brands", or null when the plan limit is not known (nothing is shown rather than a guess). */
export function brandCountLabel(count: number, capacity: Pick<BrandCapacity, "totalLimit"> | null | undefined): string | null {
  if (!capacity) return null;
  return `${count} of ${capacity.totalLimit} ${capacity.totalLimit === 1 ? "brand" : "brands"}`;
}

export interface DayCount {
  /** UTC calendar date (YYYY-MM-DD) of the day this bucket ends on. */
  date: string;
  count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

/** Published posts of one brand in 30 rolling 24-hour buckets ending at `now`, oldest first. The buckets add up to queueStats().published30d. */
export function publishedPerDay(posts: ScheduledPost[], accounts: SocialAccount[], brandName: string, now: Date): DayCount[] {
  const counts = new Array<number>(WINDOW_DAYS).fill(0);
  const end = now.getTime();
  const since = end - WINDOW_DAYS * DAY_MS;
  for (const p of posts) {
    if (p.status !== "posted" || !p.scheduled_for) continue;
    const account = accounts.find((a) => a.id === p.social_account_id);
    if (!accountMatchesBrand(account, brandName)) continue;
    const t = new Date(p.scheduled_for).getTime();
    if (!(t >= since && t <= end)) continue;
    const idx = WINDOW_DAYS - 1 - Math.floor((end - t) / DAY_MS);
    counts[Math.max(0, idx)] += 1;
  }
  return counts.map((count, i) => ({ date: new Date(end - (WINDOW_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10), count }));
}
