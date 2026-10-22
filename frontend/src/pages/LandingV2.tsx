import { useLayoutEffect, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { capturePromoCode } from "../lib/promo";
import { HOME_FAQ, homeFaqSchemaJson } from "../lib/homeFaq";
import { ReferralApplicationModal } from "../components/ReferralApplicationModal";
import { PlatformIcon } from "../components/PlatformIcon";
import { SupportWidget } from "../components/SupportWidget";
import { LazySpringPanel } from "../components/LazySpringPanel";
import { FOOTER_COMPARE_LINKS, FOOTER_SCHEDULE_LINKS, REVIEWED_PLATFORMS, FooterBadgeGroup } from "./Landing";
import { ActionsCard, PlatformTicker, ProofCard, Tile } from "./landingV2/Interactive";
import { PLANS, PLATFORM_COUNT_WORDING, SCALE_BARS, STEPS, WHY_ROWS } from "./landingV2/landingV2Data";
import { useLandingEngines } from "./landingV2/useLandingMotion";
import "./LandingV2.css";

// The new home page (Midnight Canvas). Same props, same destinations and same SEO surfaces as Landing; shown only when
// VITE_NEW_HOME_ENABLED is "true" (see App.tsx). Title, meta and the site JSON-LD live in index.html, as for Landing;
// this page adds only the FAQPage JSON-LD, exactly as Landing does.
interface LandingV2Props {
  onSignIn: () => void;
  onGetStarted: () => void;
  onPrivacy: () => void;
  onTerms: () => void;
  onDpa: () => void;
  onContact: () => void;
  onPartners: () => void;
  onDocs: () => void;
  scrollToPricing: boolean;
}

/** A real link (so it can be opened in a new tab or copied) that runs the in-app action on a plain click. */
function GoLink({ href, onGo, className, children }: { href: string; onGo: () => void; className?: string; children: ReactNode }) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onGo();
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

export function LandingV2({ onSignIn, onGetStarted, onPrivacy, onTerms, onDpa, onContact, onPartners, onDocs, scrollToPricing }: LandingV2Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  useLandingEngines(rootRef, canvasRef, orbRef);

  // Entrances only hide content once the script is running, so the page reads fine before it starts.
  useLayoutEffect(() => {
    rootRef.current?.classList.add("lv2-js");
  }, []);

  // Arriving at /pricing lands on the pricing section before the first paint, as on Landing.
  useLayoutEffect(() => {
    if (scrollToPricing) document.getElementById("pricing")?.scrollIntoView();
    // scrollToPricing reflects the path captured once at module load; deliberately not re-checked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  async function onNewsletter(e: FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    try {
      const { code: promo } = await api.subscribeToNewsletter(email);
      // Stored exactly as a click on the launch-discount link would store it (lib/promo.ts).
      capturePromoCode(promo);
      setCode(promo);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign up right now.");
      setStatus("error");
    }
  }

  const signUp = (label: string, className = "btn") => (
    <GoLink href="/signup" onGo={onGetStarted} className={className}>{label}</GoLink>
  );

  return (
    <div className="lv2" ref={rootRef}>
      <canvas className="lv2-live-canvas" ref={canvasRef} aria-hidden="true" />
      <div className="lv2-ambient" aria-hidden="true" />
      <div className="lv2-vig" aria-hidden="true" />
      <div className="lv2-orb" ref={orbRef} aria-hidden="true" />
      <a className="lv2-skip" href="#content">Skip to the page</a>
      <header className="lv2-top">
        <div className="lv2-wrap">
          <a className="lv2-wordmark" href="/">Lazy<span className="dot">Relay</span></a>
          <nav className="lv2-primary" aria-label="Primary">
            <a href="/" aria-current="page">Home</a>
            <a href="/capabilities/">Capabilities</a>
            <a href="#pricing">Pricing</a>
            <a href="/mcp/">Integrations</a>
            <a href="/guides/">Guides</a>
            <GoLink href="/docs/" onGo={onDocs}>Docs</GoLink>
          </nav>
          <span className="lv2-top-actions">
            <GoLink href="/login" onGo={onSignIn} className="btn ghost lv2-signin">Sign in</GoLink>
            {signUp("Get started free")}
            <button
              type="button"
              className="lv2-menu-toggle"
              aria-expanded={menuOpen}
              aria-controls="lv2-mobile-nav"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span aria-hidden="true">{menuOpen ? "✕" : "☰"}</span>
            </button>
          </span>
        </div>
        <LazySpringPanel as="nav" open={menuOpen} origin="top right" id="lv2-mobile-nav" className="lv2-mobile-nav" aria-label="Menu">
          <a href="/capabilities/" onClick={() => setMenuOpen(false)}>Capabilities</a>
          <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
          <a href="#faq" onClick={() => setMenuOpen(false)}>FAQ</a>
          <a href="/mcp/" onClick={() => setMenuOpen(false)}>Integrations</a>
          <a href="/guides/" onClick={() => setMenuOpen(false)}>Guides</a>
          <button type="button" onClick={() => { setMenuOpen(false); onDocs(); }}>Docs</button>
          <button type="button" onClick={() => { setMenuOpen(false); onContact(); }}>Contact</button>
          <button type="button" onClick={() => { setMenuOpen(false); onSignIn(); }}>Sign in</button>
        </LazySpringPanel>
      </header>

      <main id="content">
        <div className="lv2-inner">
          <section className="lv2-bhero" aria-labelledby="lv2-h1">
            <div>
              <span className="lv2-eyebrow">Native AI Agent Orchestration</span>
              <h1 id="lv2-h1" className="landing-hero-headline">Schedule everywhere. Know it's <em>actually live.</em></h1>
              <p className="sub">Hire an automated AI workforce to write, schedule, and verify your social media campaigns around the clock.</p>
              <p className="aud">Built for Creators, Brands, and Scaling Agencies. Orchestrate all your cross-platform content campaigns from a single high-performance dashboard.</p>
              <div className="hero-cta">
                {signUp("Get started free")}
                <a className="btn ghost" href="#pricing">See pricing</a>
              </div>
            </div>
            <div className="lv2-hstack" data-depth-root aria-label="One dashboard for every brand and network">
              <Tile className="h1s" data-depth="10">
                <span className="lv2-k">Your brands</span><h3>One dashboard, every brand</h3>
                <ul className="lv2-pillrow"><li>Brand A</li><li>Brand B</li><li>Brand C</li><li className="hot">+ unlimited on Pro</li></ul>
              </Tile>
              <Tile className="h2s" data-depth="22">
                <span className="lv2-k">Your destinations</span><h3>One calendar, every network you picked</h3>
                <ul className="lv2-pillrow"><li>TikTok</li><li>Instagram</li><li>YouTube</li><li>LinkedIn</li><li>Bluesky</li><li>X</li><li className="wa">WhatsApp</li></ul>
              </Tile>
              <Tile className="h3s" data-depth="34">
                <span className="lv2-k">Proof of Publish</span><h3><span className="lv2-live-dot" />Live, and checked</h3>
                <p>Read back from the platform before a credit is taken.</p>
              </Tile>
            </div>
          </section>
        </div>

        <div className="lv2-band a"><div className="lv2-inner">
          <section className="lv2-feat" aria-labelledby="pf">
            <div className="lv2-rv">
              <span className="lv2-eyebrow">Proof of Publish</span>
              <h2 id="pf">Sent is not live. We check.</h2>
              <p>Posting and checking are two separate steps. After LazyRelay posts, it reads the post back from the platform. A post is marked live only when that read back confirms it.</p>
              <p className="small">Flip the switch to see what happens when it is not confirmed.</p>
            </div>
            <ProofCard />
          </section>
        </div></div>

        <div className="lv2-band b"><div className="lv2-inner">
          <section className="lv2-feat flip" aria-labelledby="work">
            <ActionsCard />
            <div className="lv2-rv lv2-d1">
              <span className="lv2-eyebrow">Your AI workforce</span>
              <h2 id="work">27 Automated Workforce Actions</h2>
              <p>Give your AI assistants control to schedule, pause, or instantly publish across your networks.</p>
              <p className="small">Works with Claude, ChatGPT, Gemini, Cursor and any agent that supports MCP. Included on every plan, Free too. <a href="/capabilities/#mcp">Browse the 27 tools</a>.</p>
            </div>
          </section>
        </div></div>

        <div className="lv2-band a"><div className="lv2-inner">
          <div className="lv2-bento-head lv2-rv"><span className="lv2-eyebrow">Built to scale</span>
            <h2>From one creator to hundreds of client destinations</h2>
            <p>Creators, Brands, and Scaling Agencies run on the same engine. Add brands and connected accounts as you grow.</p></div>
          <div className="lv2-bento">
            <Tile className="b-plat lv2-rv"><span className="lv2-k hot">Reach</span><h3>{PLATFORM_COUNT_WORDING}</h3>
              <p>Connect your accounts once and post to every destination you picked, from one calendar.</p>
              <PlatformTicker />
            </Tile>
            <Tile className="b-scale lv2-rv lv2-d1"><span className="lv2-k hot">Scale</span><h3>One wallet to a whole agency roster</h3>
              <p>Up to 1,000 connected accounts and unlimited brands on Pro.</p>
              <div className="lv2-bars" aria-label="Connected accounts and brands by plan">
                {SCALE_BARS.map((b) => (
                  <div key={b.plan}><span className="pl">{b.plan}</span><b>{b.accounts}</b><small>accounts</small><em>{b.brands}</em></div>
                ))}
              </div>
            </Tile>
            <Tile className="b-brand lv2-rv"><span className="lv2-k">Multi-brand</span><h3>Every brand, kept separate</h3><p>Run all your brands' campaigns from one dashboard.</p>
              <ul className="lv2-pillrow"><li>Brand A</li><li>Brand B</li><li>Brand C</li><li className="hot">Unlimited on Pro</li></ul></Tile>
            <Tile className="b-client lv2-rv lv2-d1"><span className="lv2-k">Agencies</span><h3>Client approval</h3><p>Send a review link and approve a post before it goes live.</p>
              <ul className="lv2-pillrow"><li>Review link</li><li>Feedback</li><li className="wa">Approved</li></ul></Tile>
            <Tile className="b-recur lv2-rv"><span className="lv2-k">Automatic</span><h3>Set it once</h3>
              <p>Pick the days, the time and the platforms. It posts every week until you pause it. LazyRelay checks in every 30 seconds and sends posts the moment they're due.</p></Tile>
            <Tile className="b-free lv2-rv lv2-d1"><span className="lv2-k hot">Start free</span><div className="big">30 credits</div>
              <p>Free at registration. Up to 3 connected accounts. No card needed.</p>
              <p>{signUp("Get started free")}</p></Tile>
          </div>
        </div></div>

        <div className="lv2-band b"><div className="lv2-inner">
          <section className="lv2-steps" aria-labelledby="how">
            <h2 id="how" className="lv2-rv">Set it up once. It runs on its own.</h2>
            <div className="lv2-stepline">
              {STEPS.map((s, i) => (
                <div key={s.title} className={`lv2-stp lv2-rv${i ? ` lv2-d${i}` : ""}`}><b>{i + 1}</b><h3>{s.title}</h3><p>{s.body}</p></div>
              ))}
            </div>
          </section>
        </div></div>

        <div className="lv2-band a"><div className="lv2-inner">
          <section className="lv2-why" aria-labelledby="whyh">
            <h2 id="whyh" className="lv2-rv">Why LazyRelay, not a typical scheduler</h2>
            <div>
              {WHY_ROWS.map((r, i) => (
                <div key={r.label} className={`row lv2-rv${i ? ` lv2-d${i}` : ""}`}><b>{r.label}</b><span className="us">{r.us}</span><span className="them">{r.them}</span></div>
              ))}
            </div>
          </section>
        </div></div>

        <div className="lv2-band b"><div className="lv2-inner">
          <section className="lv2-pricing" id="pricing" aria-labelledby="ph">
            <h2 id="ph" className="lv2-rv">Pricing</h2>
            <p className="lv2-lede lv2-rv lv2-d1">One wallet of credits. Prices are in US dollars.</p>
            <div className="lv2-rail">
              {PLANS.map((p, i) => (
                <article key={p.name} className={`lv2-rp${p.raise ? " raise" : ""} lv2-rv${i ? ` lv2-d${i}` : ""}`}>
                  <span className="glow" aria-hidden="true" />
                  <span className="name">{p.name}</span>
                  <div className="price">{p.price}{p.period && <small>{p.period}</small>}</div>
                  {p.sub && <p className="sub-line">{p.sub}</p>}
                  <p className="benefit">{p.benefit}</p>
                  <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                  {signUp(p.cta, p.ghost ? "btn ghost" : "btn")}
                </article>
              ))}
            </div>
            <p className="lv2-packs lv2-rv">
              <span><b>Starter pack $15</b> for 300 credits, never expire.</span>
              <span><b>Growth pack $50</b> for 1,500 credits, never expire.</span>
              <span><b>Pro top-up $30</b> for 1,500 credits, for active Pro subscribers only. It expires if the plan is canceled.</span>
              <span><b>1 credit</b> per channel destination. <b>10 credits</b> per competitor teardown, only when delivered.</span>
            </p>
          </section>
        </div></div>

        <div className="lv2-band a"><div className="lv2-inner">
          <section className="lv2-more" id="faq" aria-labelledby="faqh">
            <h2 id="faqh" className="lv2-rv">Frequently asked questions</h2>
            <div className="lv2-faqs">
              {HOME_FAQ.map((item) => (
                <details key={item.q} className="lv2-g lv2-faq"><summary><h3>{item.q}</h3></summary><p>{item.a}</p></details>
              ))}
            </div>
            {/* FAQPage structured data, built from the same list as the visible text above. */}
            <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: homeFaqSchemaJson() }} />
          </section>
          <section className="lv2-more lv2-newsletter" id="newsletter" aria-labelledby="nlh">
            <Tile className="lv2-rv">
              <h2 id="nlh">Get a launch discount</h2>
              <p>Subscribe for occasional product updates (no spam) and get a discount code for your first few months.</p>
              {status === "done" ? (
                <div className="lv2-nl-done">
                  <p>You're in. Your code (<strong>{code}</strong>) is saved to this browser. It'll apply automatically when you sign up.</p>
                  {signUp("Continue to sign up")}
                </div>
              ) : (
                <form className="lv2-nl-form" onSubmit={onNewsletter}>
                  <input type="email" required placeholder="you@example.com" aria-label="Email address" value={email} onChange={(e) => setEmail(e.target.value)} disabled={status === "loading"} />
                  <button type="submit" className="btn" disabled={status === "loading"}>{status === "loading" ? "Signing up..." : "Get my code"}</button>
                </form>
              )}
              {status === "error" && <p className="lv2-err" role="alert">{error}</p>}
            </Tile>
          </section>
          <section className="lv2-more lv2-trio" aria-label="About LazyRelay">
            <Tile className="lv2-rv" id="ai-honesty">
              <h3>How we label AI features</h3>
              <p>LazyRelay's AI captions and hashtag suggestions can be personalized to your brand voice: set a default voice for your account, or a different one per brand if you run more than one. Without a voice set, suggestions use a generic tone. Either way, treat AI suggestions as a starting draft, not a finished post.</p>
            </Tile>
            <Tile className="lv2-rv lv2-d1" id="about">
              <h3>About</h3>
              <p>LazyRelay started as a way to stop manually posting the same content to every platform, one at a time. We're an early-stage tool focused on doing one thing well: getting your posts published reliably, with real proof they actually went live, not just a "sent" message you have to trust.</p>
            </Tile>
            <Tile className="lv2-rv lv2-d2" id="partner">
              <h3>Become a partner</h3>
              <p>Have an audience? Partner with LazyRelay and earn a commission for every subscriber you bring in.</p>
              <p className="lv2-tile-actions">
                <button type="button" className="btn ghost" onClick={() => setReferralOpen(true)}>Apply to become a partner</button>
                <GoLink href="/partners" onGo={onPartners} className="lv2-textlink">See how the program works &rarr;</GoLink>
              </p>
            </Tile>
          </section>
        </div></div>

        <div className="lv2-band cta-band"><div className="lv2-inner">
          <section className="lv2-close" aria-labelledby="ch">
            <div className="lv2-rv"><h2 id="ch">Start free today</h2><p>30 credits once at registration and up to 3 connected accounts. No card needed.</p></div>
            <div className="go lv2-rv lv2-d1">{signUp("Get started free", "btn lv2-big-btn")}</div>
          </section>
        </div></div>
      </main>

      {referralOpen && <ReferralApplicationModal onClose={() => setReferralOpen(false)} />}

      <footer className="lv2-footer">
        <div className="lv2-wrap">
          <p className="lv2-reviewed">Reviewed and approved by the platform itself, not just self-declared:</p>
          <div className="lv2-reviewed-row">
            {REVIEWED_PLATFORMS.map((p) => (
              <span className="lv2-reviewed-badge" key={p}><PlatformIcon platform={p} size={22} /></span>
            ))}
          </div>
          <p className="lv2-footer-nav">
            <a href="/">Home</a> &middot; <a href="/capabilities/">Capabilities</a> &middot; <a href="#pricing">Pricing</a> &middot; <a href="/mcp/">Integrations</a> &middot; <a href="/guides/">Guides</a> &middot;{" "}
            <GoLink href="/docs/" onGo={onDocs}>API &amp; MCP docs</GoLink> &middot; <GoLink href="/contact" onGo={onContact}>Contact</GoLink> &middot; <GoLink href="/partners" onGo={onPartners}>Partner Program</GoLink> &middot;{" "}
            <a href="/status/">Status</a> &middot; <a href="/changelog/">Changelog</a> &middot; <GoLink href="/terms/" onGo={onTerms}>Terms of Service</GoLink> &middot; <GoLink href="/privacy/" onGo={onPrivacy}>Privacy Policy</GoLink> &middot;{" "}
            <GoLink href="/dpa/" onGo={onDpa}>Data Processing Addendum</GoLink> &middot; <a href="/refunds/">Refund Policy</a> &middot; <a href="/data-deletion/">Data Deletion</a> &middot;{" "}
            <a href="mailto:hello@lazyrelay.com" suppressHydrationWarning>hello@lazyrelay.com</a>
          </p>
          <p className="lv2-footer-nav"><span>Compare:</span> {FOOTER_COMPARE_LINKS.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</p>
          <p className="lv2-footer-nav"><span>Schedule to:</span> {FOOTER_SCHEDULE_LINKS.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</p>
          <div className="lv2-disclaimer">
            <p>LazyRelay is not affiliated with, endorsed by, or sponsored by any of the platforms it connects to. We connect using each platform's official APIs and comply with each platform's own Terms of Service.</p>
            <p>LazyRelay accepts media up to 1GB per file. On top of that, each connected platform applies its own limits on size, duration, and format, which can be lower than LazyRelay's own cap and can change on the platform's side at any time. It's your responsibility to make sure your content complies with each platform's own guidelines and terms.</p>
          </div>
          <p>{`© ${new Date().getFullYear()} LazyRelay. All rights reserved.`}</p>
          <p className="lv2-sister">Also from the same builder: <a href="https://timeajob.com" rel="noopener">TimeAJob</a>, flat-priced time tracking</p>
          <div className="landing-footer-badges-viewport">
            <div className="landing-footer-badges-track">
              <FooterBadgeGroup />
              <FooterBadgeGroup ariaHidden />
            </div>
          </div>
        </div>
      </footer>
      <SupportWidget context="public" />
    </div>
  );
}
