import { useEffect, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { CircuitBackground } from "../components/CircuitBackground";
import { ReferralApplicationModal } from "../components/ReferralApplicationModal";
import { useCanonical } from "../lib/useCanonical";

interface PartnersProps {
  onBack: () => void;
}

/** Standalone /partners page (2026-09-29) -- the referral program's own
 *  writeup previously only existed as a brief teaser + button on Landing.tsx
 *  (deliberately terse there, matching that page's other sections). This is
 *  the real, detailed version: what both commission structures actually pay,
 *  and the redemption-based attribution rule. Also the thing an outside
 *  affiliate-program directory needs to link to -- most of the ones checked
 *  require a dedicated program URL, not just a button buried on the homepage.
 *  Reuses ReferralApplicationModal directly rather than duplicating the
 *  form -- same component Landing.tsx's own button opens. */
export function Partners({ onBack }: PartnersProps) {
  const [applyOpen, setApplyOpen] = useState(false);

  useEffect(() => {
    const previous = document.title;
    document.title = "Partner Program | LazyRelay";
    return () => {
      document.title = previous;
    };
  }, []);
  useCanonical("/partners");

  return (
    <div className="landing">
      <CircuitBackground />
      <header className="landing-nav">
        <div className="wordmark">
          <BrandMark size={28} />
          <span>LazyRelay</span>
        </div>
        <nav className="landing-nav-links">
          <button className="link" onClick={onBack}>
            &larr; Back to home
          </button>
        </nav>
      </header>

      <section className="landing-section legal-page">
        <h1>Partner with LazyRelay</h1>
        <p className="section-note">
          If you have a real audience that covers tools like this, there's a genuine commission for
          sending customers our way, not a one-time bounty. There is one simple plan.
        </p>

        <div className="pricing-grid pricing-grid-partners">
          <div className="pricing-card-wrap">
            <div className="pricing-card">
              <h3>20% for 6 months</h3>
              <p className="pricing-note">Your audience gets a discount too</p>
              <ul>
                <li>You earn 20% of what your customers pay, before tax, for 6 months from their first paid purchase</li>
                <li>Growth and Pro subscriptions pay you every month inside those 6 months</li>
                <li>If the customer cancels, commission on that subscription stops when it is cancelled</li>
                <li>Pay as you go credit packs pay you once, on the customer's first paid purchase</li>
                <li>Your audience gets 10% off their first month of Growth or Pro when they type your code at checkout</li>
              </ul>
            </div>
          </div>
        </div>

        <h2>Partner terms (draft summary)</h2>
        <p className="section-note">
          This is a plain summary, not final. The full terms are being read by a lawyer and may change before you are accepted.
        </p>
        <ul className="partner-terms-draft">
          <li>Commission is 20% of what the customer pays us, before tax, for 6 months from their first paid purchase.</li>
          <li>If the customer cancels their subscription, commission on that subscription stops when it is cancelled.</li>
          <li>Refunded amounts earn nothing, and commission is counted once a payment is 30 days old.</li>
          <li>You cannot earn commission on your own purchases.</li>
          <li>You label every post, video or mention that carries your link as a paid link or #ad.</li>
        </ul>

        <h2>How it works</h2>
        <div className="landing-steps">
          <div className="landing-step">
            <span className="step-number">1</span>
            <h3>Apply</h3>
            <p>Tell us about your channel below. We review every application ourselves.</p>
          </div>
          <div className="landing-step">
            <span className="step-number">2</span>
            <h3>Get your code</h3>
            <p>Once approved, you get a personal code built around your own channel name, not a generic link.</p>
          </div>
          <div className="landing-step">
            <span className="step-number">3</span>
            <h3>Earn on real customers</h3>
            <p>
              Commission is tracked when someone actually pays using your code at checkout, not just when they
              click your link. You get a notification the moment it happens.
            </p>
          </div>
        </div>

        <button type="button" className="cta" onClick={() => setApplyOpen(true)}>
          Apply to become a partner
        </button>
      </section>

      {applyOpen && <ReferralApplicationModal onClose={() => setApplyOpen(false)} />}

      <footer className="landing-footer">
        <div className="wordmark">
          <BrandMark size={22} />
          <span>LazyRelay</span>
        </div>
        <p>&copy; {new Date().getFullYear()} LazyRelay. All rights reserved.</p>
      </footer>
    </div>
  );
}
