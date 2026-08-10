import { BrandMark } from "../components/BrandMark";
import { CircuitBackground } from "../components/CircuitBackground";

interface TermsOfServiceProps {
  onBack: () => void;
}

const LAST_UPDATED = "23 July 2026";

export function TermsOfService({ onBack }: TermsOfServiceProps) {
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
        <h2>Terms of Service</h2>
        <p className="section-note">Last updated {LAST_UPDATED}</p>

        <div className="about-text legal-body">
          <p>
            These terms govern your use of LazyRelay, a scheduling and publishing tool that connects to your
            social media accounts. By creating an account, you agree to them.
          </p>
          <p>
            LazyRelay is operated by IPE Projects (Pty) Ltd, a company registered in South Africa
            (registration number 2021/003176/07).
          </p>

          <h3>Subscriptions and billing</h3>
          <p>
            Paid plans (Starter, Pro, Business) and storage add-ons are billed as recurring monthly
            subscriptions, processed by our payment provider, Paddle.com, who acts as merchant of record and
            handles payment, tax, and invoicing. Subscriptions renew automatically each month until cancelled.
          </p>
          <p>
            A storage add-on is a separate subscription from your plan — you can buy more than one, and cancel
            any single add-on without affecting your plan or your other add-ons.
          </p>

          <h3>Cancellations and refunds</h3>
          <p>
            <strong>You can cancel your plan at any time</strong> from the Settings tab of your dashboard.
            Cancelling stops future billing — you keep access to your current plan's features until the end
            of the billing period you've already paid for, then your account drops to the Free plan.
          </p>
          <p>
            <strong>We don't offer refunds for partial billing periods.</strong> If you cancel partway through
            a month, you won't be charged again, but we don't refund the unused portion of the current period.
          </p>
          <p>
            <strong>Cancelling your plan also cancels any active storage add-ons.</strong> If you want to keep
            an add-on running on its own after downgrading to Free, contact us — that isn't currently supported
            through self-serve cancellation.
          </p>
          <p>
            Storage add-ons themselves follow the same rule: cancel one at any time from Settings, effective at
            the end of its current billing period, no partial refund for time already paid.
          </p>

          <h3>Your data and content</h3>
          <p>
            You own the content you schedule through LazyRelay. We store it only to publish it at the time you
            choose, and to show you what's scheduled, posted, or failed. Uploaded media counts against your
            plan's storage quota (shown as a gauge in Settings) plus any storage add-ons you've purchased —
            once you're at your limit, new uploads are rejected until you delete something or add more space.
            We never delete your files ourselves; storage is only ever freed by your own action.
          </p>
          <p>
            When you delete your account, we remove your stored content and connected-platform access tokens
            within a reasonable time. See our Privacy Policy (linked in the footer) for the full detail on data
            handling.
          </p>

          <h3>Platform compliance</h3>
          <p>
            LazyRelay is not affiliated with, endorsed by, or sponsored by Meta, TikTok, or Pinterest. We
            connect to these platforms using their official APIs. We don't set our own limits on post length,
            image size, or video specs — we follow whatever each connected platform requires at the time of
            posting, and those limits can change on the platform's side at any time. It's your responsibility
            to make sure your content complies with each platform's own rules and terms.
          </p>

          <h3>Acceptable use</h3>
          <p>
            Don't use LazyRelay to post content that violates a connected platform's terms, to spam, or for any
            unlawful purpose. We reserve the right to suspend accounts that abuse the service, including
            attempts to circumvent storage or rate limits through automated or repeated fraudulent activity.
          </p>

          <h3>No warranty, limited liability</h3>
          <p>
            LazyRelay is provided "as is." We work to publish your posts reliably and verify when they go live,
            but platform outages, API changes, or account restrictions on the connected platform's side are
            outside our control. To the extent permitted by law, our liability for any issue is limited to the
            amount you paid us in the month the issue occurred.
          </p>

          <h3>Changes to these terms</h3>
          <p>
            If we make material changes, we'll update the "Last updated" date above and, where appropriate,
            notify you directly.
          </p>

          <h3>Contact us</h3>
          <p>
            Questions about these terms, billing, or a refund request you'd like us to consider outside the
            standard policy? Email <a href="mailto:accounts@lazyrelay.com">accounts@lazyrelay.com</a>.
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
