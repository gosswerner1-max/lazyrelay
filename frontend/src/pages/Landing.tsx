import { useEffect, useLayoutEffect, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import { RelaySignal } from "../components/RelaySignal";
import { CircuitBackground } from "../components/CircuitBackground";
import { SupportWidget } from "../components/SupportWidget";
import banner from "../assets/banner.jpg";

interface LandingProps {
  onSignIn: () => void;
  onGetStarted: () => void;
  onPrivacy: () => void;
  onTerms: () => void;
  onDpa: () => void;
  onContact: () => void;
  onDocs: () => void;
  // Whether the visitor's ORIGINAL url (captured in App.tsx before Root's
  // own path-sync effect rewrites it back to "/") was /pricing. Can't be
  // recomputed from window.location.pathname inside this component -- by
  // the time Landing mounts, that rewrite has already happened.
  scrollToPricing: boolean;
}

const FEATURES = [
  {
    title: "Smart Scheduling",
    body: "Queue up a one-time post for exactly when you want it to go out. Set it once and move on with your day.",
  },
  {
    title: "Recurring Schedules",
    body: "Set up a weekly content cadence once: pick the days, the time, and the platforms, and LazyRelay keeps posting it every week until you pause or delete it.",
  },
  {
    title: "Auto Posting",
    body: "LazyRelay checks in every 30 seconds and sends your posts out the moment they're due, no manual clicking required.",
  },
  {
    title: "Proof-of-Publish",
    body: "Every post is independently verified as actually live on the platform, not just \"sent,\" but confirmed.",
  },
];

// Real posts from LazyRelay's own connected accounts, each independently
// confirmed live (Proof-of-Publish) before being added here. Not a mockup —
// see project-lazyrelay-vs-socialbee-feature-roadmap-2026-08-16 in the vault
// for why this exists (deliberate cross-platform credibility, not just one
// example). Refresh this list if any of these accounts is ever disconnected.
const PROOF_POSTS = [
  { platform: "pinterest", handle: "lazydownload", content: "Simplify your life with LazyRelay: schedule once, post everywhere, with real Proof-of-Publish verification." },
  { platform: "mastodon", handle: "lazyrelay", content: "Real talk: scheduling posts across 13+ platforms should not mean logging into 13+ dashboards. LazyRelay handles it from one place, with Proof-of-Publish confirming every post actually went live." },
  { platform: "bluesky", handle: "lazyrelay.bsky.social", content: "Schedule once, publish everywhere. LazyRelay verifies every post actually went live, not just accepted." },
  { platform: "telegram", handle: "LazyRelay", content: "LazyRelay update: schedule your content once and publish it across every platform your business runs on, with real Proof-of-Publish verification confirming it actually went live." },
  { platform: "discord", handle: "LazyRelay", content: "New from LazyRelay: schedule a post once, publish it everywhere, and know for certain it went live with real Proof-of-Publish verification." },
  { platform: "tumblr", handle: "lazyrelay", content: "Simplify your social media: schedule your posts once with LazyRelay and publish everywhere, with real Proof-of-Publish verification confirming they actually went live." },
  { platform: "youtube", handle: "LazyRelay", content: "LazyRelay: schedule once, publish everywhere. Real Proof-of-Publish verification confirms every post actually went live." },
  { platform: "tiktok", handle: "LazyRelay", content: "Schedule once. Publish everywhere. LazyRelay." },
  { platform: "threads", handle: "thelazydownload", content: "Schedule once. Publish everywhere. LazyRelay confirms every post actually went live with real Proof-of-Publish verification." },
];

const MORE_FEATURES = [
  "Analytics dashboard: total posts, per-platform success rates, and a daily volume trend",
  "Content calendar: plan by day, pick the platform(s) and add media, then schedule it with one tick — no re-entry",
  "Notification bell: a header alert for new mentions and DMs, so nothing sits unread in a tab you never opened",
  "Bulk CSV import: schedule up to 200 posts at once, with a per-row preview first",
  "AI captions & hashtags: generate wording or tags from your draft in one click",
  "Best-time suggestions: general, platform-by-platform posting-time guidance",
  "Approval workflow: mark a post as needing sign-off before it goes out",
  "Link-in-bio page: a simple, hosted link page you can share as one URL",
  "Comment tracking: see comments on your own Facebook, Instagram, YouTube, Mastodon, and Bluesky posts",
  "Browser extension: right-click any page, link, or image to send it to LazyRelay",
];

const STEPS = [
  { title: "Connect your accounts", body: "Link the social accounts you want to post to." },
  { title: "Schedule your content", body: "Write a one-time post, or set up a recurring weekly schedule once." },
  { title: "It happens automatically", body: "LazyRelay posts it for you and confirms it's live." },
];

const PRICING = [
  {
    tier: "free" as const,
    name: "Free",
    price: "$0",
    note: "Get started, no card required",
    features: ["3 connected accounts", "1 brand", "10 posts per account, refillable", "One-time scheduled posts only", "250MB storage", "Proof-of-Publish verification"],
    cta: "Get started free",
  },
  {
    tier: "starter" as const,
    name: "Starter",
    price: "$29.99",
    note: "For creators posting regularly",
    features: ["20 connected accounts", "2 brands", "Unlimited scheduled posts", "3 recurring schedules", "AI-agent / MCP access", "5GB storage", "Proof-of-Publish verification"],
    cta: "Get started",
  },
  {
    tier: "pro" as const,
    name: "Pro",
    price: "$59.99",
    note: "For creators and small businesses",
    features: ["30 connected accounts", "4 brands", "Unlimited scheduled posts", "5 recurring schedules", "AI-agent / MCP access", "10GB storage", "Priority support", "Proof-of-Publish verification"],
    cta: "Get started",
    featured: true,
  },
  {
    tier: "business" as const,
    name: "Business",
    price: "$99.99",
    note: "For running several brands solo",
    features: ["50 connected accounts", "7 brands", "2 team seats included", "Unlimited scheduled posts", "Unlimited recurring schedules", "AI-agent / MCP access", "20GB storage", "Priority support", "Proof-of-Publish verification"],
    cta: "Get started",
  },
];

// Kept separate from PRICING, revealed via the "See Agency plans" button
// below rather than appended inline -- 6 cards in one row doesn't fit the
// home screen (Werner, 2026-08-17).
const AGENCY_PRICING = [
  {
    tier: "agency" as const,
    name: "Agency",
    price: "$149.99",
    note: "For agencies running client work with a small team",
    features: ["100 connected accounts", "12 brands", "3 team seats included (+2 more available)", "Unlimited scheduled posts", "Unlimited recurring schedules", "AI-agent / MCP access", "20GB storage", "Priority support", "Proof-of-Publish verification"],
    cta: "Get started",
  },
  {
    tier: "agency_plus" as const,
    name: "Agency Plus",
    price: "$199.99",
    note: "For larger agencies that have outgrown Agency",
    features: ["150 connected accounts", "20 brands", "6 team seats included (+2 more available)", "Unlimited scheduled posts", "Unlimited recurring schedules", "AI-agent / MCP access", "20GB storage", "Priority support", "Proof-of-Publish verification"],
    cta: "Get started",
  },
];

// Fact-based comparison, not a named-competitor callout — every row is a
// real, checkable claim about LazyRelay's own product, phrased generically
// against the category ("typical schedulers") rather than any one company.
// Built 2026-08-25 after a real competitive audit (LazyRelay vs. Ayrshare,
// the genuine top result for "social media API for AI agents") surfaced
// this exact gap: LazyRelay had no head-to-head comparison anywhere on the
// page, which the audit's own source material (a real marketing-agency
// technique, independently verified) flagged as one of the highest-value,
// easiest wins on a service page.
const COMPARISON = [
  { label: "How you use it", us: "Real dashboard — click, don't code", them: "API/CLI only, or a dashboard bolted onto an API-first tool" },
  { label: "Pricing", us: "Shown on the homepage, every tier", them: "Often hidden behind “Contact sales”" },
  { label: "Platform coverage", us: "12 platforms, including Mastodon, Bluesky, Telegram, Discord, and Tumblr", them: "Usually stops at the big four or five" },
  { label: "“Sent” vs. “live”", us: "Proof-of-Publish independently confirms a post is actually live", them: "“Sent” is treated as done" },
  { label: "Getting started", us: "Free tier, no card required", them: "A card is often required just to try it" },
];

// Platforms LazyRelay's own developer app has genuinely passed that
// platform's own review process for, as of 2026-08-25 (Pinterest, TikTok,
// YouTube/Google all APPROVED; Facebook Pages posting approved, Instagram
// content publish still in review). Deliberately does NOT include
// Instagram (pending), Snapchat (not yet offered to customers), or the
// no-review platforms (Bluesky/Mastodon/Telegram/Discord, which use
// app-password/self-service auth with no review process to pass) --
// overstating any of those would contradict the disclaimer already in this
// page's own footer ("not affiliated with, endorsed by, or sponsored by").
// "Passed review" is a true, narrower claim than "official partner" and
// doesn't conflict with it. Update this list only after independently
// re-confirming a platform's status in its own dashboard, not from memory.
const REVIEWED_PLATFORMS = ["pinterest", "tiktok", "youtube", "facebook"] as const;

const FAQ = [
  {
    q: "What does LazyRelay actually do?",
    a: "You write a post, pick when it should go out, and LazyRelay publishes it to your connected accounts automatically, then confirms it's actually live.",
  },
  {
    q: "Does LazyRelay write or generate content for me?",
    a: "No. You write the post. LazyRelay only handles scheduling and publishing.",
  },
  {
    q: "Which platforms are supported?",
    a: "Facebook, Instagram, TikTok, Pinterest, YouTube, LinkedIn, Threads, Mastodon, Bluesky, Telegram, Discord, and Tumblr. Mastodon support today connects to mastodon.social specifically — other Mastodon instances aren't supported yet.",
  },
  {
    q: "Can I set up a recurring posting schedule instead of scheduling each post one at a time?",
    a: "Yes. Set up a recurring schedule once: content, days of the week, time, and which connected accounts it goes to, and LazyRelay keeps posting it every week automatically. You can pause it any time without losing the setup, resume whenever you're ready, or delete it outright. Free is one-time posts only; Starter gets 3 recurring schedules, Pro gets 5, and Business is unlimited.",
  },
  {
    q: "Is it free?",
    a: "There's a genuinely free tier with no card required, and paid Starter/Pro/Business tiers if you need more connected accounts or unlimited posts. You can start free and upgrade later from your dashboard whenever you're ready.",
  },
  {
    q: "What happens if a post fails to publish?",
    a: "We don't mark a post as done just because it was sent. LazyRelay separately verifies it's actually live. If that check fails, you'll see it flagged in your dashboard, not silently hidden.",
  },
  {
    q: "Are there limits on post length, images, or videos?",
    a: "LazyRelay doesn't set its own limits. We follow whatever the platform you're posting to requires and allows at the time. See the disclaimer below for details.",
  },
];

export function Landing({ onSignIn, onGetStarted, onPrivacy, onTerms, onDpa, onContact, onDocs, scrollToPricing }: LandingProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAgencyPricing, setShowAgencyPricing] = useState(false);

  // Anyone arriving at /pricing (e.g. the "See plans" links used across
  // every guide/tool page) should land ON the pricing section, not the
  // hero. Previously this lived in App.tsx's Root, gated on the auth
  // session check resolving (`!loading`) -- but that check can take a
  // couple of seconds, so visitors saw the page sit at the top (or a
  // loading spinner) and then get visibly yanked down once it resolved.
  // Doing it here with useLayoutEffect instead fires synchronously before
  // the browser paints Landing's first frame, so it's already scrolled
  // into place with no visible jump at all. Found live via a site audit,
  // fixed 2026-08-10.
  useLayoutEffect(() => {
    if (scrollToPricing) {
      document.getElementById("pricing")?.scrollIntoView();
    }
    // scrollToPricing reflects App.tsx's INITIAL_PATH, captured once at
    // module load -- deliberately not re-checked on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileMenuOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  return (
    <div className="landing">
      <CircuitBackground />
      <header className="landing-nav">
        <div className="wordmark">
          <BrandMark size={40} />
          <span>LazyRelay</span>
        </div>
        <button
          type="button"
          className="mobile-menu-toggle"
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-nav-menu"
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMobileMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{mobileMenuOpen ? "✕" : "☰"}</span>
        </button>
        <nav className="landing-nav-links">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
          <a href="#about">About</a>
          <a href="/guides">Guides</a>
          <button className="link" onClick={onDocs}>
            Docs
          </button>
          <button className="link" onClick={onContact}>
            Contact
          </button>
          <button className="link" onClick={onSignIn}>
            Sign in
          </button>
        </nav>
      </header>

      {mobileMenuOpen && (
        <nav id="mobile-nav-menu" className="mobile-nav-menu">
          <a href="#features" onClick={() => setMobileMenuOpen(false)}>
            Features
          </a>
          <a href="#pricing" onClick={() => setMobileMenuOpen(false)}>
            Pricing
          </a>
          <a href="#faq" onClick={() => setMobileMenuOpen(false)}>
            FAQ
          </a>
          <a href="#about" onClick={() => setMobileMenuOpen(false)}>
            About
          </a>
          <a href="/guides" onClick={() => setMobileMenuOpen(false)}>
            Guides
          </a>
          <button
            className="link"
            onClick={() => {
              setMobileMenuOpen(false);
              onDocs();
            }}
          >
            Docs
          </button>
          <button
            className="link"
            onClick={() => {
              setMobileMenuOpen(false);
              onContact();
            }}
          >
            Contact
          </button>
          <button
            className="link"
            onClick={() => {
              setMobileMenuOpen(false);
              onSignIn();
            }}
          >
            Sign in
          </button>
        </nav>
      )}

      <section className="landing-hero">
        <h1 className="landing-hero-headline">Schedule everywhere. Know it's actually live.</h1>
        <p className="landing-hero-subtext">
          LazyRelay posts to Facebook, Instagram, TikTok, and 9 more platforms, then independently verifies
          each one actually went live.
        </p>
        <img
          src={banner}
          alt="LazyRelay: automate, schedule, publish, repeat"
          width={1983}
          height={793}
          fetchPriority="high"
        />
        <button className="cta" onClick={onGetStarted}>
          Get started free
        </button>
      </section>

      <section className="landing-section">
        <h2>How it works</h2>
        <div className="landing-steps">
          {STEPS.map((step, i) => (
            <div className="landing-step" key={step.title}>
              <span className="step-number">{i + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" id="features">
        <h2>What you get</h2>
        <p className="section-note">
          Everything works from a real dashboard, not just an API. Comments, DMs, auto-replies, and analytics
          are all clickable, not command-line only.
        </p>
        <div className="landing-features">
          {FEATURES.map((f) => (
            <div className="landing-feature" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
        <p className="landing-proof-caption">Real posts from LazyRelay's own connected accounts, exactly as they appear in the dashboard:</p>
        <div className="landing-proof-marquee">
          <ul className="landing-proof-track">
            {[...PROOF_POSTS, ...PROOF_POSTS].map((post, i) => (
              <li key={`${post.platform}-${i}`} className="post-status-posted landing-proof-item">
                <div className="post-platform">
                  <PlatformIcon platform={post.platform} size={14} />
                  {post.handle}
                </div>
                <div className="post-content">{post.content}</div>
                <div className="post-meta">
                  <span className="status-badge status-posted">posted</span>
                  <span className="verified">
                    <RelaySignal size={14} pulsing /> Confirmed live
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <ul className="landing-more-features">
          {MORE_FEATURES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="landing-section landing-platforms">
        <h2>Works with</h2>
        <p className="section-note">
          <strong>The scheduler for the platforms Big Social forgot.</strong> Most tools cover the big four
          or five platforms and stop. LazyRelay covers Mastodon, Bluesky, Telegram, Discord, and Tumblr too,
          not as an afterthought.
        </p>
        <div className="platform-row">
          <PlatformIcon platform="facebook" size={40} />
          <PlatformIcon platform="instagram" size={40} />
          <PlatformIcon platform="tiktok" size={40} />
          <PlatformIcon platform="pinterest" size={40} />
          <PlatformIcon platform="youtube" size={40} />
          <PlatformIcon platform="linkedin" size={40} />
          <PlatformIcon platform="threads" size={40} />
          <PlatformIcon platform="mastodon" size={40} />
          <PlatformIcon platform="bluesky" size={40} />
          <PlatformIcon platform="telegram" size={40} />
          <PlatformIcon platform="discord" size={40} />
          <PlatformIcon platform="tumblr" size={40} />
        </div>
        <div className="zapier-callout">
          <span>
            {/* Kept on one line, no split JSX whitespace around the link --
                a `via{" "}` + newline pattern here rendered as "via " vs
                "via" depending on whether the text came from a live DOM's
                own innerHTML serialization (this page's prerender step) or
                React's virtual-DOM text-node reconciliation, and the two
                disagreeing was a real hydration mismatch (found live
                2026-08-25, see main.tsx). One unambiguous text node avoids
                the whole class of issue. */}
            Plus connects to <strong>9,000+ other apps</strong> via <a href="/connect-zapier">Zapier</a>
          </span>
        </div>
      </section>

      <section className="landing-section landing-comparison">
        <h2>Why LazyRelay instead of a typical scheduler</h2>
        <table className="comparison-table">
          <thead>
            <tr>
              <th scope="col"></th>
              <th scope="col">LazyRelay</th>
              <th scope="col">Typical schedulers</th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON.map((row) => (
              <tr key={row.label}>
                <th scope="row" className="comparison-row-label">
                  {row.label}
                </th>
                <td className="comparison-cell-us">{row.us}</td>
                <td className="comparison-cell-them">{row.them}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="landing-section landing-pricing" id="pricing">
        <h2>Pricing</h2>
        <div className="pricing-grid">
          {PRICING.map((plan) => (
            <div className={plan.featured ? "pricing-card-wrap" : "pricing-card-wrap pricing-card-wrap-plain"} key={plan.tier}>
              {plan.featured && <span className="badge-soon pricing-badge">Most popular</span>}
              <div className={plan.featured ? "pricing-card pricing-card-featured" : "pricing-card"}>
                <h3>{plan.name}</h3>
                <p className="pricing-price">
                  {plan.price}
                  {plan.tier !== "free" && <span className="pricing-period">/mo</span>}
                </p>
                <p className="pricing-note">{plan.note}</p>
                <ul>
                  {plan.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <button className="cta" onClick={onGetStarted}>
                  {plan.cta}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="section-note pricing-footnote">
          Start on Free, upgrade to Starter, Pro, Business, Agency, or Agency Plus any time from your dashboard.
        </p>

        {!showAgencyPricing && (
          <button type="button" className="btn-outline pricing-agency-toggle" onClick={() => setShowAgencyPricing(true)}>
            Running an agency? See Agency plans &rarr;
          </button>
        )}

        {showAgencyPricing && (
          <div className="pricing-grid pricing-grid-agency">
            {AGENCY_PRICING.map((plan) => (
              <div className="pricing-card-wrap pricing-card-wrap-plain" key={plan.tier}>
                <div className="pricing-card">
                  <h3>{plan.name}</h3>
                  <p className="pricing-price">
                    {plan.price}
                    <span className="pricing-period">/mo</span>
                  </p>
                  <p className="pricing-note">{plan.note}</p>
                  <ul>
                    {plan.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <button className="cta" onClick={onGetStarted}>
                    {plan.cta}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="landing-section" id="faq">
        <h2>Frequently asked questions</h2>
        <div className="faq-list">
          {FAQ.map((item) => (
            <div className="faq-item" key={item.q}>
              <h3>{item.q}</h3>
              <p>{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" id="ai-honesty">
        <h2>How we label AI features</h2>
        <p className="about-text">
          LazyRelay's AI captions and hashtag suggestions can now be personalized to your brand voice — set a
          default voice for your account, or a different one per brand if you run more than one. Without a voice
          set, suggestions use a generic tone. Either way, treat AI suggestions as a starting draft, not a
          finished post.
        </p>
      </section>

      <section className="landing-section" id="about">
        <h2>About</h2>
        <p className="about-text">
          LazyRelay started as a way to stop manually posting the same content to every platform, one at a
          time. We're a small, early-stage tool focused on doing one thing well: getting your posts
          published reliably, with real proof they actually went live, not just a "sent" message you have
          to trust.
        </p>
      </section>

      <footer className="landing-footer">
        <div className="wordmark">
          <BrandMark size={22} />
          <span>LazyRelay</span>
        </div>
        <p className="platform-reviewed-note">
          Reviewed and approved by the platform itself, not just self-declared:
        </p>
        <div className="platform-row platform-row-reviewed">
          {REVIEWED_PLATFORMS.map((p) => (
            <span className="platform-reviewed-badge" key={p}>
              <PlatformIcon platform={p} size={22} />
            </span>
          ))}
        </div>
        <div className="landing-disclaimer">
          <p>
            LazyRelay is not affiliated with, endorsed by, or sponsored by any of the platforms it
            connects to. We connect using each platform's official APIs and comply with each
            platform's own Terms of Service.
          </p>
          <p>
            LazyRelay doesn't set its own limits on post length, images, or videos. We follow whatever
            each connected platform requires and allows at the time of posting. These limits can change on
            the platform's side at any time. It's your responsibility to make sure your content complies
            with each platform's own guidelines and terms.
          </p>
        </div>
        <p className="landing-footer-links">
          <button className="link" onClick={onContact}>
            Contact
          </button>
          <button className="link" onClick={onDocs}>
            API &amp; MCP docs
          </button>
          <a className="link" href="/guides">
            Guides
          </a>
          <a className="link" href="/status">
            Status
          </a>
          <a className="link" href="/changelog">
            Changelog
          </a>
          <button className="link" onClick={onPrivacy}>
            Privacy Policy
          </button>
          <button className="link" onClick={onTerms}>
            Terms of Service
          </button>
          <button className="link" onClick={onDpa}>
            Data Processing Addendum
          </button>
          <a className="link" href="/refunds">
            Refund Policy
          </a>
          <a className="link" href="/data-deletion">
            Data Deletion
          </a>
          <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a>
        </p>
        {/* One template-string expression, not "text {expr} text" as three
            separate JSX children -- same class of issue as the zapier-callout
            comment above, same fix. */}
        <p>{`© ${new Date().getFullYear()} LazyRelay. All rights reserved.`}</p>
        <div className="landing-footer-badges">
          <a
            href="https://startupfa.me/s/lazyrelay?utm_source=lazyrelay.com"
            target="_blank"
            rel="noopener noreferrer"
            className="startup-fame-badge"
          >
            <img
              src="https://startupfa.me/badges/featured-badge-small.webp"
              alt="LazyRelay - Featured on Startup Fame"
              width={224}
              height={36}
            />
          </a>
          <a
            href="https://smollaunch.com"
            target="_blank"
            rel="noopener noreferrer"
            className="smol-launch-badge"
          >
            <img
              src="https://smollaunch.com/badges/featured.svg"
              alt="LazyRelay - Featured on Smol Launch"
              width={250}
              height={60}
              loading="lazy"
            />
          </a>
          <a
            href="https://turbo0.com/item/lazyrelay"
            target="_blank"
            rel="noopener noreferrer"
            className="turbo0-badge"
          >
            <img
              src="https://img.turbo0.com/badge-listed-light.svg"
              alt="Listed on Turbo0"
              height={54}
              loading="lazy"
            />
          </a>
        </div>
      </footer>
      <SupportWidget context="public" />
    </div>
  );
}
