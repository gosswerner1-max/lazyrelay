// The Calendar workspace (ported from the approved single-screen design): an executive weekly grid and a compact monthly matrix, a Google Calendar
// sidebar with a vertical bar chart of posts per day that came from Google events, and a slide-out drawer for one post or one day. Presentational:
// the parent supplies posts, accounts, brands, the Google connection state and any tracked-link click totals. Nothing is sent or changed here.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bar, BarChart, Cell, Tooltip, XAxis } from "recharts";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import {
  MONO_ICON_PLATFORMS,
  PER_DAY_CARDS,
  brandColor,
  dayKeyOf,
  dayStats,
  dayTitle,
  googleSyncByDay,
  monthLabel,
  monthMatrix,
  postsByDay,
  shiftAnchor,
  weekDays,
  weekLabel,
} from "../../lib/calendarModel";
import "./CalendarWorkspace.css";

export interface GoogleCalendarState {
  state: "unknown" | "connected" | "disconnected";
  email?: string | null;
  lastSyncedAt?: string | null;
}
export interface LinkClickRow {
  code: string;
  destinationUrl: string;
  platform: string;
  brand: string;
  scheduledPostId: string | null;
  createdAt: string;
  clicks: number;
  lastClick: string | null;
}
interface Props {
  posts: ScheduledPost[];
  accounts: SocialAccount[];
  brands: Brand[];
  google: GoogleCalendarState;
  linkClicks: LinkClickRow[];
  onConnectGoogle: () => void;
  /** Injected for tests; defaults to the real clock. */
  now?: Date;
}

type View = "week" | "month";
type Selection = { kind: "post"; id: string } | { kind: "day"; day: string } | null;

const LABELS: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", linkedin: "LinkedIn", pinterest: "Pinterest", mastodon: "Mastodon", bluesky: "Bluesky", threads: "Threads", x: "X", telegram: "Telegram", discord: "Discord", wordpress: "WordPress", devto: "dev.to", hashnode: "Hashnode", lemmy: "Lemmy", slack: "Slack", tumblr: "Tumblr", whatsapp: "WhatsApp" };
const CHART_WIDTH = 224;
const CHART_HEIGHT = 150;

const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (iso: string | null) => (iso ? `${pad(new Date(iso).getHours())}:${pad(new Date(iso).getMinutes())}` : "");
const reduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function CalendarWorkspace({ posts, accounts, brands, google, linkClicks, onConnectGoogle, now }: Props) {
  const today = useMemo(() => now ?? new Date(), [now]);
  const todayKey = dayKeyOf(today);
  const brandNames = useMemo(() => [...brands].map((b) => b.name).sort((a, b) => a.localeCompare(b)), [brands]);
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Date>(today);
  const [brand, setBrand] = useState("");
  const [sel, setSel] = useState<Selection>(null);
  const brandId = useId();
  const lastTrigger = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const byDay = useMemo(() => postsByDay(posts, accounts, brand), [posts, accounts, brand]);
  const accountOf = (p: ScheduledPost) => accounts.find((a) => a.id === p.social_account_id);
  const postsById = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);

  const days = view === "week" ? weekDays(anchor) : monthMatrix(anchor);
  const weekKeys = weekDays(anchor);
  const sync = googleSyncByDay(postsByDay(posts, accounts, ""), weekKeys);
  const syncTotal = sync.reduce((s, x) => s + x.count, 0);
  const googleAll = posts.filter((p) => !!p.google_event_id).length;

  function close() {
    setSel(null);
    const t = lastTrigger.current;
    if (t && document.body.contains(t)) t.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    drawerRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKey);
    // close() only reads refs and sets state, so it is safe to leave out of the dependency list.
  }, [sel]);

  function open(next: Selection, trigger: HTMLElement) {
    lastTrigger.current = trigger;
    setSel(next);
  }
  const post = sel?.kind === "post" ? postsById.get(sel.id) : undefined;
  const dayKey = sel?.kind === "day" ? sel.day : null;

  function statusText(p: ScheduledPost): string {
    if (p.status === "posted") return "Published and verified live";
    if (p.status === "failed") return "Failed";
    if (p.status === "draft") return "Draft";
    if (p.status === "pending" && p.paused_at) return "Paused in the queue";
    return "Scheduled";
  }
  const dot = (p: ScheduledPost) => (p.status === "posted" ? "cw-st--pub" : p.status === "failed" ? "cw-st--bad" : p.paused_at ? "cw-st--pau" : "cw-st--sch");

  // ---------- weekly grid ----------
  const weekGrid = (
    <div className="cw-week">
      {weekKeys.map((key) => {
        const list = byDay.get(key) ?? [];
        const shown = list.slice(0, PER_DAY_CARDS);
        const rest = list.length - shown.length;
        return (
          <div key={key} className={`cw-day${key === todayKey ? " cw-day--today" : ""}`} data-testid={`cw-day-${key}`} aria-current={key === todayKey ? "date" : undefined}>
            <div className="cw-dayhead">
              <b>{dayTitle(key)}</b>
              <span title={`${list.length} posts`}>{list.length}</span>
            </div>
            <div className="cw-cards">
              {shown.map((p) => {
                const a = accountOf(p);
                const platform = a?.platform ?? "";
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`cw-card-${p.id}`}
                    className={`cw-card${sel?.kind === "post" && sel.id === p.id ? " cw-card--sel" : ""}`}
                    aria-label={`${LABELS[platform] ?? platform} at ${timeOf(p.scheduled_for) || "no time"}, ${statusText(p)}. Open details`}
                    onClick={(e) => open({ kind: "post", id: p.id }, e.currentTarget)}
                  >
                    <span className="cw-ctop">
                      <span className={`cw-ico${MONO_ICON_PLATFORMS.has(platform) ? " cw-ico--mono" : ""}`}><PlatformIcon platform={platform} size={18} /></span>
                      <time>{timeOf(p.scheduled_for)}</time>
                      {p.google_event_id && <i className="cw-g" title="From a Google Calendar event" aria-hidden="true">G</i>}
                      <i className="cw-bd" style={{ background: brandColor(a?.brand_label, brandNames) }} title={a?.brand_label ?? ""} />
                      <i className={`cw-st ${dot(p)}`} aria-hidden="true" />
                    </span>
                    <span className="cw-text">{p.content}</span>
                  </button>
                );
              })}
              {rest > 0 && (
                <button type="button" className="cw-more" onClick={(e) => open({ kind: "day", day: key }, e.currentTarget)}>
                  {`+${rest} more`}
                </button>
              )}
              {list.length === 0 && <p className="cw-none">Nothing scheduled</p>}
            </div>
          </div>
        );
      })}
    </div>
  );

  // ---------- monthly matrix ----------
  const monthGrid = (
    <div className="cw-month">
      <div className="cw-dows">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="cw-cells" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))` }}>
        {days.map((key) => {
          const list = byDay.get(key) ?? [];
          const st = dayStats(list);
          const inMonth = key.slice(0, 7) === dayKeyOf(anchor).slice(0, 7);
          const total = st.total || 1;
          return (
            <button
              key={key}
              type="button"
              data-testid={`cw-cell-${key}`}
              aria-current={key === todayKey ? "date" : undefined}
              className={`cw-cell${inMonth ? "" : " cw-cell--out"}${key === todayKey ? " cw-cell--today" : ""}${sel?.kind === "day" && sel.day === key ? " cw-cell--sel" : ""}`}
              aria-label={`${dayTitle(key)}: ${st.total} posts. Open details`}
              onClick={(e) => open({ kind: "day", day: key }, e.currentTarget)}
            >
              <span className="cw-cnum">{Number(key.slice(8))}</span>
              {st.total > 0 ? (
                <>
                  <span className="cw-ccount">{st.total}<small>{st.published ? `${st.published} live` : ""}{st.published && st.paused ? " · " : ""}{st.paused ? `${st.paused} paused` : ""}</small></span>
                  <span className="cw-cbars" aria-hidden="true"><i className="cw-cb-pub" style={{ width: `${(st.published / total) * 100}%` }} /><i className="cw-cb-pau" style={{ width: `${(st.paused / total) * 100}%` }} /><i className="cw-cb-sch" style={{ width: `${(st.scheduled / total) * 100}%` }} /></span>
                </>
              ) : (
                <span className="cw-cnone">None</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  // ---------- Google sidebar ----------
  const off = google.state !== "connected";
  const chartData = sync.map((s, i) => ({ day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i], key: s.day, count: s.count }));
  const side = (
    <aside className={`cw-side${off ? " cw-side--off" : ""}`} aria-label="Google Calendar">
      <div className="cw-sidehead">
        <span className="cw-gico" aria-hidden="true">G</span>
        <div>
          <b>Google Calendar</b>
          {google.state === "connected" && <small>{google.email ? `${google.email}` : ""}{google.lastSyncedAt ? ` · synced ${timeOf(google.lastSyncedAt)}` : ""}</small>}
          {google.state === "unknown" && <small>Checking the connection</small>}
        </div>
      </div>
      {google.state === "connected" && <div className="cw-pills"><span className="cw-pill cw-pill--ok">Connected</span></div>}
      {google.state === "disconnected" && (
        <button type="button" className="cw-connect" onClick={onConnectGoogle}>Click to Connect API</button>
      )}
      <div className="cw-chartbox">
        <small className="cw-cap">Posts per day from Google Calendar</small>
        <figure className="cw-chart">
          <div role="img" aria-label={`Posts per day from Google Calendar this week: ${chartData.map((d) => `${d.day} ${d.count}`).join(", ")}`}>
            <BarChart width={CHART_WIDTH} height={CHART_HEIGHT} data={chartData} margin={{ top: 6, right: 2, left: 2, bottom: 0 }} barCategoryGap={6}>
              <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: "#94a3b8", fontSize: 11 }} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,.06)" }} contentStyle={{ background: "#0b0f19", border: 0, borderRadius: 12, color: "#fff" }} />
              <Bar
                dataKey="count"
                name="From Google Calendar"
                radius={[6, 6, 0, 0]}
                isAnimationActive={!reduced()}
                animationDuration={500}
                shape={(p: { x?: number; y?: number; width?: number; height?: number; payload?: { key: string } }) => (
                  <rect data-testid={`cw-bar-${p.payload?.key}`} x={p.x} y={p.y} width={p.width} height={Math.max(p.height ?? 0, 2)} rx={6} fill={p.payload?.key === todayKey ? "#ff5630" : "#4285f4"} />
                )}
              >
                {chartData.map((d) => <Cell key={d.key} />)}
              </Bar>
            </BarChart>
          </div>
        </figure>
      </div>
      <div className="cw-nums">
        <div><strong data-testid="cw-google-week">{syncTotal.toLocaleString("en-US")}</strong><small>posts this week from Google events</small></div>
        <div><strong>{googleAll.toLocaleString("en-US")}</strong><small>posts created from Google events</small></div>
      </div>
    </aside>
  );

  // ---------- drawer ----------
  const clicksFor = post ? linkClicks.filter((l) => l.scheduledPostId === post.id) : [];
  const drawerOpen = sel !== null;
  const drawerLabel = sel?.kind === "day" ? "Day details" : "Post details";
  const dayPosts = dayKey ? byDay.get(dayKey) ?? [] : [];
  const dstats = dayStats(dayPosts);
  const drawer = (
    <aside ref={drawerRef} className="cw-drawer" role="dialog" aria-label={drawerLabel} aria-hidden={!drawerOpen} data-open={drawerOpen ? "true" : "false"} tabIndex={-1}>
      <div className="cw-dhead">
        <div>
          {post && <><b>{LABELS[accountOf(post)?.platform ?? ""] ?? "Post"}</b><small>{accountOf(post)?.brand_label ?? ""}{post.scheduled_for ? ` · ${dayTitle(dayKeyOf(new Date(post.scheduled_for)))} · ${timeOf(post.scheduled_for)}` : ""}</small></>}
          {dayKey && <><b>{dayTitle(dayKey)}</b><small>{dstats.total} posts</small></>}
        </div>
        <button type="button" className="cw-close" aria-label="Close details" onClick={close}>&times;</button>
      </div>
      <div className="cw-dbody">
        {post && (
          <>
            <div className="cw-chips">
              <span className={`cw-chip ${post.status === "posted" ? "cw-chip--pub" : post.status === "failed" ? "cw-chip--bad" : "cw-chip--pau"}`}>{statusText(post)}</span>
              {post.google_event_id && <span className="cw-chip cw-chip--g">From a Google Calendar event</span>}
            </div>
            <section><h3>Post text</h3><div className="cw-dtext">{post.content}</div></section>
            <section>
              <h3>Raw click history</h3>
              {clicksFor.length === 0 ? (
                <div className="cw-dclicks"><b>0 clicks</b><span>This post carries no tracked link yet. Once a tracked link is added, its clicks are listed here.</span></div>
              ) : (
                clicksFor.map((l) => (
                  <div className="cw-dclicks" key={l.code}>
                    <b>{`${l.clicks} ${l.clicks === 1 ? "click" : "clicks"}`}</b>
                    <span>{l.destinationUrl.replace(/^https?:\/\//, "")}</span>
                    {l.lastClick && <span>{`Last click ${dayTitle(dayKeyOf(new Date(l.lastClick)))} ${timeOf(l.lastClick)}`}</span>}
                  </div>
                ))
              )}
            </section>
          </>
        )}
        {dayKey && (
          <>
            <div className="cw-dstats">
              <div><small>Published</small><strong>{dstats.published}</strong></div>
              <div><small>Paused in queue</small><strong>{dstats.paused}</strong></div>
              <div><small>Scheduled</small><strong>{dstats.scheduled}</strong></div>
              <div><small>Failed</small><strong>{dstats.failed}</strong></div>
            </div>
            <section>
              <h3>Posts this day</h3>
              <div className="cw-dlist">
                {dayPosts.map((p) => (
                  <button key={p.id} type="button" className="cw-dlistitem" onClick={(e) => open({ kind: "post", id: p.id }, e.currentTarget)}>
                    <b>{timeOf(p.scheduled_for) || "No time"} · {LABELS[accountOf(p)?.platform ?? ""] ?? "Post"}</b>
                    <span>{p.content}</span>
                  </button>
                ))}
                {dayPosts.length === 0 && <p className="cw-none">Nothing scheduled</p>}
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className="cw-root">
      <div className="cw-bar">
        <div className="cw-title">
          <h2>Calendar</h2>
          <span className="cw-range">{view === "week" ? weekLabel(anchor) : monthLabel(anchor)}</span>
        </div>
        <div className="cw-tools">
          <button type="button" className="cw-nav" aria-label={view === "week" ? "Previous week" : "Previous month"} onClick={() => setAnchor((a) => shiftAnchor(a, view, -1))}>&lsaquo;</button>
          <button type="button" className="cw-today" onClick={() => setAnchor(today)}>Today</button>
          <button type="button" className="cw-nav" aria-label={view === "week" ? "Next week" : "Next month"} onClick={() => setAnchor((a) => shiftAnchor(a, view, 1))}>&rsaquo;</button>
          <label className="cw-brand" htmlFor={brandId}>
            <span className="cw-sr">Brand</span>
            <select id={brandId} value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">All brands</option>
              {brandNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="cw-seg" role="group" aria-label="Calendar view">
            <button type="button" className={view === "week" ? "cw-on" : ""} aria-pressed={view === "week"} onClick={() => { setView("week"); setSel(null); }}>Weekly grid</button>
            <button type="button" className={view === "month" ? "cw-on" : ""} aria-pressed={view === "month"} onClick={() => { setView("month"); setSel(null); }}>Monthly matrix</button>
          </div>
        </div>
      </div>
      <div className="cw-body">
        <section className="cw-grid" aria-label="Calendar">{view === "week" ? weekGrid : monthGrid}</section>
        {side}
      </div>
      {drawer}
    </div>
  );
}
