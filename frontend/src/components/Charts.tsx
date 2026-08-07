import { useEffect, useRef, useState } from "react";
import { PlatformIcon, BRAND_COLORS } from "./PlatformIcon";
import type { AnalyticsSummary } from "../lib/api";
import { Spinner } from "./Spinner";

// Shared dark-mode detection. The rest of the app flips theme purely via the
// `prefers-color-scheme` CSS media query (see index.css) — no JS state
// needed for CSS-variable-driven colors. This hook exists only because a
// handful of *fixed* platform brand hexes (not CSS variables) need a
// different literal value in dark mode; see barColor() below.
function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

// TikTok, Threads, and X all brand as pure black — invisible against the
// dark-mode chart surface (#171a21). Every bar in this chart already carries
// a direct name label, so color is a recognition bonus, not the identifier;
// sharing one light-neutral substitute among the black-branded platforms in
// dark mode is an honest simplification, not a fake per-platform hue.
const DARK_MODE_BLACK_OVERRIDE = "#e8eaed";
function barColor(platform: string, dark: boolean): string {
  const brand = BRAND_COLORS[platform] ?? "#8b93a1";
  if (dark && brand.toLowerCase() === "#000000") return DARK_MODE_BLACK_OVERRIDE;
  return brand;
}

// Platform pairs whose brand colors read as visually identical even with
// normal color vision (validated via the dataviz skill's palette checker,
// not eyeballed) — kept apart in the sorted bar chart below regardless of
// how their post counts happen to rank on a given day.
const COLOR_COLLISION_PAIRS: [string, string][] = [["pinterest", "youtube"]];
function isCollisionPair(a: string, b: string): boolean {
  return COLOR_COLLISION_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}
function resolveColorCollisions<T extends { platform: string }>(items: T[]): T[] {
  const arr = [...items];
  for (let i = 0; i < arr.length - 1; i++) {
    if (!isCollisionPair(arr[i].platform, arr[i + 1].platform)) continue;
    if (i + 2 < arr.length) {
      [arr[i + 1], arr[i + 2]] = [arr[i + 2], arr[i + 1]];
    } else if (i - 1 >= 0) {
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    }
  }
  return arr;
}

// Rounds a data max up to a "clean" axis ceiling (2/4/5/10/20/25/50/100...)
// so y-axis ticks read as round numbers, per marks-and-anatomy.md's tick
// guidance, instead of an arbitrary top value like "7".
function niceCeiling(value: number): number {
  if (value <= 4) return 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const steps = [1, 2, 2.5, 5, 10];
  for (const step of steps) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Stat tile / KPI row
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: { text: string; good: boolean };
}) {
  return (
    <div className="chart-stat-tile">
      <span className="chart-stat-value">{value}</span>
      <span className="chart-stat-label">{label}</span>
      {delta && (
        <span className={`chart-stat-delta ${delta.good ? "chart-stat-delta-good" : "chart-stat-delta-bad"}`}>
          {delta.text}
        </span>
      )}
    </div>
  );
}

export function KpiRow({ children }: { children: React.ReactNode }) {
  return <div className="chart-kpi-row">{children}</div>;
}

// ---------------------------------------------------------------------------
// Meter — a ratio against a limit (never a pie of 2 slices)
// ---------------------------------------------------------------------------

// Meter fill carries severity (brand accent -> warning -> danger) rather than
// a single flat color — per the dataviz skill's own Meter spec. This also
// keeps the meter visually distinct from the status stacked bar below it:
// both used the same green before, which read as two copies of one bar when
// everything was healthy. A high rate now uses the brand accent (--signal),
// not --confirm, so a fully-healthy dashboard doesn't show identical greens.
function meterTier(pct: number): "good" | "warn" | "critical" {
  if (pct >= 90) return "good";
  if (pct >= 70) return "warn";
  return "critical";
}

export function Meter({
  label,
  value,
  max = 100,
  suffix = "%",
}: {
  label: string;
  value: number;
  max?: number;
  suffix?: string;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  const tier = meterTier(pct);
  return (
    <div className="chart-meter">
      <div className="chart-meter-head">
        <span className="chart-meter-label">{label}</span>
        <span className="chart-meter-value">
          {Math.round(value)}
          {suffix}
        </span>
      </div>
      <div
        className={`chart-meter-track chart-meter-track-${tier}`}
        role="meter"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div className={`chart-meter-fill chart-meter-fill-${tier}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status stacked bar — Posted / Failed / Pending, LazyRelay's own status
// colors (--confirm / --error), with a genuinely neutral gray (--wire) for
// "pending" rather than the brand accent (--signal) — validated: --signal
// and --error are both red-family and nearly indistinguishable even for
// normal color vision when placed adjacent to each other.
// ---------------------------------------------------------------------------

export function StatusStackedBar({ posted, failed, pending }: { posted: number; failed: number; pending: number }) {
  const total = posted + failed + pending;
  if (total === 0) return null;
  const segments = [
    { key: "posted", label: "Posted", count: posted, colorVar: "var(--confirm)" },
    { key: "failed", label: "Failed", count: failed, colorVar: "var(--error)" },
    { key: "pending", label: "Pending", count: pending, colorVar: "var(--wire)" },
  ].filter((s) => s.count > 0);

  return (
    <div className="chart-stacked-bar" role="img" aria-label={segments.map((s) => `${s.label}: ${s.count}`).join(", ")}>
      <div className="chart-stacked-bar-track">
        {segments.map((s) => {
          const pct = (s.count / total) * 100;
          const showInlineLabel = pct >= 14;
          return (
            <div
              key={s.key}
              className="chart-stacked-bar-segment"
              style={{ width: `${pct}%`, background: s.colorVar }}
              title={`${s.label}: ${s.count} (${Math.round(pct)}%)`}
              tabIndex={0}
              aria-label={`${s.label}: ${s.count}, ${Math.round(pct)}% of total`}
            >
              {showInlineLabel && <span className="chart-stacked-bar-inline-label">{s.count}</span>}
            </div>
          );
        })}
      </div>
      <div className="chart-stacked-bar-legend">
        {segments.map((s) => (
          <span key={s.key} className="chart-stacked-bar-legend-item">
            <span className="chart-legend-swatch" style={{ background: s.colorVar }} />
            {s.label} <strong>{s.count}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Posts-by-platform bar chart — real brand colors, direct labels (name +
// icon), never relies on a legend to decode 12 colors.
// ---------------------------------------------------------------------------

export function PlatformBarChart({ data }: { data: { platform: string; total: number }[] }) {
  const dark = usePrefersDark();
  const sorted = resolveColorCollisions([...data].sort((a, b) => b.total - a.total));
  const max = Math.max(...sorted.map((d) => d.total), 1);

  if (sorted.length === 0) return null;

  return (
    <div className="chart-platform-bars">
      {sorted.map((d) => {
        const pct = (d.total / max) * 100;
        const color = barColor(d.platform, dark);
        return (
          <div
            key={d.platform}
            className="chart-platform-bar-row"
            title={`${d.platform}: ${d.total} post${d.total === 1 ? "" : "s"}`}
            tabIndex={0}
            aria-label={`${d.platform}: ${d.total} posts`}
          >
            <span className="chart-platform-bar-name">
              <PlatformIcon platform={d.platform} size={14} />
              {d.platform}
            </span>
            <div className="chart-platform-bar-track">
              <div
                className="chart-platform-bar-fill"
                style={{ width: `${Math.max(pct, 3)}%`, background: color }}
              />
            </div>
            <span className="chart-platform-bar-value">{d.total}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily volume trend line — replaces the old CSS-bar hack. Single series,
// so no legend box (the title already says what's plotted); crosshair +
// per-point tooltip on hover/focus, reduced-motion respected.
// ---------------------------------------------------------------------------

export function TrendLine({ data }: { data: { day: string; count: number }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [reduceMotion, setReduceMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  if (data.length === 0) return null;

  const width = 640;
  const height = 180;
  const padY = 16;
  const padXLeft = 34; // reserves room for y-axis tick labels — see marks-and-anatomy.md: "keep [ticks] unless every value is labeled"
  const plotWidth = width - padXLeft;
  const rawMax = Math.max(...data.map((d) => d.count), 1);
  const max = niceCeiling(rawMax);
  const stepX = data.length > 1 ? plotWidth / (data.length - 1) : 0;

  const points = data.map((d, i) => ({
    x: padXLeft + (data.length > 1 ? i * stepX : plotWidth / 2),
    y: padY + (1 - d.count / max) * (height - padY * 2),
    ...d,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${height} L ${points[0].x.toFixed(2)} ${height} Z`;

  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - relX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div className="chart-trend-line" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="chart-trend-svg"
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIndex(null)}
        role="img"
        aria-label={`Daily post volume, ${data[0].day} to ${data[data.length - 1].day}`}
      >
        {/* recessive gridlines + their y-axis value labels — a reader
            shouldn't have to hover to know whether "the peak" means 8 or 80 */}
        {[0, 0.5, 1].map((f) => {
          const y = padY + f * (height - padY * 2);
          const value = Math.round(max * (1 - f));
          return (
            <g key={f}>
              <line x1={padXLeft} x2={width} y1={y} y2={y} className="chart-trend-gridline" />
              <text x={padXLeft - 8} y={y} textAnchor="end" dominantBaseline="middle" className="chart-trend-axis-label">
                {value}
              </text>
            </g>
          );
        })}
        <path d={areaPath} className="chart-trend-area" />
        <path d={linePath} className={`chart-trend-line-path${reduceMotion ? "" : " chart-trend-line-animated"}`} />
        {hovered && (
          <>
            <line x1={hovered.x} x2={hovered.x} y1={0} y2={height} className="chart-trend-crosshair" />
            <circle cx={hovered.x} cy={hovered.y} r={5} className="chart-trend-end-dot" />
          </>
        )}
        {/* always show the last point as the direct end-label anchor */}
        {!hovered && (
          <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={5} className="chart-trend-end-dot" />
        )}
      </svg>
      <div className="chart-trend-labels">
        <span>{data[0].day.slice(5)}</span>
        <span>{data[data.length - 1].day.slice(5)}</span>
      </div>
      {hovered && (
        <div
          className="chart-trend-tooltip"
          style={{ left: `${(hovered.x / width) * 100}%` }}
        >
          <strong>{hovered.count}</strong> post{hovered.count === 1 ? "" : "s"}
          <span className="chart-trend-tooltip-date">{hovered.day}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OverviewPanel — the full Overview tab content (2026-08-07 redesign),
// factored out of Dashboard.tsx so it has exactly one implementation instead
// of two that could drift: the real Dashboard renders it against live data,
// and a throwaway dev-only preview route (App.tsx, removed after visual
// verification) renders it against fixture data, since the local dev server
// can't reach an authenticated Supabase session to show the real thing.
// ---------------------------------------------------------------------------

export function OverviewPanel({ analytics, loading }: { analytics: AnalyticsSummary | null; loading: boolean }) {
  return (
    <section>
      <h2>Overview</h2>
      {loading && !analytics && <Spinner />}
      {!loading && analytics && analytics.totalPosts === 0 && (
        <p className="empty">No posts scheduled in the last 30 days yet — your overview fills in once posts go out.</p>
      )}
      {analytics && analytics.totalPosts > 0 && (
        <>
          <KpiRow>
            <StatTile label="Total posts" value={formatCompact(analytics.totalPosts)} />
            <StatTile label="Failed" value={formatCompact(analytics.byStatus.failed ?? 0)} />
            <StatTile
              label="Verified live"
              value={analytics.verifiedLiveRate === null ? "—" : `${Math.round(analytics.verifiedLiveRate * 100)}%`}
            />
          </KpiRow>

          {analytics.verifiedLiveRate !== null && (
            <div className="chart-section">
              <Meter label="Verified-live rate" value={Math.round(analytics.verifiedLiveRate * 100)} />
            </div>
          )}

          <div className="chart-section">
            <h3>Post status</h3>
            <StatusStackedBar
              posted={analytics.byStatus.posted ?? 0}
              failed={analytics.byStatus.failed ?? 0}
              pending={(analytics.byStatus.pending ?? 0) + (analytics.byStatus.posting ?? 0) + (analytics.byStatus.needs_approval ?? 0)}
            />
          </div>

          <div className="chart-section">
            <h3>Posts by platform</h3>
            <PlatformBarChart
              data={Object.entries(analytics.byPlatform).map(([platform, stats]) => ({ platform, total: stats.total }))}
            />
          </div>

          <div className="chart-section">
            <h3>Daily volume, last 30 days</h3>
            <TrendLine
              data={Object.entries(analytics.dailyCounts)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([day, count]) => ({ day, count }))}
            />
          </div>
        </>
      )}
    </section>
  );
}
