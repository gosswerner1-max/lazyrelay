// The "Analytics" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { PlatformIcon, BRAND_COLORS } from "../../components/PlatformIcon";
import { Spinner } from "../../components/Spinner";
import { KpiRow, StatTile, TrendLine, MultiTrendLine, PlatformBarChart, Sparkline, formatCompact } from "../../components/Charts";
import { BrandFilterSelect } from "./dashboardComponents";
import { useDashboard } from "./DashboardContext";

export function AnalyticsTab() {
  const {
    accounts,
    brandFilter,
    setBrandFilter,
    analytics,
    analyticsLoading,
    analyticsRangeDays,
    setAnalyticsRangeDays,
    insightLoading,
    insightResult,
    handleGetInsight,
  } = useDashboard();

  return (
    <section>
      <h2>Analytics</h2>
      <div className="analytics-range">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            className={d === analyticsRangeDays ? "tab-active" : ""}
            onClick={() => setAnalyticsRangeDays(d)}
          >
            Last {d} days
          </button>
        ))}
      </div>
      <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
      {analyticsLoading && <Spinner />}
      {!analyticsLoading && analytics && analytics.totalPosts === 0 && (
        <p className="empty">No posts scheduled in this range yet. Analytics fill in once posts go out.</p>
      )}
      {!analyticsLoading && analytics && analytics.totalPosts > 0 && (
        <>
          <div className="analytics-insight-row">
            <button type="button" className="btn-outline" disabled={insightLoading} onClick={handleGetInsight}>
              {insightLoading ? "Thinking..." : "Get AI insight: why this worked"}
            </button>
          </div>
          {insightResult && "insufficientData" in insightResult && (
            <p className="section-note">
              Not enough engagement data yet for a real insight ({insightResult.postsWithData} post
              {insightResult.postsWithData === 1 ? "" : "s"} with data, need at least {insightResult.needed}).
              Check back once more posts have had time to collect engagement numbers.
            </p>
          )}
          {insightResult && "insight" in insightResult && <p className="analytics-insight-card">{insightResult.insight}</p>}
          <KpiRow>
            <StatTile label="Total posts" value={formatCompact(analytics.totalPosts)} icon="posts" accent="#3b82f6" />
            <StatTile label="Posted" value={formatCompact(analytics.byStatus.posted ?? 0)} icon="check" accent="#16a34a" />
            <StatTile label="Failed" value={formatCompact(analytics.byStatus.failed ?? 0)} icon="alert" accent="#f97316" />
            <StatTile
              label="Verified live"
              value={analytics.verifiedLiveRate === null ? "—" : `${Math.round(analytics.verifiedLiveRate * 100)}%`}
              icon="check"
              accent="#0d9488"
            />
          </KpiRow>

          <div className="chart-section">
            <h3>By platform</h3>
            <p className="muted">
              Likes/comments/shares/views are only readable today on Facebook, Instagram, Mastodon, Bluesky, X, and
              YouTube. Every other platform shows "—", not a zero, since LazyRelay has no read access there yet.
            </p>
            <PlatformBarChart
              data={Object.entries(analytics.byPlatform).map(([platform, stats]) => ({ platform, total: stats.total }))}
            />
            <div className="table-scroll" style={{ marginTop: 18 }}>
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Total</th>
                  <th>Posted</th>
                  <th>Failed</th>
                  <th>Verified live</th>
                  <th>Likes</th>
                  <th>Comments</th>
                  <th>Shares</th>
                  <th>Views</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(analytics.byPlatform)
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([platform, stats]) => {
                    const eng = analytics.engagement[platform];
                    // The backend sums each post's most-mature checkpoint,
                    // collapsing "this platform never returns shares" and
                    // "these posts genuinely got 0 shares" into the same
                    // number — a real gap in the aggregate response, not
                    // something to guess at from the number itself. Each
                    // adapter's actual field support is known exactly
                    // (written today, see backend/src/platforms/*.ts), so
                    // that's used directly instead of inferring from data.
                    const supportsShares = ["facebook", "mastodon", "bluesky", "x"].includes(platform);
                    const supportsViews = ["x", "youtube"].includes(platform);
                    return (
                      <tr key={platform}>
                        <td>
                          <span className="platform-badge">
                            <PlatformIcon platform={platform} size={13} />
                            {platform}
                          </span>
                        </td>
                        <td>{stats.total}</td>
                        <td>{stats.posted}</td>
                        <td>{stats.failed}</td>
                        <td>{stats.verifiedLive}</td>
                        <td>{eng ? eng.likes : "—"}</td>
                        <td>{eng ? eng.comments : "—"}</td>
                        <td>{eng && supportsShares ? eng.shares : "—"}</td>
                        <td>{eng && supportsViews ? eng.views : "—"}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            </div>
          </div>

          <div className="chart-section">
            <h3>Daily volume</h3>
            {analytics.dailyCountsByPlatform && Object.keys(analytics.dailyCountsByPlatform).length > 0 ? (
              <MultiTrendLine countsByPlatform={analytics.dailyCountsByPlatform} />
            ) : (
              <TrendLine
                data={Object.entries(analytics.dailyCounts)
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([day, count]) => ({ day, count }))}
              />
            )}
          </div>

          <div className="chart-section">
            <h3>Audience growth</h3>
            {(!analytics.audienceGrowth || Object.keys(analytics.audienceGrowth).length === 0) ? (
              <p className="muted">
                No follower-count history yet — this fills in daily once your Mastodon, Bluesky, or YouTube
                accounts have been connected a day or more. Other platforms don't support this yet.
              </p>
            ) : (
              <>
                <p className="muted">
                  Follower count over time. Only readable today on Mastodon, Bluesky, and YouTube — every other
                  platform is absent from this table, not shown as zero, since LazyRelay has no read access
                  there yet.
                </p>
                <div className="table-scroll">
                  <table className="analytics-table">
                    <thead>
                      <tr>
                        <th>Platform</th>
                        <th>Trend</th>
                        <th>Current followers</th>
                        <th>Change over range</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(analytics.audienceGrowth)
                        .sort((a, b) => {
                          const aLatest = a[1].trend[a[1].trend.length - 1]?.followerCount ?? 0;
                          const bLatest = b[1].trend[b[1].trend.length - 1]?.followerCount ?? 0;
                          return bLatest - aLatest;
                        })
                        .map(([platform, growth]) => {
                          const latest = growth.trend[growth.trend.length - 1]?.followerCount;
                          return (
                            <tr key={platform}>
                              <td>
                                <span className="platform-badge">
                                  <PlatformIcon platform={platform} size={13} />
                                  {platform}
                                </span>
                              </td>
                              <td>
                                {growth.trend.length >= 2 ? (
                                  <Sparkline
                                    data={growth.trend.map((t) => ({ value: t.followerCount }))}
                                    color={BRAND_COLORS[platform] ?? "#8b93a1"}
                                  />
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td>{latest ?? "—"}</td>
                              <td>
                                {growth.netChange === null
                                  ? "—"
                                  : growth.netChange > 0
                                    ? `+${growth.netChange}`
                                    : growth.netChange}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
