import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { ACTION_GROUPS, TICKER_LANES, type ActionGroupId, type TickerPlatform } from "./landingV2Data";
import { useOnScreen, useReducedMotion } from "./useLandingMotion";

/** A glass tile. The glow span is part of the markup (not injected later), so React owns every node in the tile. */
export function Tile({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`lv2-g ${className}`.trim()} {...rest}>
      <span className="glow" aria-hidden="true" />
      {children}
    </div>
  );
}

// Proof of Publish: the three steps play in turn while the card is on screen; the toggle shows both outcomes.
export function ProofCard() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref, !reduce, false);
  const [outcome, setOutcome] = useState<"ok" | "bad">("ok");
  const [phase, setPhase] = useState(0);
  // The finished state shows whenever the animation is not running (prerender, reduced motion, off screen).
  const running = !reduce && onScreen;
  const lit = running ? phase : 3;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setPhase((n) => (n + 1) % 4), 1100);
    return () => window.clearInterval(timer);
  }, [running]);

  function choose(next: "ok" | "bad") {
    setOutcome(next);
    setPhase(0);
  }

  const steps: { n: number; title: ReactNode; body: ReactNode }[] = [
    { n: 1, title: "Posted", body: <><code>post()</code> sends the content to the platform</> },
    { n: 2, title: "Read back", body: <><code>verifyPublished()</code> reads it back from the platform</> },
  ];

  return (
    <div ref={ref} className={`lv2-g lv2-proof lv2-rv lv2-d1 is-${outcome}`} aria-label="Proof of Publish workflow">
      <span className="glow" aria-hidden="true" />
      <div className="lv2-pp-head">
        <h3>Every post, two steps</h3>
        <div className="lv2-tog" role="group" aria-label="Show an outcome">
          <button type="button" data-out="ok" aria-pressed={outcome === "ok"} onClick={() => choose("ok")}>Confirmed</button>
          <button type="button" data-out="bad" aria-pressed={outcome === "bad"} onClick={() => choose("bad")}>Not confirmed</button>
        </div>
      </div>
      <ol className="lv2-pp-steps">
        {steps.map((s) => (
          <li key={s.n} data-on={lit >= s.n ? "" : undefined}>
            <span className="lv2-pp-n">{s.n}</span>
            <div><b>{s.title}</b><small>{s.body}</small></div>
          </li>
        ))}
        <li className="lv2-pp-res" data-on={lit >= 3 ? "" : undefined}>
          <span className="lv2-pp-n">3</span>
          <div>
            <span className="ok"><b>Live</b><small>The public URL is stored and the credit is taken.</small></span>
            <span className="bad"><b>Flagged</b><small>The post is flagged in your dashboard and no credit is taken.</small></span>
          </div>
        </li>
      </ol>
    </div>
  );
}

// The 27 automated actions, in four groups. Every group stays in the page (inactive ones are hidden), so the text is crawlable.
export function ActionsCard() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useOnScreen(ref, !reduce);
  const [group, setGroup] = useState<ActionGroupId>("lookups");
  const [touched, setTouched] = useState(false);
  const play = !reduce && (seen || touched);
  const total = ACTION_GROUPS.reduce((sum, g) => sum + g.tools.length, 0);

  return (
    <div ref={ref} className="lv2-g lv2-actions lv2-rv" aria-label={`The ${total} automated actions, by group`}>
      <span className="glow" aria-hidden="true" />
      <div className="lv2-ag-top"><b>{total}</b><span>automated actions your AI assistant can run</span></div>
      <div className="lv2-ag-tabs" role="group" aria-label="Choose a group">
        {ACTION_GROUPS.map((g) => (
          <button key={g.id} type="button" data-g={g.id} aria-pressed={group === g.id} onClick={() => { setGroup(g.id); setTouched(true); }}>
            {g.title}<em>{g.tools.length}</em>
          </button>
        ))}
      </div>
      {ACTION_GROUPS.map((g) => (
        <div key={g.id} className={`lv2-ag-panel${play && group === g.id ? " play" : ""}`} data-g={g.id} hidden={group !== g.id}>
          <p>{g.blurb}</p>
          <ul>
            {g.tools.map((tool, k) => (
              <li key={tool} style={{ "--i": k } as CSSProperties}><span style={{ "--n": tool.length } as CSSProperties}>{tool}</span></li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TickerIcon({ p }: { p: TickerPlatform }) {
  return (
    <span className="lv2-ic" tabIndex={0} role="img" aria-label={p.label}>
      <img className={p.slate ? "slate" : undefined} src={`/home-icons/${p.icon}.svg`} alt="" width={34} height={34} decoding="async" />
      <i>{p.label}</i>
    </span>
  );
}

// Two lanes, opposite directions. Each lane holds the readable set plus one aria-hidden copy, so the loop has no seam.
export function PlatformTicker() {
  return (
    <div className="lv2-tick" aria-label="The 18 distribution platforms plus WhatsApp">
      {TICKER_LANES.map((lane, i) => (
        <div key={i} className={`lv2-lane${i === 1 ? " rev" : ""}`}>
          <div className="lv2-set" data-set="primary">
            {lane.map((p) => <TickerIcon key={p.icon} p={p} />)}
          </div>
          <div className="lv2-set" data-set="copy" aria-hidden="true">
            {lane.map((p) => (
              <span className="lv2-ic" key={p.icon}>
                <img className={p.slate ? "slate" : undefined} src={`/home-icons/${p.icon}.svg`} alt="" width={34} height={34} decoding="async" />
                <i>{p.label}</i>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
