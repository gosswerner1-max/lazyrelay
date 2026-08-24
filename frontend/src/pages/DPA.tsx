import { useEffect } from "react";
import { BrandMark } from "../components/BrandMark";
import { CircuitBackground } from "../components/CircuitBackground";
import { useCanonical } from "../lib/useCanonical";

interface DPAProps {
  onBack: () => void;
}

const LAST_UPDATED = "11 August 2026";

export function DPA({ onBack }: DPAProps) {
  useEffect(() => {
    const previous = document.title;
    document.title = "Data Processing Addendum | LazyRelay";
    return () => {
      document.title = previous;
    };
  }, []);
  useCanonical("/dpa");

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
        <h2>Data Processing Addendum</h2>
        <p className="section-note">Last updated {LAST_UPDATED}</p>

        <div className="about-text legal-body">
          <p>
            This Data Processing Addendum ("DPA") forms part of the agreement between you ("Customer," the
            data controller) and IPE Projects (Pty) Ltd, trading as LazyRelay, a company registered in South
            Africa (registration number 2021/003176/07) ("LazyRelay," the data processor). It applies whenever
            LazyRelay processes personal data on your behalf as part of providing the Service, and reflects our
            obligations under Article 28 of the EU General Data Protection Regulation (GDPR) and equivalent UK
            GDPR requirements. By using LazyRelay, you and LazyRelay agree to this DPA — no separate signature
            is required, though a countersigned copy is available on request (email{" "}
            <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a>).
          </p>

          <h3>Subject matter and duration</h3>
          <p>
            LazyRelay processes personal data on your behalf for as long as you have an active LazyRelay
            account, solely to provide the scheduling, publishing, and related features described in our{" "}
            <a href="/terms">Terms of Service</a>.
          </p>

          <h3>Nature and purpose of processing</h3>
          <p>
            LazyRelay processes personal data to: connect to and publish content on the social media accounts
            you authorize; verify that published posts are genuinely live; show you comments and direct
            messages sent to your connected accounts; classify comments/messages that may need your attention
            using AI; generate caption, hashtag, and content suggestions using AI; and provide customer support,
            including through our AI support assistant.
          </p>

          <h3>Types of personal data processed</h3>
          <ul>
            <li>Your own account details: email address, business/display name.</li>
            <li>
              Access tokens for the social media accounts you connect (encrypted at rest, never stored as
              plain text — see Security below).
            </li>
            <li>Content and media you upload to schedule for publishing.</li>
            <li>
              Comments and direct messages sent by people who interact with your connected social accounts —
              these are read live from each platform when you view them and are not stored by LazyRelay
              beyond an AI-generated classification (a category, e.g. "needs attention," plus a short
              summary reason of eight words or fewer) — never the verbatim message.
            </li>
            <li>Basic technical/usage data (e.g. error logs) needed to operate the Service reliably.</li>
          </ul>

          <h3>Categories of data subjects</h3>
          <ul>
            <li>You and anyone else with access to your LazyRelay account.</li>
            <li>
              People who comment on, or send direct messages to, the social media accounts you connect to
              LazyRelay — your own audience, not LazyRelay's.
            </li>
          </ul>

          <h3>LazyRelay's obligations as processor</h3>
          <p>LazyRelay agrees to:</p>
          <ul>
            <li>Process personal data only on your documented instructions, including regarding international transfers, unless required to do otherwise by law.</li>
            <li>Ensure anyone authorized to process personal data (including LazyRelay's own operator) is bound by confidentiality.</li>
            <li>Implement appropriate technical and organizational security measures (see Security below).</li>
            <li>Only engage a sub-processor with your general authorization (see Sub-processors below), and impose the same data protection obligations on any sub-processor it uses.</li>
            <li>Assist you, to the extent reasonably possible, in responding to requests from data subjects exercising their GDPR rights.</li>
            <li>Assist you in meeting obligations around the security of processing, breach notification, and data protection impact assessments, taking into account the nature of processing and information available to LazyRelay.</li>
            <li>At the end of the relationship, delete or return all personal data processed on your behalf, per the Data return and deletion section below.</li>
            <li>Make available information reasonably necessary to demonstrate compliance with this DPA, and allow for reasonable audits, subject to confidentiality and not disrupting the Service for other customers.</li>
          </ul>

          <h3>Sub-processors</h3>
          <p>
            You give LazyRelay general authorization to engage the sub-processors below, each of which is
            bound by its own data protection agreement with LazyRelay incorporating GDPR Standard Contractual
            Clauses for any transfer outside the EU/UK:
          </p>
          <ul>
            <li><strong>Supabase</strong> (database and authentication) — EU-hosted (Ireland), SOC 2 Type II certified.</li>
            <li><strong>Render</strong> (application hosting) — US-hosted (Oregon), SOC 2 Type II certified.</li>
            <li><strong>Anthropic</strong> (AI features: support assistant, caption/hashtag suggestions, comment classification) — SOC 2 Type II certified; does not train its models on this data, and API inputs/outputs are deleted within 30 days by default.</li>
            <li><strong>Resend</strong> (transactional email) — US-hosted, SOC 2 Type II certified.</li>
            <li><strong>Paddle.com</strong> (billing, as merchant of record) — SOC 2 Type II and PCI-DSS certified; card details are handled entirely by Paddle and never reach LazyRelay's own systems.</li>
          </ul>
          <p>
            If LazyRelay adds or replaces a sub-processor that would materially change how your personal data
            is handled, we'll update this page and, where appropriate, notify you directly at least 14 days in
            advance. You may object on reasonable data-protection grounds within that period; if we can't
            resolve your objection, either you or LazyRelay may terminate the affected part of the Service
            without penalty.
          </p>

          <h3>International transfers</h3>
          <p>
            Personal data processed under this DPA may be transferred to and processed in the United States (via
            Render, Anthropic, Resend, and Paddle) as well as the EU (via Supabase). Each such transfer is
            covered by Standard Contractual Clauses under that sub-processor's own data processing agreement, as
            referenced above.
          </p>

          <h3>Security</h3>
          <p>
            Social media access tokens are encrypted and stored separately from ordinary database records,
            accessible only through LazyRelay's own backend — never as plain text in any table. Connections
            between your browser, LazyRelay, and our infrastructure providers use encrypted connections.
            Comments and direct messages are read on demand and not persisted beyond a short classification
            tag. See our <a href="/privacy">Privacy Policy</a> for further detail.
          </p>

          <h3>Data subject rights</h3>
          <p>
            If someone contacts LazyRelay directly with a GDPR request about data you control (e.g. someone
            who commented on your connected account), we'll forward it to you rather than act on it ourselves,
            since you're the controller of that relationship. If you receive a request you need our help with,
            email <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a>.
          </p>

          <h3>Personal data breach notification</h3>
          <p>
            If LazyRelay becomes aware of a personal data breach affecting your data, we'll notify you without
            undue delay, with what we know at the time (nature of the breach, likely consequences, and measures
            taken or proposed) — promptly enough for you to meet your own regulatory notification deadlines.
          </p>

          <h3>Data return and deletion</h3>
          <p>
            When you delete your LazyRelay account, we remove your stored content and connected-account access
            tokens within a reasonable time, per our <a href="/data-deletion">Data Deletion</a> page. If you
            need a copy of your data returned before deletion, email{" "}
            <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a>.
          </p>

          <h3>Liability</h3>
          <p>
            Liability under this DPA is subject to the limitations set out in our{" "}
            <a href="/terms">Terms of Service</a>. If LazyRelay materially breaches this DPA and doesn't fix
            it within a reasonable time after you notify us, you may terminate the affected Service at no
            further cost, regardless of your plan's usual cancellation terms.
          </p>

          <h3>Governing law</h3>
          <p>
            This DPA is governed by the laws of South Africa, where IPE Projects (Pty) Ltd is registered,
            without prejudice to any mandatory data protection rights you have under the GDPR, UK GDPR, or
            other law that applies to you directly.
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
