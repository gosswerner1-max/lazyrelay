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
          If you have a real audience that covers tools like this, there's a genuine, ongoing commission for
          sending customers our way, not a one-time bounty. Pick whichever structure fits you when you apply.
        </p>

        <div className="pricing-grid">
          <div className="pricing-card-wrap">
            <div className="pricing-card">
              <h3>Plan A</h3>
              <p className="pricing-note">Your audience gets a discount too</p>
              <ul>
                <li>Your referral code also gives your audience 10% off their first 3 months</li>
                <li>You earn 20% of what they pay, for 12 months</li>
                <li>Good fit if the discount itself helps you convert your audience</li>
              </ul>
            </div>
          </div>
          <div className="pricing-card-wrap">
            <div className="pricing-card">
              <h3>Plan B</h3>
              <p className="pricing-note">No discount, higher commission</p>
              <ul>
                <li>No discount for your audience</li>
                <li>You earn 30% for the first 3 months, then 20% for the next 9</li>
                <li>Good fit if your audience doesn't need a discount to convert</li>
              </ul>
            </div>
          </div>
        </div>

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
