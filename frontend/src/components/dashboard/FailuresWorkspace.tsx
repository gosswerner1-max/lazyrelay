// The Failures workspace (ported from the approved single-screen Failure Console design): a status strip, grouped error tiles with the fix, and a
// scrollable list of recent retries and failures. Presentational: the parent supplies accounts and posts. It never retries, duplicates or deletes;
// "Open in Posts" only hands control to the existing Failed tab, which owns those actions.

import { useId, useMemo, useState } from "react";
import type { ScheduledPost, SocialAccount } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import { brandLabels, buildFailuresModel } from "../../lib/failuresModel";
import "./FailuresWorkspace.css";

interface Props {
  accounts: SocialAccount[];
  posts: ScheduledPost[];
  /** Called by "Open in Posts" on a failed row. */
  onOpenFailed: () => void;
}

// These brand colours fall in the hue family the Midnight Canvas palette bans, so their icons are drawn in slate instead.
const MONO_ICONS = new Set(["mastodon", "discord", "slack", "nostr"]);

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function FailuresWorkspace({ accounts, posts, onOpenFailed }: Props) {
  const labels = useMemo(() => brandLabels(accounts), [accounts]);
  const [brand, setBrand] = useState("");
  const activeBrand = labels.includes(brand) ? brand : "";
  const model = useMemo(() => buildFailuresModel(posts, accounts, activeBrand), [posts, accounts, activeBrand]);
  const brandGroupId = useId();
  const ok = model.failedCount === 0;

  return (
    <div className="fc-root">
      <header className="fc-header">
        <h2>Failures</h2>
        <div className="fc-brands" role="group" aria-label="Brand" id={brandGroupId}>
          {["", ...labels].map((l) => (
            <button key={l || "all"} type="button" className={`fc-seg${activeBrand === l ? " fc-seg--on" : ""}`} aria-pressed={activeBrand === l} onClick={() => setBrand(l)}>
              {l || "All brands"}
            </button>
          ))}
        </div>
      </header>

      <section className="fc-module fc-statusrow" aria-label="Status">
        <div className="fc-strip" data-testid="fc-strip" data-tone={ok ? "ok" : "alert"} role="status">
          {ok ? (
            <>
              <span className="fc-emblem" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
              <strong>All systems fully operational.</strong>
            </>
          ) : (
            <>
              <span className="fc-emblem fc-emblem--alert" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 6v7M12 17.5v.5" /></svg></span>
              <strong>{model.failedCount.toLocaleString("en-US")} {model.failedCount === 1 ? "post failed" : "posts failed"}</strong>
            </>
          )}
        </div>
        <div className="fc-stats">
          <div className="fc-stat"><small>Failed posts</small><strong data-testid="fc-stat-failed">{model.failedCount.toLocaleString("en-US")}</strong></div>
          <div className="fc-stat"><small>Retries that recovered</small><strong data-testid="fc-stat-recovered">{model.recovered.toLocaleString("en-US")}</strong></div>
          <div className="fc-stat"><small>Clean first time</small><strong data-testid="fc-stat-clean">{model.cleanSharePercent === null ? "—" : `${model.cleanSharePercent}%`}</strong></div>
        </div>
      </section>

      <div className="fc-grid">
        <section className="fc-module" aria-label="What went wrong and the fix">
          <div className="fc-head"><h2>What went wrong and the fix</h2></div>
          <div className="fc-scroll fc-tiles">
            {model.groups.length === 0 && <p className="fc-empty">Nothing has gone wrong. Errors will show up here with the fix.</p>}
            {model.groups.map((g) => (
              <article key={g.key} className="fc-tile" data-testid="fc-tile">
                <span className="fc-count" data-testid="fc-tile-count">{g.count.toLocaleString("en-US")}</span>
                <div>
                  <p className="fc-msg">{g.message}</p>
                  <p className={`fc-step${g.step ? "" : " fc-step--none"}`}>{g.step ?? "No corrective step recorded"}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="fc-module" aria-label="Recent retries and failures">
          <div className="fc-head"><h2>Recent retries and failures</h2></div>
          <div className="fc-scroll fc-list">
            {model.recent.length === 0 && <p className="fc-empty">No recent retries or failures.</p>}
            {model.recent.map((r) => (
              <div key={r.id} className="fc-row" data-testid="fc-row">
                <span className={`fc-icon${MONO_ICONS.has(r.platform) ? " fc-icon--mono" : ""}`}>{r.platform ? <PlatformIcon platform={r.platform} size={20} /> : null}</span>
                <div className="fc-rowtext">
                  <span className="fc-rowmsg">{r.message}</span>
                  <small>{r.failed ? "Failed" : "Recovered after a retry"}{formatWhen(r.at) ? ` · ${formatWhen(r.at)}` : ""}</small>
                </div>
                {r.failed && (
                  <button type="button" className="fc-open" onClick={onOpenFailed}>Open in Posts</button>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
