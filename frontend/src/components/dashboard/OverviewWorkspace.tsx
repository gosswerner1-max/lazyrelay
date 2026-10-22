// The Overview workspace: what is happening right now. What posts next, today's numbers, anything that needs attention, and the latest posts that
// went out. Presentational: the parent supplies accounts and posts and nothing is changed here. The 30-day analysis lives on Insights.

import { useMemo, useState } from "react";
import type { ScheduledPost, SocialAccount } from "../../lib/api";
import { brandLabels } from "../../lib/failuresModel";
import { buildOverviewModel, untilText, type OverviewRow } from "../../lib/overviewModel";
import { PlatformIcon } from "../PlatformIcon";
import "./OverviewWorkspace.css";

interface Props {
  accounts: SocialAccount[];
  posts: ScheduledPost[];
  now?: Date;
  /** Shown on the empty state, to connect a first account. */
  onConnect?: () => void;
}

// Brand colours that fall in the banned hue family are drawn in slate.
const MONO_ICONS = new Set(["mastodon", "discord", "slack", "nostr"]);

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Item({ r, when }: { r: OverviewRow; when: string }) {
  return (
    <li className="ov-item" data-testid="ov-item">
      <span className={`ov-icon${MONO_ICONS.has(r.platform) ? " ov-icon--mono" : ""}`}>{r.platform ? <PlatformIcon platform={r.platform} size={20} /> : null}</span>
      <div className="ov-itemtext">
        <span className="ov-itemmsg">{r.text || "(no text)"}</span>
        <small>{when}{r.account ? ` · ${r.account}` : ""}</small>
      </div>
      {r.url && <a className="ov-link" href={r.url} target="_blank" rel="noopener noreferrer">{r.verified ? "Live" : "Open"}</a>}
    </li>
  );
}

export function OverviewWorkspace({ accounts, posts, now, onConnect }: Props) {
  const at = useMemo(() => now ?? new Date(), [now]);
  const labels = useMemo(() => brandLabels(accounts), [accounts]);
  const [brand, setBrand] = useState("");
  const activeBrand = labels.includes(brand) ? brand : "";
  const m = useMemo(() => buildOverviewModel(posts, accounts, activeBrand, at), [posts, accounts, activeBrand, at]);

  if (accounts.length === 0) {
    return (
      <div className="ov-root">
        <section className="ov-module ov-empty" aria-label="Overview">
          <h3>Connect your first account</h3>
          <p>LazyRelay cannot schedule anything until there is somewhere to post it. Connect an account and this page fills in.</p>
          {onConnect && <button type="button" className="ov-btn" onClick={onConnect}>Connect an account</button>}
        </section>
      </div>
    );
  }

  const attention = m.failed + m.paused + m.needsReconnect;

  return (
    <div className="ov-root">
      <header className="ov-header">
        <div>
          <h2>Overview</h2>
          <p className="ov-note">What is happening right now</p>
        </div>
        <div className="ov-brands" role="group" aria-label="Brand">
          {["", ...labels].map((b) => (
            <button key={b || "all"} type="button" aria-pressed={activeBrand === b} className={activeBrand === b ? "ov-on" : ""} onClick={() => setBrand(b)}>{b || "All brands"}</button>
          ))}
        </div>
      </header>

      <div className="ov-tiles">
        <section className="ov-module ov-tile" aria-label="Next up" data-testid="ov-next">
          <small className="ov-cap">Next up</small>
          {m.next ? (
            <>
              <strong>{untilText(m.next.when, at)}</strong>
              <span className="ov-sub">{clock(m.next.when)}{m.next.account ? ` · ${m.next.account}` : ""}</span>
            </>
          ) : (
            <>
              <strong>Nothing queued</strong>
              <span className="ov-sub">{m.paused > 0 ? `${m.paused.toLocaleString("en-US")} paused` : "Schedule a post to see it here"}</span>
            </>
          )}
        </section>
        <section className="ov-module ov-tile" aria-label="Today" data-testid="ov-today">
          <small className="ov-cap">Today</small>
          <strong>{m.postedToday.toLocaleString("en-US")} posted</strong>
          <span className="ov-sub">{m.dueToday.toLocaleString("en-US")} still to go · {m.scheduled.toLocaleString("en-US")} scheduled in all</span>
        </section>
        <section className={`ov-module ov-tile${m.allClear ? " ov-tile--ok" : " ov-tile--warn"}`} aria-label="Needs attention" data-testid="ov-attention">
          <small className="ov-cap">Needs attention</small>
          {m.allClear ? (
            <>
              <strong>All clear</strong>
              <span className="ov-sub">No failures, nothing paused, every account connected</span>
            </>
          ) : (
            <>
              <strong>{attention.toLocaleString("en-US")} to look at</strong>
              <span className="ov-sub">
                {[
                  m.failed ? `${m.failed.toLocaleString("en-US")} failed` : "",
                  m.paused ? `${m.paused.toLocaleString("en-US")} paused` : "",
                  m.needsReconnect ? `${m.needsReconnect.toLocaleString("en-US")} to reconnect` : "",
                ].filter(Boolean).join(" · ")}
              </span>
            </>
          )}
        </section>
      </div>

      <div className="ov-lists">
        <section className="ov-module" aria-label="Coming up" data-testid="ov-upcoming">
          <div className="ov-head"><h3>Coming up</h3></div>
          {m.upcoming.length === 0 ? (
            <p className="ov-empty-text">No posts waiting to go out.</p>
          ) : (
            <ul className="ov-list ov-scroll">{m.upcoming.map((r) => <Item key={r.id} r={r} when={`${untilText(r.when, at)} · ${clock(r.when)}`} />)}</ul>
          )}
        </section>
        <section className="ov-module" aria-label="Latest published" data-testid="ov-latest">
          <div className="ov-head"><h3>Latest published</h3></div>
          {m.latest.length === 0 ? (
            <p className="ov-empty-text">Nothing has gone out yet.</p>
          ) : (
            <ul className="ov-list ov-scroll">{m.latest.map((r) => <Item key={r.id} r={r} when={clock(r.when)} />)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
