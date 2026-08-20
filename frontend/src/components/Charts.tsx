import { useEffect, useId, useRef, useState } from "react";
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

// Catmull-Rom → cubic-Bezier smoothing (tension 1/6, the standard value) —
// turns a straight-segment polyline into a smooth curve through the same
// points, no external charting library needed for it.
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 3) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  }
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// KPI tile icons — small stroke-based glyphs (matches NotificationBell's
// convention: currentColor, thin strokes), one per stat kind. Not a full
// icon library — just the handful the KPI row actually needs.
// ---------------------------------------------------------------------------

function IconPosts({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </svg>
  );
}

function IconCheck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  );
}

function IconAlert({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12" y2="16.01" />
    </svg>
  );
}

function IconSpark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.8 5.6L19 10.5l-5.2 1.9L12 18l-1.8-5.6L5 10.5l5.2-1.9L12 3z" />
    </svg>
  );
}

function IconUsers({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 8.2c1.4.3 2.5 1.5 2.5 3s-1.1 2.7-2.5 3" />
      <path d="M19 19c0-2.3-1.5-4.1-3.5-4.8" />
    </svg>
  );
}

export const StatIcons = { posts: IconPosts, check: IconCheck, alert: IconAlert, spark: IconSpark, users: IconUsers };
export type StatIconKind = keyof typeof StatIcons;

// ---------------------------------------------------------------------------
// Stat tile / KPI row
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  delta,
  icon,
  accent = "#8b93a1",
}: {
  label: string;
  value: string;
  delta?: { text: string; good: boolean };
  icon?: StatIconKind;
  /** Hex color for the icon badge — a literal hex (not a CSS var) since the
   *  badge background is derived from it via alpha suffix (`${accent}22`). */
  accent?: string;
}) {
  const Icon = icon ? StatIcons[icon] : null;
  return (
    <div className="chart-stat-tile">
      {Icon && (
        <span className="chart-stat-icon" style={{ background: `${accent}22`, color: accent }}>
          <Icon size={16} />
        </span>
      )}
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

// Gradient from red (0%) → yellow (50%) → green (100%).
// background-size scales the gradient so it always spans the full track width
// regardless of how wide the fill div is — at 50% fill you see red→yellow,
// at 100% you see the full red→yellow→green arc.
const METER_GRADIENT = "linear-gradient(to right, #dc2626, #f59e0b 50%, #16a34a)";

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
        className="chart-meter-track"
        role="meter"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        style={{ background: "rgba(0,0,0,0.08)" }}
      >
        <div
          className="chart-meter-fill"
          style={{
            width: `${pct}%`,
            background: METER_GRADIENT,
            backgroundSize: pct > 0 ? `${(100 / pct) * 100}% 100%` : "100% 100%",
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status stacked bar — 6 segments, each a distinct color:
//   Verified live (confirmed by metrics poller) — green
//   Posted (sent but not yet checked) — blue
//   Failed — orange-red
//   Pending — neutral gray
//   DMs sent (via DM automations) — purple
//   Accounts connected — teal
// ---------------------------------------------------------------------------

export function StatusStackedBar({
  posted,
  verifiedLive = 0,
  failed,
  pending,
  dmCount = 0,
  accountsConnected = 0,
}: {
  posted: number;
  verifiedLive?: number;
  failed: number;
  pending: number;
  dmCount?: number;
  accountsConnected?: number;
}) {
  const postedOnly = Math.max(0, posted - verifiedLive);
  const total = verifiedLive + postedOnly + failed + pending + dmCount + accountsConnected;
  if (total === 0) return null;
  const segments = [
    { key: "verified", label: "Verified live", count: verifiedLive, color: "#16a34a" },
    { key: "posted", label: "Posted", count: postedOnly, color: "#3b82f6" },
    { key: "failed", label: "Failed", count: failed, color: "#f97316" },
    { key: "pending", label: "Pending", count: pending, color: "#9ca3af" },
    { key: "dm", label: "DMs sent", count: dmCount, color: "#8b5cf6" },
    { key: "accounts", label: "Accounts connected", count: accountsConnected, color: "#0d9488" },
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
              style={{ width: `${pct}%`, background: s.color }}
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
            <span className="chart-legend-swatch" style={{ background: s.color }} />
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
  const gradientId = useId();
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

  const linePath = smoothPath(points);
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
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="chart-trend-gradient-start" />
            <stop offset="100%" className="chart-trend-gradient-end" />
          </linearGradient>
        </defs>
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
        <path d={areaPath} className="chart-trend-area" fill={`url(#${gradientId})`} />
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
// Multi-series trend line — one colored line per platform sharing one day
// axis, for "how does daily volume break down by platform" (2026-08-20,
// Werner's own ask after the single combined-total line). Real brand colors,
// a legend, and a combined tooltip listing every platform's value for the
// hovered day at once, matching the reference reporting dashboards he sent.
// ---------------------------------------------------------------------------

export function MultiTrendLine({ countsByPlatform }: { countsByPlatform: Record<string, Record<string, number>> }) {
  const dark = usePrefersDark();
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

  const platforms = resolveColorCollisions(
    Object.keys(countsByPlatform)
      .map((platform) => ({ platform, total: Object.values(countsByPlatform[platform]).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total)
  );

  // One shared day axis, unioned across every platform — a platform with no
  // post on a given day is a real 0 on that day, not an absent point, so
  // every line spans the same x-range instead of drifting independently.
  const allDays = [...new Set(platforms.flatMap((p) => Object.keys(countsByPlatform[p.platform])))].sort((a, b) =>
    a.localeCompare(b)
  );

  if (allDays.length === 0 || platforms.length === 0) return null;

  const width = 640;
  const height = 200;
  const padY = 16;
  const padXLeft = 34;
  const plotWidth = width - padXLeft;
  const rawMax = Math.max(...platforms.flatMap((p) => allDays.map((d) => countsByPlatform[p.platform][d] ?? 0)), 1);
  const max = niceCeiling(rawMax);
  const stepX = allDays.length > 1 ? plotWidth / (allDays.length - 1) : 0;

  const xAt = (i: number) => padXLeft + (allDays.length > 1 ? i * stepX : plotWidth / 2);
  const yAt = (count: number) => padY + (1 - count / max) * (height - padY * 2);

  const series = platforms.map((p) => {
    const color = barColor(p.platform, dark);
    const points = allDays.map((day, i) => ({ x: xAt(i), y: yAt(countsByPlatform[p.platform][day] ?? 0), count: countsByPlatform[p.platform][day] ?? 0 }));
    return { platform: p.platform, color, points };
  });

  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let nearestDist = Infinity;
    allDays.forEach((_, i) => {
      const dist = Math.abs(xAt(i) - relX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  return (
    <div className="chart-trend-line">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="chart-trend-svg"
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIndex(null)}
        role="img"
        aria-label={`Daily post volume by platform, ${allDays[0]} to ${allDays[allDays.length - 1]}`}
      >
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
        {hoverIndex !== null && (
          <line x1={xAt(hoverIndex)} x2={xAt(hoverIndex)} y1={0} y2={height} className="chart-trend-crosshair" />
        )}
        {series.map((s, i) => (
          <path
            key={s.platform}
            d={smoothPath(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={reduceMotion ? "" : "chart-trend-line-animated"}
            style={reduceMotion ? undefined : { animationDelay: `${i * 60}ms` }}
          />
        ))}
        {series.map((s) => {
          const p = hoverIndex !== null ? s.points[hoverIndex] : s.points[s.points.length - 1];
          return <circle key={s.platform} cx={p.x} cy={p.y} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="1.5" />;
        })}
      </svg>
      <div className="chart-trend-labels">
        <span>{allDays[0].slice(5)}</span>
        <span>{allDays[allDays.length - 1].slice(5)}</span>
      </div>
      <div className="chart-multitrend-legend">
        {series.map((s) => (
          <span key={s.platform} className="chart-multitrend-legend-item">
            <PlatformIcon platform={s.platform} size={12} />
            {s.platform}
          </span>
        ))}
      </div>
      {hoverIndex !== null && (
        <div
          className="chart-trend-tooltip chart-multitrend-tooltip"
          style={{ left: `${(xAt(hoverIndex) / width) * 100}%` }}
        >
          <span className="chart-trend-tooltip-date">{allDays[hoverIndex]}</span>
          {series.map((s) => (
            <span key={s.platform} className="chart-multitrend-tooltip-row">
              <span className="chart-legend-swatch" style={{ background: s.color }} />
              {s.platform} <strong>{s.points[hoverIndex].count}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — a compact, non-interactive trend line for a value inline in a
// table row or small card (e.g. one platform's follower count over time).
// No axes/gridlines/tooltip — the exact numbers already sit next to it.
// ---------------------------------------------------------------------------

export function Sparkline({ data, color = "#8b93a1" }: { data: { value: number }[]; color?: string }) {
  const gradientId = useId();
  if (data.length < 2) return null;

  const width = 120;
  const height = 32;
  const pad = 3;
  const min = Math.min(...data.map((d) => d.value));
  const max = Math.max(...data.map((d) => d.value));
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);

  const points = data.map((d, i) => ({
    x: pad + i * stepX,
    y: pad + (1 - (d.value - min) / range) * (height - pad * 2),
  }));
  const linePath = smoothPath(points);
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${height} L ${points[0].x.toFixed(2)} ${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="chart-sparkline" role="img" aria-label="Trend over time">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="2.5" fill={color} />
    </svg>
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
        <p className="empty">No posts scheduled in the last 30 days yet. Your overview fills in once posts go out.</p>
      )}
      {analytics && analytics.totalPosts > 0 && (
        <>
          {(() => {
            // Likes + comments + shares only — views is a different unit
            // (reach, not interaction) and mixing it into one sum would
            // misrepresent both numbers. "—" when the map is empty, not
            // "0": that's "no coverage yet" (checkpoints not due, or every
            // connected platform is one of the 7 without read support),
            // never "confirmed zero engagement."
            const platformsWithData = Object.values(analytics.engagement);
            const totalEngagement = platformsWithData.reduce((sum, e) => sum + e.likes + e.comments + e.shares, 0);
            return (
              <KpiRow>
                <StatTile label="Total posts" value={formatCompact(analytics.totalPosts)} icon="posts" accent="#3b82f6" />
                <StatTile label="Failed" value={formatCompact(analytics.byStatus.failed ?? 0)} icon="alert" accent="#f97316" />
                <StatTile
                  label="Verified live"
                  value={analytics.verifiedLiveRate === null ? "—" : `${Math.round(analytics.verifiedLiveRate * 100)}%`}
                  icon="check"
                  accent="#16a34a"
                />
                <StatTile
                  label="Total engagement"
                  value={platformsWithData.length > 0 ? formatCompact(totalEngagement) : "—"}
                  icon="spark"
                  accent="#8b5cf6"
                />
              </KpiRow>
            );
          })()}

          {analytics.verifiedLiveRate !== null && (
            <div className="chart-section">
              <Meter label="Verified-live rate" value={Math.round(analytics.verifiedLiveRate * 100)} />
            </div>
          )}

          <div className="chart-section">
            <h3>Post status</h3>
            <StatusStackedBar
              posted={analytics.byStatus.posted ?? 0}
              verifiedLive={Object.values(analytics.byPlatform).reduce((sum, s) => sum + s.verifiedLive, 0)}
              failed={analytics.byStatus.failed ?? 0}
              pending={(analytics.byStatus.pending ?? 0) + (analytics.byStatus.posting ?? 0) + (analytics.byStatus.needs_approval ?? 0)}
              dmCount={analytics.dmCount ?? 0}
              accountsConnected={analytics.accountsConnected ?? 0}
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
