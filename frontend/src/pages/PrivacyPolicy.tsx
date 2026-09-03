import { useEffect } from "react";
import { BrandMark } from "../components/BrandMark";
import { CircuitBackground } from "../components/CircuitBackground";
import { useCanonical } from "../lib/useCanonical";

interface PrivacyPolicyProps {
  onBack: () => void;
}

const LAST_UPDATED = "3 September 2026";

export function PrivacyPolicy({ onBack }: PrivacyPolicyProps) {
  useEffect(() => {
    const previous = document.title;
    document.title = "Privacy Policy | LazyRelay";
    return () => {
      document.title = previous;
    };
  }, []);
  useCanonical("/privacy");

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
        <h2>Privacy Policy</h2>
        <p className="section-note">Last updated {LAST_UPDATED}</p>

        <div className="about-text legal-body">
          <p>
            LazyRelay ("we," "us," or "our") provides a scheduling and publishing tool that connects to your
            social media accounts so you can queue up posts and have them published automatically. This policy
            explains what information we collect, how we use it, and the choices you have.
          </p>
          <p>
            LazyRelay is operated by IPE Projects (Pty) Ltd, a company registered in South Africa (registration
            number 2021/003176/07).
          </p>

          <h3>Information we collect</h3>
          <p>
            <strong>Account information.</strong> When you sign up, we collect your email address and a
            password (stored securely by our authentication provider, never in plain text).
          </p>
          <p>
            <strong>Connected account information.</strong> When you connect a social media account (any
            platform you connect to LazyRelay), we receive an access token and basic profile information
            (account name, platform, account ID) from that platform via its official OAuth process. We use
            this token only to publish the posts you schedule and to verify they went live. We never read your
            private messages, contacts, or unrelated account activity.
          </p>
          <p>
            <strong>Content you submit.</strong> The post text, images, and scheduling details you enter into
            LazyRelay are stored so we can publish them at the time you choose.
          </p>
          <p>
            <strong>Usage data.</strong> We collect basic technical information (like error logs) to keep the
            service running reliably. We do not use tracking cookies for advertising.
          </p>

          <h3>How we use your information</h3>
          <ul>
            <li>To publish your scheduled posts to the accounts you've connected.</li>
            <li>To verify that a published post is actually live on the platform.</li>
            <li>To operate, maintain, and troubleshoot the service.</li>
            <li>To respond to support requests you send us.</li>
          </ul>
          <p>We do not sell your data, and we do not share it with third parties except:</p>
          <ul>
            <li>The social media platforms you've explicitly connected, solely to publish your content.</li>
            <li>Service providers that host our infrastructure (e.g. our database and hosting providers), bound to keep your data confidential.</li>
            <li>When required by law.</li>
          </ul>

          <h3>AI features and Google user data</h3>
          <p>
            LazyRelay uses Anthropic's Claude API for two optional features: generating post captions on request,
            and classifying incoming social media comments and DMs. Separately, LazyRelay offers an MCP (Model
            Context Protocol) server that lets you connect a third-party AI assistant of your own choosing (for
            example Claude or ChatGPT) to manage your own scheduled posts through our API — any request through
            that connection is initiated by your own AI client, under your own authorization, not by LazyRelay.
          </p>
          <p>
            If you connect Google Calendar or Google Sheets, we do not use raw or derived data obtained through
            those Google APIs to train, retrain, or improve any AI or machine learning model, foundational or
            otherwise. That data is used exclusively to provide the calendar-sync and spreadsheet-sync
            functionality you've authorized, and is never transferred to Anthropic, to any AI assistant you
            connect via our MCP server, or to any other third party for model-training purposes.
          </p>

          <h3>Data retention</h3>
          <p>
            We keep your account and connected-account data for as long as your account is active. If you
            disconnect a social account or delete your LazyRelay account, we remove the associated access
            tokens and stored content within a reasonable time.
          </p>

          <h3>Your choices</h3>
          <ul>
            <li>You can disconnect any connected social account at any time from your dashboard.</li>
            <li>You can request deletion of your account and associated data by contacting us.</li>
            <li>You can request a copy of the data we hold about you by contacting us.</li>
          </ul>

          <h3>Security</h3>
          <p>
            We use industry-standard practices (encrypted connections, secure token storage) to protect your
            information. No method of transmission or storage is 100% secure, but we work to protect your data
            to the best of our ability.
          </p>

          <h3>Children's privacy</h3>
          <p>LazyRelay is not directed at children under 16, and we do not knowingly collect data from them.</p>

          <h3>Changes to this policy</h3>
          <p>
            If we make material changes to this policy, we'll update the "Last updated" date above and, where
            appropriate, notify you directly.
          </p>

          <h3>Contact us</h3>
          <p>
            Questions about this policy or your data? Email us at{" "}
            <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a>.
          </p>
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
