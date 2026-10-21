// The Insights workspace (ported from the approved single-screen staging design): header, three KPI tiles, a trend / posting-windows chart,
// posts by brand, channel comparison, network health and the proof-of-publish list. Presentational: the parent supplies every number.
// Only real data is drawn. Clicks and impressions are not collected, so there is no series for them.

import { useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsSummary, ScheduledPost, SocialAccount } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import {
  RANGE_OPTIONS, WEEKDAYS, brandShares, channelRows, dailySeries, kpiFigures, networkHealth, platformLabel, postingWindows, proofList,
  type BrandCount, type Growth, type PreviousFigures, type RangeDays,
} from "../../lib/analyticsModel";
import "./AnalyticsWorkspace.css";

interface Props {
  rangeDays: RangeDays;
  onRangeChange: (days: RangeDays) => void;
  /** Brand names for the dropdown ("All brands" is added here). */
  brands: string[];
  /** "" means every brand. */
  brand: string;
  onBrandChange: (brand: string) => void;
  summary: AnalyticsSummary | null;
  previous: PreviousFigures | null;
  brandCounts: BrandCount[];
  posts: ScheduledPost[];
  accounts: SocialAccount[];
  loading?: boolean;
  error?: string | null;
  /** Injected for tests; defaults to the real clock. */
  now?: Date;
}

// These brand colours fall in the hue family the Midnight Canvas palette bans, so their icons are drawn in slate instead.
const MONO_ICONS = new Set(["mastodon", "discord", "slack", "nostr"]);
const ORANGE = "#ff5630";
const SLATE = "#94a3b8";
const BRAND_COLORS = [ORANGE, "#ffb020", "#2fd4c0", "#4da3ff", "#2fd47a", "#ff8a65", "#8fb8ff", "#c9d3e3"];
const HEALTH_COLORS = { active: "#2fd47a", paused: "#ffb020", errors: "#ff4d4f" };
const CHANNEL_ROWS_VISIBLE = 6;
const PROOF_LIMIT = 20;
const HOURS_SHOWN = [0, 6, 12, 18];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
const monoClass = (platform: string) => (MONO_ICONS.has(platform) ? " an-mono" : "");
const nf = (n: number) => n.toLocaleString("en-US");
const formatDay = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function GrowthBadge({ growth }: { growth: Growth }) {
  return <span className={`an-growth an-growth--${growth.tone}`}>{growth.text}<span className="an-sr"> compared with the previous period</span></span>;
}

function Kpi({ label, display, growth }: { label: string; display: string; growth: Growth }) {
  return (
    <div className="an-kpi" role="group" aria-label={label}>
      <small>{label}</small>
      <strong>{display}</strong>
      <GrowthBadge growth={growth} />
    </div>
  );
}

export function AnalyticsWorkspace({ rangeDays, onRangeChange, brands, brand, onBrandChange, summary, previous, brandCounts, posts, accounts, loading, error, now }: Props) {
  const clock = useMemo(() => now ?? new Date(), [now]);
  const brandId = useId();
  const gradientId = useId().replace(/:/g, "");
  const [view, setView] = useState<"trend" | "windows">("trend");
  const reduced = prefersReducedMotion();

  const kpis = useMemo(() => kpiFigures(summary, previous), [summary, previous]);
  const series = useMemo(() => dailySeries(summary?.dailyCounts, rangeDays, clock), [summary, rangeDays, clock]);
  const seriesTotal = series.reduce((t, p) => t + p.count, 0);
  const busiestDay = series.reduce<(typeof series)[number] | null>((best, p) => (p.count > 0 && (!best || p.count > best.count) ? p : best), null);
  const windows = useMemo(() => postingWindows(posts, accounts, brand, rangeDays, clock), [posts, accounts, brand, rangeDays, clock]);
  const shares = useMemo(() => brandShares(brandCounts), [brandCounts]);
  const channels = useMemo(() => channelRows(summary?.byPlatform), [summary]);
  const health = useMemo(() => networkHealth(accounts, posts, brand), [accounts, posts, brand]);
  const proof = useMemo(() => proofList(posts, accounts, brand, PROOF_LIMIT), [posts, accounts, brand]);

  const trendLabel = `Published posts per day, last ${rangeDays} days: ${nf(seriesTotal)} ${seriesTotal === 1 ? "post" : "posts"}${busiestDay ? `, busiest day ${busiestDay.date} with ${busiestDay.count}` : ""}`;
  const healthSlices = [
    { name: "Active", value: health.active, color: HEALTH_COLORS.active },
    { name: "Paused", value: health.paused, color: HEALTH_COLORS.paused },
    { name: "Errors", value: health.errors, color: HEALTH_COLORS.errors },
  ].filter((s) => s.value > 0);
  const brandSlices = shares.rows.filter((r) => r.published > 0);

  return (
    <div className="an-root">
      <header className="an-header">
        <div>
          <h2>Insights</h2>
          {loading && <p className="an-note" role="status">Loading your numbers...</p>}
          {error && <p className="an-note an-note--error" role="alert">{error}</p>}
        </div>
        <div className="an-controls">
          <div className="an-range" role="group" aria-label="Date range">
            {RANGE_OPTIONS.map((d) => (
              <button key={d} type="button" aria-pressed={rangeDays === d} className={rangeDays === d ? "an-on" : ""} onClick={() => onRangeChange(d)}>{`${d} days`}</button>
            ))}
          </div>
          <label htmlFor={brandId} className="an-sr">Brand</label>
          <select id={brandId} className="an-select" value={brand} onChange={(e) => onBrandChange(e.target.value)}>
            <option value="">All brands</option>
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </header>

      <section className="an-kpis" aria-label="Key numbers">
        <Kpi label="Published" display={kpis.published.display} growth={kpis.published.growth} />
        <Kpi label="Verified live rate" display={kpis.verified.display} growth={kpis.verified.growth} />
        <Kpi label="Failed posts" display={kpis.failed.display} growth={kpis.failed.growth} />
      </section>

      <div className="an-row">
        <section className="an-module an-span2" aria-label="Performance overview">
          <div className="an-head">
            <h3>Performance overview</h3>
            <div className="an-seg" role="group" aria-label="Chart view">
              <button type="button" aria-pressed={view === "trend"} className={view === "trend" ? "an-on" : ""} onClick={() => setView("trend")}>Trend</button>
              <button type="button" aria-pressed={view === "windows"} className={view === "windows" ? "an-on" : ""} onClick={() => setView("windows")}>Posting windows</button>
            </div>
          </div>
          {view === "trend" ? (
            seriesTotal === 0 ? (
              <p className="an-empty">No published posts in this range yet. Your daily line appears here after the first post goes live.</p>
            ) : (
              <div className="an-chart" role="img" aria-label={trendLabel}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <defs>
                      <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={ORANGE} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={ORANGE} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} stroke={SLATE} tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
                    <YAxis allowDecimals={false} stroke={SLATE} tickLine={false} axisLine={false} fontSize={11} width={40} />
                    <Tooltip
                      cursor={{ stroke: "rgba(255,255,255,0.18)" }}
                      contentStyle={{ background: "#0b0f19", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 12, color: "#fff" }}
                      labelFormatter={(d) => formatDay(String(d))}
                      formatter={(v) => [nf(Number(v)), "Published"]}
                    />
                    <Area type="monotone" dataKey="count" stroke={ORANGE} strokeWidth={1.5} fill={`url(#${gradientId})`} dot={false} activeDot={{ r: 4, fill: ORANGE, stroke: "#0b0f19", strokeWidth: 2 }} isAnimationActive={!reduced} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )
          ) : windows.total === 0 ? (
            <p className="an-empty">No published posts in this range yet. The busiest posting window shows up after your first posts go live.</p>
          ) : (
            <div className="an-windows">
              <p className="an-busiest">Busiest window: <b>{windows.busiest?.label}</b> ({windows.busiest?.count} {windows.busiest?.count === 1 ? "post" : "posts"})</p>
              <div className="an-heat" role="img" aria-label={`Posting windows heatmap by weekday and hour, busiest ${windows.busiest?.label}`}>
                <span />
                <div className="an-heat-hours">{HOURS_SHOWN.map((h) => <span key={h} style={{ gridColumn: `${h + 1} / span 6` }}>{`${String(h).padStart(2, "0")}:00`}</span>)}</div>
                {WEEKDAYS.map((day, di) => (
                  <div className="an-heat-row" key={day}>
                    <span className="an-heat-day">{day.slice(0, 3)}</span>
                    <div className="an-heat-cells">
                      {windows.grid[di].map((count, hour) => (
                        <i
                          key={hour}
                          data-testid="an-heat-cell"
                          title={`${day} ${String(hour).padStart(2, "0")}:00: ${count} ${count === 1 ? "post" : "posts"}`}
                          style={{ background: count > 0 ? `rgba(255, 86, 48, ${0.14 + 0.86 * (count / windows.max)})` : undefined }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="an-module" aria-label="Posts by brand">
          <div className="an-head"><h3>Posts by brand</h3></div>
          {shares.total === 0 ? (
            <p className="an-empty">No published posts yet. Each brand's share appears here after the first post goes live.</p>
          ) : (
            <div className="an-brand">
              <div className="an-donut" role="img" aria-label={`Posts by brand: ${nf(shares.total)} published in total`}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={brandSlices} dataKey="published" nameKey="name" innerRadius="82%" outerRadius="90%" startAngle={90} endAngle={-270} stroke="none" isAnimationActive={!reduced}>
                      {brandSlices.map((r, i) => <Cell key={r.name} fill={BRAND_COLORS[i % BRAND_COLORS.length]} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="an-donut-c"><b>{nf(shares.total)}</b><small>published</small></div>
              </div>
              <ul className="an-legend" aria-label="Posts by brand">
                {shares.rows.map((r, i) => (
                  <li key={r.name}>
                    <i style={{ background: BRAND_COLORS[i % BRAND_COLORS.length] }} aria-hidden="true" />
                    <span className="an-legend-name">{r.name}</span>
                    <span className="an-legend-pct">{r.pct}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <div className="an-row">
        <section className="an-module" aria-label="Channel comparison">
          <div className="an-head"><h3>Channel comparison</h3></div>
          {channels.length === 0 ? (
            <p className="an-empty">No channels have published yet.</p>
          ) : (
            <ul className="an-channels an-scroll" aria-label="Channel comparison" style={{ maxHeight: `${CHANNEL_ROWS_VISIBLE * 40}px` }}>
              {channels.map((c) => (
                <li key={c.id}>
                  <span className={`an-icon${monoClass(c.id)}`}><PlatformIcon platform={c.id} size={18} /></span>
                  <span className="an-ch-name">{platformLabel(c.id)}</span>
                  <span className="an-bar" aria-hidden="true"><i style={{ width: `${c.widthPct}%` }} /></span>
                  <span className="an-ch-count">{nf(c.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="an-module" aria-label="Active network health">
          <div className="an-head"><h3>Active network health</h3></div>
          {health.total === 0 ? (
            <p className="an-empty">No accounts connected yet. Connect your first account and its health shows up here.</p>
          ) : (
            <div className="an-health">
              <div className="an-donut an-donut--health" role="img" aria-label={`Active network health: ${health.total} ${health.total === 1 ? "account" : "accounts"}, ${health.active} active, ${health.paused} paused, ${health.errors} need a reconnect`}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={healthSlices} dataKey="value" nameKey="name" innerRadius="70%" outerRadius="100%" paddingAngle={0} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={!reduced}>
                      {healthSlices.map((s) => <Cell key={s.name} fill={s.color} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="an-donut-c"><b>{nf(health.total)}</b><small>accounts</small></div>
              </div>
              <p className="an-micro">{health.microText}</p>
            </div>
          )}
        </section>

        <section className="an-module" aria-label="Proof-of-Publish">
          <div className="an-head"><h3>Proof-of-Publish</h3></div>
          {proof.length === 0 ? (
            <p className="an-empty">No verified posts yet. Each post we confirm is live shows up here with its link.</p>
          ) : (
            <ul className="an-proof an-scroll" aria-label="Proof-of-Publish">
              {proof.map((p) => {
                const host = new URL(p.url).hostname.replace(/^www\./, "");
                const date = p.when ? new Date(p.when) : null;
                const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
                return (
                  <li key={p.id}>
                    <span className={`an-icon${monoClass(p.platform)}`}><PlatformIcon platform={p.platform} size={18} /></span>
                    <span className="an-proof-when">{when}</span>
                    <a href={p.url} target="_blank" rel="noopener noreferrer" aria-label={`Open the ${platformLabel(p.platform)} post on ${host}`}>{host}</a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
