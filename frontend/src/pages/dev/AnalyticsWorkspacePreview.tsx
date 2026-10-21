// DEV ONLY page at /dev/analytics-workspace. The Insights workspace on made-up brands, accounts, posts and numbers (nothing real, links are example.com).
// Loaded by App.tsx only behind import.meta.env.DEV, so it is never part of a production build.

import { useMemo, useState } from "react";
import { AnalyticsWorkspace } from "../../components/dashboard/AnalyticsWorkspace";
import type { AnalyticsSummary, ScheduledPost, SocialAccount } from "../../lib/api";
import { derivePrevious, type RangeDays } from "../../lib/analyticsModel";

const NOW = new Date(2026, 9, 21, 12, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const BRANDS = ["Alpha Brand", "Beta Brand", "Gamma Brand"];

const acct = (id: string, platform: string, brand: string, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: `@${brand.toLowerCase().replace(/\s+/g, "")}`, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "brand-" + brand, ...extra,
});
const ACCOUNTS: SocialAccount[] = [
  ...["tiktok", "instagram", "facebook", "mastodon", "bluesky", "x", "discord", "slack"].map((p) => acct("alpha-" + p, p, "Alpha Brand")),
  ...["facebook", "instagram", "pinterest", "threads"].map((p) => acct("beta-" + p, p, "Beta Brand")),
  ...["tiktok", "youtube"].map((p) => acct("gamma-" + p, p, "Gamma Brand")),
  acct("gamma-linkedin", "linkedin", "Gamma Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
];

// 90 days of made-up published posts: a few per day, weighted to Tuesday and Thursday afternoons so the heatmap has a clear busiest window.
const POSTS: ScheduledPost[] = (() => {
  const out: ScheduledPost[] = [];
  for (let d = 0; d < 90; d += 1) {
    const day = new Date(NOW.getTime() - (d + 1) * DAY_MS);
    const weekday = day.getDay();
    const count = weekday === 2 || weekday === 4 ? 3 : d % 3 === 0 ? 1 : 0;
    for (let i = 0; i < count; i += 1) {
      const acc = ACCOUNTS[(d + i) % (ACCOUNTS.length - 1)];
      const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 14 + (i % 2), 10 * i);
      out.push({
        id: `post-${d}-${i}`, status: "posted", social_account_id: acc.id, scheduled_for: when.toISOString(), paused_at: null, content: "Sample post",
        post_results: [{ verified_live: true, platform_post_url: `https://example.com/${acc.platform}/post-${d}-${i}`, error_message: null }],
      } as unknown as ScheduledPost);
    }
  }
  out.push({ id: "queued-1", status: "pending", social_account_id: "beta-pinterest", scheduled_for: "2026-10-24T08:00:00Z", paused_at: "2026-10-20T00:00:00Z", content: "Sample", post_results: [] } as unknown as ScheduledPost);
  return out;
})();

/** Made-up summary for a range and brand, built from the made-up posts so the tiles, chart and lists agree with each other. */
function summaryFor(days: number, brand: string): AnalyticsSummary {
  const since = NOW.getTime() - days * DAY_MS;
  const byPlatform: AnalyticsSummary["byPlatform"] = {};
  const dailyCounts: Record<string, number> = {};
  let posted = 0;
  for (const p of POSTS) {
    const account = ACCOUNTS.find((a) => a.id === p.social_account_id);
    const t = p.scheduled_for ? Date.parse(p.scheduled_for) : NaN;
    if (p.status !== "posted" || !account || (brand && account.brand_label !== brand) || t < since || t > NOW.getTime()) continue;
    posted += 1;
    const row = (byPlatform[account.platform] ??= { total: 0, posted: 0, failed: 0, verifiedLive: 0 });
    row.total += 1;
    row.posted += 1;
    row.verifiedLive += 1;
    const key = new Date(t).toISOString().slice(0, 10);
    dailyCounts[key] = (dailyCounts[key] ?? 0) + 1;
  }
  const failed = Math.round(posted / 25);
  return { rangeDays: days, totalPosts: posted * 12, byStatus: { posted, failed, pending: posted * 4 }, byPlatform, dailyCounts, verifiedLiveRate: posted > 0 ? 0.94 : null, engagement: {} };
}

export function AnalyticsWorkspacePreview() {
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [brand, setBrand] = useState("");
  const summary = useMemo(() => summaryFor(rangeDays, brand), [rangeDays, brand]);
  const previous = useMemo(() => derivePrevious(summary, summaryFor(rangeDays * 2, brand)), [summary, rangeDays, brand]);
  const brandCounts = useMemo(() => BRANDS.map((name) => ({ name, published: summaryFor(rangeDays, name).byStatus.posted })), [rangeDays]);
  return (
    <div style={{ background: "#0b0f19", minHeight: "100dvh", padding: 24 }}>
      <p style={{ color: "#94a3b8", margin: "0 0 16px" }}>Dev preview: made-up data only, nothing is loaded or sent.</p>
      <AnalyticsWorkspace
        rangeDays={rangeDays}
        onRangeChange={setRangeDays}
        brands={BRANDS}
        brand={brand}
        onBrandChange={setBrand}
        summary={summary}
        previous={previous}
        brandCounts={brandCounts}
        posts={POSTS}
        accounts={ACCOUNTS}
        now={NOW}
      />
    </div>
  );
}
