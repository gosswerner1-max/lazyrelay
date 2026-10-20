import { useEffect } from "react";
import { BrandMark } from "../components/BrandMark";
import { CircuitBackground } from "../components/CircuitBackground";
import { useCanonical } from "../lib/useCanonical";

interface TermsOfServiceProps {
  onBack: () => void;
}

const LAST_UPDATED = "20 October 2026";

export function TermsOfService({ onBack }: TermsOfServiceProps) {
  useEffect(() => {
    const previous = document.title;
    document.title = "Terms of Service | LazyRelay";
    return () => {
      document.title = previous;
    };
  }, []);
  useCanonical("/terms");

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
        <h1>Terms of Service</h1>
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

          <h3>Plans, LazyCredits and billing</h3>
          <p>
            <strong>LazyCredits are purely operational tokens for software features, hold no independent cash value, and are strictly non-refundable.</strong>
          </p>
          <p>
            LazyRelay is sold as LazyCredits, one wallet per account. All prices are in USD, plus tax. Payments
            are processed by our payment provider, Paddle.com, who acts as merchant of record and handles
            payment, tax, and invoicing.
          </p>
          <ul>
            <li>
              <strong>Free:</strong> $0. 30 credits once at registration, with no monthly reset. Up to 3
              connected accounts, 1 brand and 10 queued posts.
            </li>
            <li>
              <strong>Pay-as-you-go:</strong> $15 one time (plus tax) for 300 credits that never expire. Up to 20
              connected accounts and 2 brands.
            </li>
            <li>
              <strong>Growth:</strong> $29 a month (plus tax) for 1,000 credits each billing cycle. Unused credits
              expire at the end of each cycle, with no rollover. Up to 30 connected accounts and 4 brands.
            </li>
            <li>
              <strong>Pro:</strong> $99 a month (plus tax) for 6,000 credits each billing cycle. Unused credits
              expire at the end of each cycle, with no rollover. Up to 1,000 connected accounts and unlimited
              brands.
            </li>
          </ul>
          <p>
            Extra credit packs never expire: Starter pack $15 for 300 credits, Growth pack $50 for 1,500 credits,
            and Pro top-up $30 for 1,500 credits (available only to active Pro subscribers). All prices are plus
            tax.
          </p>
          <p>
            Publishing costs 1 credit per channel destination, so one post sent to 5 channels costs 5 credits. A
            channel that fails is not charged: a credit is taken only after the platform confirms the post is
            live. A competitor page teardown costs 10 credits and is charged only when the blueprint is
            delivered. Credits that expire first are spent first, then non-expiring credits. When your wallet is
            empty, due posts wait (they are not deleted) and publish once credits are added.
          </p>
          <p>
            Growth and Pro are billed as recurring monthly subscriptions and renew automatically each month until
            cancelled.
          </p>

          <h3>Cancellations and refunds</h3>
          <p>
            <strong>You can cancel your plan at any time</strong> from the Billing section of the Settings tab
            (always visible in the top nav).
            Cancelling stops future billing, but you keep access to your current plan's features until the end
            of the billing period you've already paid for, then your account drops to the Free plan.
          </p>
          <p>
            <strong>We don't offer refunds for partial billing periods.</strong> If you cancel partway through
            a month, you won't be charged again, but we don't refund the unused portion of the current period.
          </p>
          <p>
            <strong>Once your plan actually ends, your posts and uploaded media are permanently deleted 30 days
            later.</strong> We can't provide storage for an account that isn't a paying customer. You'll see this
            notice again and have to confirm it when you cancel, and we'll email you a reminder about a week
            before deletion happens. Download anything you want to keep before then - resubscribing before the
            30 days are up cancels the deletion.
          </p>

          <h3>Your data and content</h3>
          <p>
            You own the content you schedule through LazyRelay. We store it only to publish it at the time you
            choose, and to show you what's scheduled, posted, or failed.
            We never delete your files ourselves while you are subscribed. Storage is only ever freed by your own
            action or the 30-day post-cancellation deletion described above.
          </p>
          <p>
            When you delete your account, we remove your stored content and connected-platform access tokens
            within a reasonable time. See our Privacy Policy (linked in the footer) for the full detail on data
            handling.
          </p>

          <h3>Platform compliance</h3>
          <p>
            LazyRelay is not affiliated with, endorsed by, or sponsored by any platform you connect to it. We
            connect to each platform using its official APIs. We don't set our own limits on post length,
            image size, or video specs. We follow whatever each connected platform requires at the time of
            posting, and those limits can change on the platform's side at any time. It's your responsibility
            to make sure your content complies with each platform's own rules and terms.
          </p>
          <p>
            Some platforms, including TikTok, don't allow direct, automated posting for every connected
            account. Whether this applies to your account is determined entirely by the platform (for example
            by account type, settings, or your region), not by us, and we have no way to override it. When a
            platform blocks a post for this reason, we'll show you a clear explanation of why rather than
            attempt to post it another way without your say-so.
          </p>
          <p>
            WhatsApp and X can be connected with your own keys. You are responsible for holding those keys
            legitimately, for following Meta's and X's terms and policies, and for the fees they charge you. For
            WhatsApp you may only message people who have given you permission, and you must stop messaging anyone
            who replies STOP. LazyRelay may pause sending on a connection if Meta restricts your number.
          </p>

          <h3>Acceptable use</h3>
          <p>
            Don't use LazyRelay to post content that violates a connected platform's terms, to spam, or for any
            unlawful purpose. We reserve the right to suspend accounts that abuse the service, including
            attempts to circumvent plan or rate limits through automated or repeated fraudulent activity.
          </p>

          <h3>No warranty, limited liability</h3>
          <p>
            LazyRelay is provided "as is." We work to publish your posts reliably and verify when they go live,
            but platform outages, API changes, or account restrictions on the connected platform's side are
            outside our control. To the extent permitted by law, our liability for any issue is limited to the
            amount you paid us in the month the issue occurred.
          </p>

          <h3>Governing law</h3>
          <p>
            These terms are governed by the laws of South Africa, where IPE Projects (Pty) Ltd is registered.
          </p>

          <h3>Changes to these terms</h3>
          <p>
            If we make material changes, we'll update the "Last updated" date above and, where appropriate,
            notify you directly.
          </p>

          <h3>Contact us</h3>
          <p>
            Questions about these terms, billing, or a refund request you'd like us to consider outside the
            standard policy? Email <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a>.
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
