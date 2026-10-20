// The live status panel. It shows only what this page can read right now: the customer's own posting queue, when each
// source was last checked, and whether the service answers. Anything it cannot read says Unknown. It makes no promise about
// uptime, and it never claims the customer's computer can be off: the background checks happen only while the engine runs.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ScheduledPost } from "../../lib/api";
import { SOURCE_TYPE_LABELS, describeLastProblem, type ContentSourcesClient, type ServiceSource } from "../../lib/contentSources";
import {
  HEALTH_WORDS,
  OVERALL_WORDS,
  deriveOverall,
  describeLastChecked,
  describeQueue,
  summarizeQueue,
  type Health,
  type Overall,
} from "../../lib/contentSourcesStatus";
import "../../styles/content-sources-status.css";

const GIVE_UP_AFTER_MS = 8000; // the client has its own shorter limit; this one keeps the panel from waiting on a stuck check

export interface ContentSourcesStatusProps {
  posts: readonly ScheduledPost[];
  /** The sources list, or null when it could not be read. */
  sources: readonly ServiceSource[] | null;
  client: ContentSourcesClient;
  now?: () => number;
}

const BADGE_CLASS: Record<Overall, string> = {
  checking: "cs-badge cs-badge--wait",
  running: "cs-badge cs-badge--ok",
  paused: "cs-badge cs-badge--wait",
  problem: "cs-badge cs-badge--attention",
  unknown: "cs-badge cs-badge--unknown",
};

function hostOf(address: string | null): string {
  if (!address) return "Unnamed source";
  try {
    return new URL(address).host;
  } catch {
    return "Unnamed source";
  }
}

function useServiceHealth(client: ContentSourcesClient) {
  const [health, setHealth] = useState<Health>(client.ready ? "checking" : "unknown");
  const run = useRef(0);

  const check = useCallback(async () => {
    const id = ++run.current;
    if (!client.ready) {
      setHealth("unknown");
      return;
    }
    setHealth("checking");
    const ctl = new AbortController();
    const giveUp = setTimeout(() => {
      if (run.current !== id) return;
      ctl.abort();
      setHealth("unknown");
    }, GIVE_UP_AFTER_MS);
    try {
      const up = await client.ready(ctl.signal);
      if (run.current === id) setHealth(up === null ? "unknown" : up ? "ok" : "down");
    } catch (err) {
      console.error(err); // the raw reason stays in the console; the panel says Unknown rather than guess
      if (run.current === id) setHealth("unknown");
    } finally {
      clearTimeout(giveUp);
    }
  }, [client]);

  useEffect(() => {
    void check();
    return () => {
      run.current += 1;
    };
  }, [check]);

  return { health, check };
}

function EngineRows({ sources, now }: { sources: readonly ServiceSource[] | null; now: number }) {
  if (sources === null) return <p data-testid="engine-unknown">Unknown. We could not read your sources.</p>;
  if (sources.length === 0) return <p>No sources yet.</p>;
  return (
    <ul className="cs-status__list">
      {sources.map((s) => (
        <li key={s.id}>
          <span className="cs-chip">{SOURCE_TYPE_LABELS[s.sourceType]}</span> <span>{hostOf(s.sourceUrl)}</span>
          <span className="cs-hint">{describeLastChecked(s.lastSyncedAt, now)}</span>
          {s.lastError && <span className="cs-error">{describeLastProblem(s.lastError)}</span>}
        </li>
      ))}
    </ul>
  );
}

const REFRESH_TIME_EVERY_MS = 30_000;

/** Asks for a fresh render now and then, so "Last checked 2 minutes ago" cannot stay frozen while the page is open. */
function useClockTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_TIME_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
}

export function ContentSourcesStatus({ posts, sources, client, now = Date.now }: ContentSourcesStatusProps) {
  const titleId = useId();
  useClockTick();
  const { health, check } = useServiceHealth(client);
  const queue = summarizeQueue(posts);
  const overall = deriveOverall(queue, sources, health);

  return (
    <section className="cs-card cs-status" role="region" aria-labelledby={titleId}>
      <div className="cs-status__head">
        <h3 className="cs-card__title" id={titleId}>
          Live status
        </h3>
        <span className={BADGE_CLASS[overall]} data-testid="status-badge">
          {OVERALL_WORDS[overall]}
        </span>
      </div>
      <dl className="cs-status__rows">
        <div>
          <dt className="cs-label">Posting queue</dt>
          <dd data-testid="queue-state">{describeQueue(queue)}</dd>
        </div>
        <div>
          <dt className="cs-label">Content engine</dt>
          <dd>
            <EngineRows sources={sources} now={now()} />
            <p className="cs-hint">Background checks only happen while the engine is running.</p>
          </dd>
        </div>
        <div>
          <dt className="cs-label">Service</dt>
          <dd data-testid="service-health">{HEALTH_WORDS[health]}</dd>
        </div>
      </dl>
      <div className="cs-actions">
        <button type="button" className="cs-btn cs-btn--secondary" onClick={() => void check()} disabled={health === "checking"}>
          Check again
        </button>
      </div>
    </section>
  );
}
