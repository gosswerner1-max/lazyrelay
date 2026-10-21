// The Posting workspace (ported from the approved single-screen staging design): one sliding row of channels, a composer, queue numbers and live
// previews. Presentational: the parent supplies accounts, brands and posts and decides what "save" and "schedule" do. The brand dropdown decides which
// channels are in colour (connected for that brand) and which sit at 35% (not connected). Nothing is sent until a button is pressed.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import { channelStates, queueStats, reconcileSelection, tightestLimit } from "../../lib/postingChannels";
import "./PostingWorkspace.css";

export interface DraftRequest {
  content: string;
  plannedAccountIds: string[];
}
export interface ScheduleRequest {
  content: string;
  accountIds: string[];
  scheduledFor: string;
}
interface Props {
  accounts: SocialAccount[];
  brands: Brand[];
  posts: ScheduledPost[];
  onSaveDraft: (draft: DraftRequest) => Promise<void>;
  onSchedule: (request: ScheduleRequest) => Promise<void>;
  /** Injected for tests; defaults to the real clock. */
  now?: Date;
}

// These brand colours are purple or violet, which the Midnight Canvas palette bans, so their icons are drawn in slate instead.
const MONO_ICONS = new Set(["mastodon", "discord", "slack", "nostr"]);
const MAX_PREVIEWS = 3;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function PostingWorkspace({ accounts, brands, posts, onSaveDraft, onSchedule, now }: Props) {
  const brandNames = useMemo(() => [...brands].map((b) => b.name).sort((a, b) => a.localeCompare(b)), [brands]);
  const [brand, setBrand] = useState<string>(brandNames[0] ?? "");
  const activeBrand = brandNames.includes(brand) || brand === "" ? brand : (brandNames[0] ?? "");
  const states = useMemo(() => channelStates(accounts, activeBrand), [accounts, activeBrand]);
  const [selected, setSelected] = useState<string[]>(() => reconcileSelection([], channelStates(accounts, brandNames[0] ?? ""), 3));
  const [caption, setCaption] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const brandId = useId();
  const captionId = useId();
  const dateId = useId();
  const timeId = useId();

  // Brand switch (or a connection change): rebuild the ticks from the new connected list. React's own pattern for adjusting state when an input changes,
  // done during render instead of in an effect so there is no extra paint with a wrong tick.
  const connectedKey = activeBrand + "|" + states.filter((s) => s.connected).map((s) => s.id).join(",");
  const [seenKey, setSeenKey] = useState(connectedKey);
  if (connectedKey !== seenKey) {
    setSeenKey(connectedKey);
    setSelected(reconcileSelection(selected, states));
  }

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // ----- slider -----
  const trackRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const updateArrows = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 2);
  }, []);
  useLayoutEffect(() => {
    updateArrows();
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateArrows, states]);
  function slide(direction: 1 | -1) {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.7), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  // ----- derived -----
  const tight = tightestLimit(selected);
  const over = tight ? caption.length > tight.limit : false;
  const stats = useMemo(() => queueStats(posts, accounts, activeBrand, now ?? new Date()), [posts, accounts, activeBrand, now]);
  const accountIds = useMemo(() => states.filter((s) => selected.includes(s.id)).flatMap((s) => s.accounts.map((a) => a.id)), [states, selected]);
  const canSend = caption.trim().length > 0 && accountIds.length > 0 && !busy;
  const previews = states.filter((s) => selected.includes(s.id)).slice(0, MAX_PREVIEWS);

  function toggle(id: string) {
    const s = states.find((x) => x.id === id);
    if (!s) return;
    if (!s.connected) {
      flash(`${s.label} is ${s.needsReconnect ? "not usable until you reconnect it" : "not connected"} for ${activeBrand || "these accounts"}. Click to Connect API.`);
      return;
    }
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setCaption("");
      flash(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  function saveDraft() {
    if (!canSend) return;
    void run(() => onSaveDraft({ content: caption, plannedAccountIds: accountIds }), "Draft saved.");
  }
  function schedule() {
    if (!canSend) return;
    if (!date || !time) {
      setError("Pick both a date and a time to schedule this post.");
      return;
    }
    void run(() => onSchedule({ content: caption, accountIds, scheduledFor: new Date(`${date}T${time}`).toISOString() }), "Post scheduled.");
  }

  return (
    <div className="pw-root">
      <div className="pw-grid">
        {/* ---------- composer ---------- */}
        <section className="pw-module pw-composer" aria-label="Composer">
          <div className="pw-head">
            <h2>Compose</h2>
            <label className="pw-brand" htmlFor={brandId}>
              <span className="pw-sr">Brand</span>
              <select id={brandId} value={activeBrand} onChange={(e) => setBrand(e.target.value)}>
                {brandNames.length === 0 && <option value="">All accounts</option>}
                {brandNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="pw-slider">
            <button type="button" className="pw-arrow" aria-label="Previous channels" disabled={atStart} onClick={() => slide(-1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
            </button>
            <div className="pw-track" ref={trackRef} data-testid="pw-track" role="group" aria-label="Channels" onScroll={updateArrows}>
              {states.map((s) => {
                const on = s.connected && selected.includes(s.id);
                const title = s.connected
                  ? s.label + (s.accounts.length > 1 ? ` (${s.accounts.length} accounts)` : "")
                  : s.needsReconnect
                    ? `${s.label} needs reconnecting. Click to Connect API`
                    : `${s.label} is not connected for ${activeBrand || "these accounts"}. Click to Connect API`;
                return (
                  <button
                    key={s.id}
                    type="button"
                    data-testid={`pw-chip-${s.id}`}
                    data-connected={s.connected ? "true" : "false"}
                    className={`pw-chip${s.connected ? "" : " pw-chip--off"}${MONO_ICONS.has(s.id) ? " pw-chip--mono" : ""}${on ? " pw-chip--on" : ""}`}
                    aria-pressed={on}
                    aria-disabled={s.connected ? undefined : true}
                    aria-label={s.label}
                    title={title}
                    onClick={() => toggle(s.id)}
                  >
                    <PlatformIcon platform={s.id} size={22} />
                  </button>
                );
              })}
            </div>
            <button type="button" className="pw-arrow" aria-label="Next channels" disabled={atEnd} onClick={() => slide(1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>

          <div className="pw-write">
            <label htmlFor={captionId} className="pw-sr">
              Caption
            </label>
            <textarea id={captionId} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Write the caption. Every preview on the right updates as you type." />
            <div className="pw-foot">
              <span>{caption.length} {caption.length === 1 ? "character" : "characters"}</span>
              <span data-testid="pw-limit" className={over ? "pw-over" : ""}>
                {tight ? `Shortest limit: ${tight.label} ${tight.limit.toLocaleString("en-US")}` : "Pick at least one channel"}
              </span>
            </div>
          </div>

          <div className="pw-when">
            <label htmlFor={dateId}>
              <span>Date</span>
              <input id={dateId} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label htmlFor={timeId}>
              <span>Time</span>
              <input id={timeId} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
          {error && <p className="pw-error" role="alert">{error}</p>}
          <div className="pw-actions">
            <button type="button" className="pw-btn pw-btn--ghost" disabled={!canSend} onClick={saveDraft}>Save draft</button>
            <button type="button" className="pw-btn" disabled={!canSend} onClick={schedule}>Schedule post</button>
          </div>
        </section>

        {/* ---------- queue and timing ---------- */}
        <section className="pw-module pw-metrics" aria-label="Queue and timing" data-testid="pw-metrics">
          <div className="pw-head"><h2>Queue &amp; timing</h2></div>
          <div className="pw-scroll">
            <div className="pw-stats">
              <div className="pw-stat"><small>In queue, paused</small><strong>{stats.paused.toLocaleString("en-US")}</strong></div>
              <div className="pw-stat"><small>Scheduled</small><strong>{stats.scheduled.toLocaleString("en-US")}</strong></div>
              <div className="pw-stat"><small>Published, 30 days</small><strong>{stats.published30d.toLocaleString("en-US")}</strong></div>
              <div className="pw-stat"><small>Drafts</small><strong>{stats.drafts.toLocaleString("en-US")}</strong></div>
            </div>
            {stats.paused > 0 && <p className="pw-hint">{stats.paused.toLocaleString("en-US")} queued posts are paused, so nothing in the queue publishes until they are resumed.</p>}
            <div className="pw-budget">
              <small>Caption budget for the ticked channels</small>
              <div className="pw-bar"><i className={over ? "pw-over" : ""} style={{ width: `${tight ? Math.min(100, (caption.length / tight.limit) * 100) : 0}%` }} /></div>
              <span>{tight ? `${caption.length.toLocaleString("en-US")} of ${tight.limit.toLocaleString("en-US")} (${tight.label})` : "No channel ticked"}</span>
            </div>
          </div>
        </section>

        {/* ---------- previews ---------- */}
        <section className="pw-module pw-previews" aria-label="Live previews" data-testid="pw-previews">
          <div className="pw-head"><h2>Live previews</h2></div>
          <div className="pw-scroll pw-pvlist">
            {previews.length === 0 && <p className="pw-empty">Tick a connected channel to preview your post.</p>}
            {previews.map((s) => (
              <article key={s.id} className="pw-pv">
                <header>
                  <span className={`pw-pvicon${MONO_ICONS.has(s.id) ? " pw-chip--mono" : ""}`}><PlatformIcon platform={s.id} size={20} /></span>
                  <div><b>{s.label}</b><small>{s.accounts[0]?.display_name ?? ""}</small></div>
                </header>
                <p className={caption ? "" : "pw-pv-empty"}>{caption || "Your caption appears here"}</p>
                <footer>
                  <span>{caption.length.toLocaleString("en-US")} / {s.limit.toLocaleString("en-US")}</span>
                  <span className={caption.length > s.limit ? "pw-over" : ""}>{caption.length > s.limit ? `Too long for ${s.label}` : "Fits"}</span>
                </footer>
              </article>
            ))}
          </div>
        </section>
      </div>
      {notice && <div className="pw-toast" role="status">{notice}</div>}
    </div>
  );
}
