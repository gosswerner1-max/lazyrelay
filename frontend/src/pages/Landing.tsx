import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import banner from "../assets/banner.png";

interface LandingProps {
  onSignIn: () => void;
  onGetStarted: () => void;
  onPrivacy: () => void;
  onTerms: () => void;
  onContact: () => void;
}

const FEATURES = [
  {
    title: "Smart Scheduling",
    body: "Queue up a one-time post for exactly when you want it to go out — set it once and move on with your day.",
  },
  {
    title: "Recurring Schedules",
    body: "Set up a weekly content cadence once — pick the days, the time, and the platforms — and LazyRelay keeps posting it every week until you pause or delete it.",
  },
  {
    title: "Auto Posting",
    body: "LazyRelay checks in every 30 seconds and sends your posts out the moment they're due, no manual clicking required.",
  },
  {
    title: "Proof-of-Publish",
    body: "Every post is independently verified as actually live on the platform — not just \"sent,\" but confirmed.",
  },
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
    features: ["3 connected accounts", "10 posts per account, refillable", "One-time scheduled posts only", "250MB storage", "Proof-of-Publish verification"],
    cta: "Get started free",
  },
  {
    tier: "starter" as const,
    name: "Starter",
    price: "$24.99",
    note: "For creators posting regularly",
    features: ["20 connected accounts", "Unlimited scheduled posts", "3 recurring schedules", "AI-agent / MCP access", "5GB storage", "Proof-of-Publish verification"],
    cta: "Get started",
  },
  {
    tier: "pro" as const,
    name: "Pro",
    price: "$48.99",
    note: "For growing teams",
    features: ["40 connected accounts", "Unlimited scheduled posts", "5 recurring schedules", "AI-agent / MCP access", "10GB storage", "Priority support"],
    cta: "Get started",
    featured: true,
  },
  {
    tier: "business" as const,
    name: "Business",
    price: "$79.99",
    note: "For agencies at scale",
    features: ["100 connected accounts", "Unlimited scheduled posts", "Unlimited recurring schedules", "AI-agent / MCP access", "20GB storage", "Priority support"],
    cta: "Get started",
  },
];

const FAQ = [
  {
    q: "What does LazyRelay actually do?",
    a: "You write a post, pick when it should go out, and LazyRelay publishes it to your connected accounts automatically — then confirms it's actually live.",
  },
  {
    q: "Does LazyRelay write or generate content for me?",
    a: "No. You write the post. LazyRelay only handles scheduling and publishing.",
  },
  {
    q: "Which platforms are supported?",
    a: "Meta (Facebook/Instagram), TikTok, and Pinterest.",
  },
  {
    q: "Can I set up a recurring posting schedule instead of scheduling each post one at a time?",
    a: "Yes. Set up a recurring schedule once — content, days of the week, time, and which connected accounts it goes to — and LazyRelay keeps posting it every week automatically. You can pause it any time without losing the setup, resume whenever you're ready, or delete it outright. Free is one-time posts only; Starter gets 3 recurring schedules, Pro gets 5, and Business is unlimited.",
  },
  {
    q: "Is it free?",
    a: "There's a genuinely free tier with no card required, and paid Starter/Pro/Business tiers if you need more connected accounts or unlimited posts. You can start free and upgrade later from your dashboard whenever you're ready.",
  },
  {
    q: "What happens if a post fails to publish?",
    a: "We don't mark a post as done just because it was sent — LazyRelay separately verifies it's actually live. If that check fails, you'll see it flagged in your dashboard, not silently hidden.",
  },
  {
    q: "Are there limits on post length, images, or videos?",
    a: "LazyRelay doesn't set its own limits — we follow whatever the platform you're posting to requires and allows at the time. See the disclaimer below for details.",
  },
];

export function Landing({ onSignIn, onGetStarted, onPrivacy, onTerms, onContact }: LandingProps) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="wordmark">
          <BrandMark size={28} />
          <span>LazyRelay</span>
        </div>
        <nav className="landing-nav-links">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
          <a href="#about">About</a>
          <button className="link" onClick={onContact}>
            Contact
          </button>
          <button className="link" onClick={onSignIn}>
            Sign in
          </button>
        </nav>
      </header>

      <section className="landing-hero">
        <img src={banner} alt="LazyRelay — automate, schedule, publish, repeat" />
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
        <div className="landing-features">
          {FEATURES.map((f) => (
            <div className="landing-feature" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-platforms">
        <h2>Works with</h2>
        <p className="section-note">
          Connect your accounts and start posting today.
        </p>
        <div className="platform-row">
          <PlatformIcon platform="meta" size={28} />
          <PlatformIcon platform="tiktok" size={28} />
          <PlatformIcon platform="pinterest" size={28} />
        </div>
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
          Start on Free, upgrade to Starter, Pro, or Business any time from your dashboard.
        </p>
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

      <section className="landing-section" id="about">
        <h2>About</h2>
        <p className="about-text">
          LazyRelay started as a way to stop manually posting the same content to every platform, one at a
          time. We're a small, early-stage tool focused on doing one thing well: getting your posts
          published reliably, with real proof they actually went live — not just a "sent" message you have
          to trust.
        </p>
      </section>

      <footer className="landing-footer">
        <div className="wordmark">
          <BrandMark size={22} />
          <span>LazyRelay</span>
        </div>
        <div className="landing-disclaimer">
          <p>
            LazyRelay is not affiliated with, endorsed by, or sponsored by Meta, TikTok, or Pinterest.
            We connect to these platforms using their official APIs and comply with each platform's own
            Terms of Service.
          </p>
          <p>
            LazyRelay doesn't set its own limits on post length, images, or videos — we follow whatever
            each connected platform requires and allows at the time of posting. These limits can change on
            the platform's side at any time. It's your responsibility to make sure your content complies
            with each platform's own guidelines and terms.
          </p>
        </div>
        <p className="landing-footer-links">
          <button className="link" onClick={onContact}>
            Contact
          </button>
          <button className="link" onClick={onPrivacy}>
            Privacy Policy
          </button>
          <button className="link" onClick={onTerms}>
            Terms of Service
          </button>
          <a className="link" href="/refunds">
            Refund Policy
          </a>
          <a className="link" href="/data-deletion">
            Data Deletion
          </a>
          <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a>
        </p>
        <p>&copy; {new Date().getFullYear()} LazyRelay. All rights reserved.</p>
      </footer>
    </div>
  );
}
