import { useEffect } from "react";
import { BrandMark } from "../components/BrandMark";
import { CircuitBackground } from "../components/CircuitBackground";

interface ContactProps {
  onBack: () => void;
}

const MAILBOXES = [
  {
    address: "hello@lazyrelay.com",
    label: "General & press",
    body: "Questions about LazyRelay, partnership inquiries, or anything that doesn't fit the categories below.",
  },
  {
    address: "support@lazyrelay.com",
    label: "Support",
    body: "Something not working, a question about how to use LazyRelay, or help connecting an account.",
  },
  {
    address: "accounts@lazyrelay.com",
    label: "Billing & account",
    body: "Subscription, billing, or account-access questions.",
  },
];

export function Contact({ onBack }: ContactProps) {
  // Every React-rendered standalone view shares the same index.html shell,
  // which never had its <title> updated per-view -- browser tab always
  // read the homepage's title regardless of which page you were actually
  // on. Found live via a site audit, fixed 2026-08-10 (same fix applied
  // to ApiDocs, TermsOfService, PrivacyPolicy, DataDeletion).
  useEffect(() => {
    const previous = document.title;
    document.title = "Contact | LazyRelay";
    return () => {
      document.title = previous;
    };
  }, []);

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
        <h2>Contact us</h2>
        <p className="section-note">
          Pick whichever fits best. We read all three, but the right inbox gets you a faster answer.
        </p>

        <div className="contact-list">
          {MAILBOXES.map((m) => (
            <div className="contact-card" key={m.address}>
              <h3>{m.label}</h3>
              <p>{m.body}</p>
              <a href={`mailto:${m.address}`}>{m.address}</a>
            </div>
          ))}
        </div>
      </section>

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
