// The Connections workspace (ported from the approved single-screen staging design): a map of the 19 platforms for the selected brand, a health
// summary and the integrations. It is a map, not a connect flow: every tile and the "Manage connections" button hand over to the Social Platforms
// tab, which owns all OAuth and credential handling. Presentational: the parent supplies the data and the hand-over.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import { channelStates } from "../../lib/postingChannels";
import { connectionSummary, integrationStates, tileText, type IntegrationState } from "../../lib/connectionsModel";
import "./ConnectionsWorkspace.css";

type GoogleStatus = { last_synced_at?: string | null } | null | undefined;
interface Props {
  accounts: SocialAccount[];
  brands: Brand[];
  posts: ScheduledPost[];
  /** Same sentinel as the dashboard: undefined = not checked yet, null = not connected, object = connected. */
  gcalStatus: GoogleStatus;
  gsheetStatus: GoogleStatus;
  /** When given, tiles and the header button hand over to the Social Platforms page; omitted, they are plain display. */
  onOpenSocialPlatforms?: () => void;
}

// These brand colours fall in the hue family the Midnight Canvas palette bans, so their icons are drawn in slate instead.
const MONO_ICONS = new Set(["mastodon", "discord", "slack", "nostr"]);
const ALL = "";

function formatSynced(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function integrationText(i: IntegrationState): string {
  switch (i.state) {
    case "checking": return "Checking";
    case "not-connected": return "Not connected";
    case "needs-reconnect": return "Needs reconnecting";
    default: {
      const synced = formatSynced(i.lastSyncedAt);
      if (i.detail) return `Connected, ${i.detail}`;
      return synced ? `Connected, last synced ${synced}` : "Connected";
    }
  }
}

export function ConnectionsWorkspace({ accounts, brands, posts, gcalStatus, gsheetStatus, onOpenSocialPlatforms }: Props) {
  const brandNames = useMemo(() => brands.map((b) => b.name).sort((a, b) => a.localeCompare(b)), [brands]);
  const [brand, setBrand] = useState<string>(ALL);
  const activeBrand = brand === ALL || brandNames.includes(brand) ? brand : ALL;
  const states = useMemo(() => channelStates(accounts, activeBrand), [accounts, activeBrand]);
  const summary = useMemo(() => connectionSummary(accounts, posts, activeBrand), [accounts, posts, activeBrand]);
  const integrations = useMemo(() => integrationStates({ gcal: gcalStatus, gsheet: gsheetStatus, accounts }), [gcalStatus, gsheetStatus, accounts]);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  function openTile(id: string) {
    const s = states.find((x) => x.id === id);
    if (!onOpenSocialPlatforms) return;
    if (s && !s.connected) flash(`Open Social Platforms to connect ${s.label}`);
    onOpenSocialPlatforms();
  }

  return (
    <div className="cn-root">
      <header className="cn-header">
        <h2>Connections</h2>
        <div className="cn-switch" role="radiogroup" aria-label="Brand">
          {[ALL, ...brandNames].map((n) => {
            const label = n === ALL ? "All brands" : n;
            return (
              <label key={label} className={`cn-seg${activeBrand === n ? " cn-seg--on" : ""}`}>
                <input type="radio" name="cn-brand" aria-label={label} checked={activeBrand === n} onChange={() => setBrand(n)} />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
        {onOpenSocialPlatforms && <button type="button" className="cn-btn" onClick={onOpenSocialPlatforms}>Manage connections</button>}
      </header>

      <div className="cn-grid">
        <section className="cn-module cn-platforms" aria-label="Platforms">
          <div className="cn-head"><h3>Platforms</h3></div>
          {summary.accounts === 0 && <p className="cn-empty">No platforms connected yet. Pick one below to get started.</p>}
          <div className="cn-tiles">
            {states.map((s) => (
              <button
                key={s.id}
                type="button"
                data-testid={`cn-tile-${s.id}`}
                data-connected={s.connected ? "true" : "false"}
                className={`cn-tile${s.connected ? "" : " cn-tile--off"}${MONO_ICONS.has(s.id) ? " cn-tile--mono" : ""}`}
                onClick={() => openTile(s.id)}
              >
                <span className="cn-ico"><PlatformIcon platform={s.id} size={26} /></span>
                <b>{s.label}</b>
                <small>{tileText(s)}</small>
              </button>
            ))}
          </div>
        </section>

        <div className="cn-side">
          <section className="cn-module" aria-label="Connection health" data-testid="cn-health">
            <div className="cn-head"><h3>Connection health</h3></div>
            <div className="cn-stats">
              <div className="cn-stat"><small>Platforms connected</small><strong data-testid="cn-stat-platforms">{summary.connectedPlatforms} / {summary.totalPlatforms}</strong></div>
              <div className="cn-stat"><small>Accounts</small><strong data-testid="cn-stat-accounts">{summary.accounts.toLocaleString("en-US")}</strong></div>
              <div className="cn-stat"><small>Need reconnecting</small><strong data-testid="cn-stat-reconnect" className={summary.needReconnect > 0 ? "cn-warn" : ""}>{summary.needReconnect.toLocaleString("en-US")}</strong></div>
              <div className="cn-stat"><small>Paused queue</small><strong data-testid="cn-stat-paused" className={summary.pausedAccounts > 0 ? "cn-warn" : ""}>{summary.pausedAccounts.toLocaleString("en-US")}</strong></div>
            </div>
          </section>
          <section className="cn-module" aria-label="Integrations" data-testid="cn-integrations">
            <div className="cn-head"><h3>Integrations</h3></div>
            <ul className="cn-ints">
              {integrations.map((i) => (
                <li key={i.id} data-testid={`cn-int-${i.id}`} className={`cn-int cn-int--${i.state}`}>
                  <b>{i.label}</b>
                  <span>{integrationText(i)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      {notice && <div className="cn-toast" role="status">{notice}</div>}
    </div>
  );
}
