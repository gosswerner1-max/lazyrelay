import { useMemo } from "react";

// Shared animated background — used on the landing page, the dashboard, and
// (as a static HTML/JS equivalent, generated from the same PULSE_ROUTES
// shape by hand — see public/circuit-bg.js) every guide/tool page under
// frontend/public/. See App.css for the .circuit-*, .trace, .via base
// rules and the 4-color palette (--signal-solid orange, --confirm green,
// --pulse-teal, --pulse-violet).
//
// Colors are assigned to routes via inline style, not CSS classes — a
// prior version used .color-green/-teal/-violet classes and hit a real bug
// (2026-08-10): those classes set `fill` unconditionally, which won a
// source-order tiebreak against .pulse/.confirmation-ring's `fill: none`
// and turned every colored pulse into a solid filled triangle at each
// sharp turn. Inline styles can't have that class-ordering problem.
const PULSE_COLORS = ["var(--signal-solid)", "var(--confirm)", "var(--pulse-teal)", "var(--pulse-violet)"];

// 16 routes across the 32 static traces (was 8 — Werner's 2026-08-10
// feedback: some traces never had anything moving on them). 4 are
// desktop-only to keep mobile lighter. Duration/delay follow a simple
// spread (8.5s + i*0.9, delay -(i*1.15+0.4)) so nothing visibly
// synchronizes; no need to hand-tune 16 individual pairs.
const PULSE_ROUTES = [
  { d: "M0 105H145V165H250V226H355", cx: 355, cy: 226 },
  { d: "M1600 470H1490V545H1392V618H1295", cx: 1295, cy: 618 },
  { d: "M0 930H165V865H280V805H390", cx: 390, cy: 805 },
  { d: "M1600 245H1510V310H1415V372H1325", cx: 1325, cy: 372, desktopOnly: true },
  { d: "M0 320H95V260H190V195H295", cx: 295, cy: 195 },
  { d: "M1600 320H1505V260H1410V195H1305", cx: 1305, cy: 195 },
  { d: "M700 0V60H620V110H540", cx: 540, cy: 110 },
  { d: "M900 1000V945H980V895H1060", cx: 1060, cy: 895, desktopOnly: true },
  { d: "M0 210H92V278H182V338H285", cx: 285, cy: 338 },
  { d: "M1530 0V68H1430V120H1325", cx: 1325, cy: 120 },
  { d: "M0 455H120V530H220V610H315", cx: 315, cy: 610 },
  { d: "M1600 655H1515V730H1435V810H1320", cx: 1320, cy: 810, desktopOnly: true },
  { d: "M270 1000V945H405V885H520", cx: 520, cy: 885 },
  { d: "M1335 1000V948H1205V890H1090", cx: 1090, cy: 890 },
  { d: "M700 1000V940H620V890H540", cx: 540, cy: 890 },
  { d: "M1265 0V80H1175V140H1080", cx: 1080, cy: 140, desktopOnly: true },
].map((route, i) => ({ ...route, duration: 8.5 + i * 0.9, delay: -(i * 1.15 + 0.4) }));

function shuffledColors(count: number) {
  const perColor = Math.ceil(count / PULSE_COLORS.length);
  const pool = PULSE_COLORS.flatMap((c) => Array(perColor).fill(c)).slice(0, count);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export function CircuitBackground() {
  // Computed once per mount (i.e. once per page load) rather than on every
  // re-render — a fresh shuffle each render would make the dots visibly
  // jump colors mid-animation, not just vary between visits.
  const colors = useMemo(() => shuffledColors(PULSE_ROUTES.length), []);

  return (
    <div className="circuit-background" aria-hidden="true">
      <svg className="circuit-svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" role="presentation">
        <defs>
          <filter id="signalGlow" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Static traces, concentrated around the perimeter so the reading area stays quiet */}
        <path className="trace" d="M0 105H145V165H250V226H355" />
        <path className="trace soft" d="M0 210H92V278H182V338H285" />
        <path className="trace" d="M60 0V74H210V124H315" />
        <path className="trace soft" d="M305 0V70H405V135H500" />
        <circle className="via" cx="145" cy="105" r="5" />
        <circle className="via-core" cx="145" cy="105" r="1.7" />
        <circle className="via" cx="250" cy="165" r="5" />
        <circle className="via" cx="182" cy="278" r="4.5" />
        <circle className="via" cx="405" cy="70" r="4.5" />

        <path className="trace" d="M1600 110H1470V168H1360V228H1250" />
        <path className="trace soft" d="M1600 245H1510V310H1415V372H1325" />
        <path className="trace" d="M1530 0V68H1430V120H1325" />
        <path className="trace soft" d="M1265 0V80H1175V140H1080" />
        <circle className="via" cx="1470" cy="110" r="5" />
        <circle className="via-core" cx="1470" cy="110" r="1.7" />
        <circle className="via" cx="1360" cy="168" r="5" />
        <circle className="via" cx="1415" cy="310" r="4.5" />
        <circle className="via" cx="1175" cy="80" r="4.5" />

        <path className="trace" d="M0 455H120V530H220V610H315" />
        <path className="trace soft" d="M0 650H82V720H165V805H285" />
        <path className="trace" d="M42 1000V900H125V830H205" />
        <circle className="via" cx="120" cy="455" r="5" />
        <circle className="via" cx="220" cy="530" r="4.5" />
        <circle className="via" cx="82" cy="650" r="4.5" />
        <circle className="via" cx="125" cy="900" r="5" />

        <path className="trace" d="M1600 470H1490V545H1392V618H1295" />
        <path className="trace soft" d="M1600 655H1515V730H1435V810H1320" />
        <path className="trace" d="M1555 1000V910H1475V842H1390" />
        <circle className="via" cx="1490" cy="470" r="5" />
        <circle className="via" cx="1392" cy="545" r="4.5" />
        <circle className="via" cx="1515" cy="655" r="4.5" />
        <circle className="via" cx="1475" cy="910" r="5" />

        <path className="trace" d="M0 930H165V865H280V805H390" />
        <path className="trace soft" d="M270 1000V945H405V885H520" />
        <circle className="via" cx="165" cy="930" r="5" />
        <circle className="via" cx="280" cy="865" r="4.5" />
        <circle className="via" cx="405" cy="945" r="4.5" />

        <path className="trace" d="M1600 925H1450V868H1340V805H1230" />
        <path className="trace soft" d="M1335 1000V948H1205V890H1090" />
        <circle className="via" cx="1450" cy="925" r="5" />
        <circle className="via" cx="1340" cy="868" r="4.5" />
        <circle className="via" cx="1205" cy="948" r="4.5" />

        <path className="trace soft desktop-only" d="M355 226H470V290H560" />
        <path className="trace soft desktop-only" d="M1250 228H1130V290H1040" />
        <path className="trace soft desktop-only" d="M315 610H410V680H510" />
        <path className="trace soft desktop-only" d="M1295 618H1195V684H1090" />

        <path className="trace" d="M0 320H95V260H190V195H295" />
        <path className="trace soft" d="M0 380H70V440H150" />
        <circle className="via" cx="95" cy="320" r="5" />
        <circle className="via" cx="190" cy="195" r="4.5" />
        <circle className="via" cx="70" cy="440" r="4.5" />

        <path className="trace" d="M1600 320H1505V260H1410V195H1305" />
        <path className="trace soft" d="M1600 380H1530V440H1450" />
        <circle className="via" cx="1505" cy="320" r="5" />
        <circle className="via" cx="1410" cy="195" r="4.5" />
        <circle className="via" cx="1530" cy="440" r="4.5" />

        <path className="trace" d="M700 0V60H620V110H540" />
        <path className="trace soft desktop-only" d="M900 0V55H980V105H1060" />
        <circle className="via" cx="620" cy="110" r="4.5" />
        <circle className="via" cx="980" cy="105" r="4.5" />

        <path className="trace" d="M700 1000V940H620V890H540" />
        <path className="trace soft" d="M900 1000V945H980V895H1060" />
        <circle className="via" cx="620" cy="890" r="4.5" />
        <circle className="via" cx="980" cy="895" r="5" />

        <path className="trace soft desktop-only" d="M20 150V400H55V650H20V1000" />
        <path className="trace soft desktop-only" d="M1580 150V400H1545V650H1580V1000" />

        {/* Signals — 16 routes, colors shuffled once per page load so the
            same track doesn't always carry the same color. */}
        {PULSE_ROUTES.map((route, i) => {
          const cls = route.desktopOnly ? "desktop-only" : undefined;
          const style = { stroke: colors[i], animationDuration: `${route.duration}s`, animationDelay: `${route.delay}s` };
          return (
            <g key={route.d} className={cls}>
              <path className="pulse" pathLength={1000} d={route.d} style={style} />
              <circle className="confirmation-ring" cx={route.cx} cy={route.cy} r="8" style={style} />
              <circle
                className="confirmation-dot"
                cx={route.cx}
                cy={route.cy}
                r="2.4"
                style={{ fill: colors[i], animationDuration: style.animationDuration, animationDelay: style.animationDelay }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
