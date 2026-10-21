// The Brands workspace (ported from the approved single-screen staging design): one card per brand on the left; on the right the selected brand's
// numbers, its AI-caption voice, its connected channels and a 30-day chart. Presentational: the parent supplies the data and decides what saving does.
// Brand creation and account assignment stay in the Social Platforms tab. Nothing is sent until the Save button is pressed.

import { useId, useMemo, useRef, useState, useEffect, useCallback } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip } from "recharts";
import type { Brand, BrandCapacity, ScheduledPost, SocialAccount } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import { brandCards, brandCountLabel, publishedPerDay } from "../../lib/brandsModel";
import { channelStates, queueStats } from "../../lib/postingChannels";
import "./BrandsWorkspace.css";

interface Props {
  accounts: SocialAccount[];
  brands: Brand[];
  posts: ScheduledPost[];
  /** Plan limit for brands; when missing, the "n of cap" line is simply not shown. */
  brandCapacity?: BrandCapacity | null;
  /** Saves the brand's AI-caption voice (null clears it). Throws on failure; the message is shown and the draft stays. */
  onSaveVoice: (brandId: string, brandName: string, voice: string | null) => Promise<void>;
  /** Opens the Social Platforms tab, which owns brand creation and account assignment. */
  onOpenSocialPlatforms: () => void;
  /** Injected for tests; defaults to the real clock. */
  now?: Date;
}

// These brand colours fall in the hue family the Midnight Canvas palette bans, so their icons are drawn in slate instead.
const MONO_ICONS = new Set(["mastodon", "discord", "slack", "nostr"]);
const VOICE_MAX = 2000;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function BrandsWorkspace({ accounts, brands, posts, brandCapacity, onSaveVoice, onOpenSocialPlatforms, now }: Props) {
  const [selectedId, setSelectedId] = useState<string>(brands[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceId = useId();

  const cards = useMemo(() => brandCards(brands, accounts), [brands, accounts]);
  const active = brands.find((b) => b.id === selectedId) ?? brands[0] ?? null;
  // Re-read the clock whenever the posts are refreshed, not on every keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clock = useMemo(() => now ?? new Date(), [now, posts]);
  const activeName = active?.name ?? "";
  const states = useMemo(() => channelStates(accounts, activeName), [accounts, activeName]);
  const stats = useMemo(() => queueStats(posts, accounts, activeName, clock), [posts, accounts, activeName, clock]);
  const days = useMemo(() => publishedPerDay(posts, accounts, activeName, clock), [posts, accounts, activeName, clock]);
  const total = days.reduce((sum, d) => sum + d.count, 0);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  if (!active) {
    return (
      <div className="bp-root">
        <section className="bp-module bp-empty" aria-label="Brands">
          <div className="bp-head"><h2>Brands</h2></div>
          <p className="bp-empty-title">No brand yet</p>
          <p className="bp-empty-text">A brand groups your social accounts, so each business or client keeps its own channels, numbers and writing voice. Create one and assign your accounts to it in Social Platforms.</p>
          <button type="button" className="bp-btn" onClick={onOpenSocialPlatforms}>Open Social Platforms</button>
        </section>
      </div>
    );
  }

  const saved = active.voice_profile ?? "";
  const draft = drafts[active.id] ?? saved;
  const dirty = draft.trim() !== saved.trim();
  const countLabel = brandCountLabel(brands.length, brandCapacity);
  const activeCard = cards.find((c) => c.brand.id === active.id);
  const busiest = days.reduce((a, b) => (b.count > a.count ? b : a), days[0]);
  const chartLabel = `Published posts per day, last 30 days: ${plural(total, "post", "posts")}${total > 0 ? `, busiest day ${busiest.date} with ${busiest.count}` : ""}`;

  function select(id: string) {
    setSelectedId(id);
    setError(null);
  }
  async function save() {
    if (!active || !dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSaveVoice(active.id, active.name, draft.trim() || null);
      flash("Voice saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bp-root">
      <div className="bp-grid">
        {/* ---------- brand cards ---------- */}
        <section className="bp-module" aria-label="Brands">
          <div className="bp-head">
            <h2>Brands</h2>
            {countLabel && <span className="bp-chip">{countLabel}</span>}
          </div>
          <div className="bp-cards">
            {cards.map((c) => (
              <button
                key={c.brand.id}
                type="button"
                data-testid={`bp-card-${c.brand.name}`}
                className={`bp-card${c.brand.id === active.id ? " bp-card--on" : ""}`}
                aria-pressed={c.brand.id === active.id}
                onClick={() => select(c.brand.id)}
              >
                <span className="bp-card-title"><i style={{ background: c.color }} aria-hidden="true" /><b>{c.brand.name}</b></span>
                <span className="bp-card-meta">
                  <span><b>{c.accountCount.toLocaleString("en-US")}</b> {c.accountCount === 1 ? "account" : "accounts"}</span>
                  <span><b>{c.channelCount.toLocaleString("en-US")}</b> {c.channelCount === 1 ? "channel" : "channels"}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* ---------- selected brand ---------- */}
        <section className="bp-module" aria-label="Brand workspace">
          <div className="bp-head">
            <h2>{active.name}</h2>
            {activeCard && <span className="bp-chip">{plural(activeCard.accountCount, "account", "accounts")} on {plural(activeCard.channelCount, "channel", "channels")}</span>}
          </div>
          <div className="bp-work">
            <div className="bp-stat" data-testid="bp-stat-published"><small>Published, 30 days</small><strong>{stats.published30d.toLocaleString("en-US")}</strong></div>
            <div className="bp-stat" data-testid="bp-stat-paused"><small>Paused in queue</small><strong>{stats.paused.toLocaleString("en-US")}</strong></div>

            <div className="bp-voice">
              <label htmlFor={voiceId}>Brand voice</label>
              <textarea
                id={voiceId}
                value={draft}
                maxLength={VOICE_MAX}
                placeholder="No voice set for this brand yet. Describe the tone once and AI captions will follow it."
                onChange={(e) => { setDrafts((prev) => ({ ...prev, [active.id]: e.target.value })); setError(null); }}
              />
              <div className="bp-voice-foot">
                <span className="bp-voice-msg">
                  {error ? <span className="bp-error" role="alert">{error}</span> : notice ? <span role="status">{notice}</span> : null}
                </span>
                <button type="button" className="bp-btn" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "Saving" : "Save voice"}</button>
              </div>
            </div>

            <div className="bp-lower">
              <div>
                <span className="bp-cap">Connected channels</span>
                <div className="bp-channels">
                  {states.filter((s) => s.id !== "whatsapp" || s.connected).map((s) => (
                    <span
                      key={s.id}
                      data-testid={`bp-channel-${s.id}`}
                      data-connected={s.connected ? "true" : "false"}
                      className={`bp-ch${s.connected ? "" : " bp-ch--off"}${MONO_ICONS.has(s.id) ? " bp-ch--mono" : ""}`}
                      title={`${s.label} ${s.connected ? "connected" : s.needsReconnect ? "needs reconnecting" : "not connected"}`}
                    >
                      <PlatformIcon platform={s.id} size={19} />
                      <span className="bp-sr">{s.label} {s.connected ? "connected" : "not connected"}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="bp-chart-box">
                <span className="bp-cap">Published per day, last 30 days</span>
                <div className="bp-chart" role="img" aria-label={chartLabel}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={days} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
                      <Tooltip
                        cursor={{ fill: "rgba(255,255,255,0.06)" }}
                        contentStyle={{ background: "#0b0f19", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, color: "#fff" }}
                        formatter={(value) => [plural(Number(value), "post", "posts"), "Published"]}
                        labelFormatter={(label) => String(label)}
                      />
                      <Bar dataKey="count" fill="#ff5630" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
