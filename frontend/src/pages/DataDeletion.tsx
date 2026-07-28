import { BrandMark } from "../components/BrandMark";

interface DataDeletionProps {
  onBack: () => void;
}

const LAST_UPDATED = "28 July 2026";

export function DataDeletion({ onBack }: DataDeletionProps) {
  return (
    <div className="landing">
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
        <h2>Data Deletion Instructions</h2>
        <p className="section-note">Last updated {LAST_UPDATED}</p>

        <div className="about-text legal-body">
          <p>
            This page explains how to remove your data from LazyRelay — either a single connected platform, or
            your entire account. See our{" "}
            <a href="/privacy">Privacy Policy</a> for what we store and why.
          </p>

          <h3>Disconnect a single platform (self-serve)</h3>
          <p>
            To remove just one connected account (Meta, TikTok, Pinterest, or any other platform you've
            connected): go to your Dashboard, find the account under your connected platforms, and click
            Disconnect. This immediately revokes LazyRelay's access token for that platform and stops any future
            posts from being scheduled to it. Posts already published to that platform are not affected — we
            only control what happens going forward.
          </p>

          <h3>Cancel your subscription (self-serve)</h3>
          <p>
            Go to the Settings tab of your Dashboard and click Cancel. This stops future billing; your account
            drops to the Free plan at the end of the period you've already paid for. Cancelling does not, by
            itself, delete your data — see below for that.
          </p>

          <h3>Delete your entire account and data</h3>
          <p>
            LazyRelay doesn't yet have a self-serve "delete my account" button in the Dashboard. To request full
            deletion, email <a href="mailto:hello@lazyrelay.com">hello@lazyrelay.com</a> from the email address
            on your account with the subject line "Delete my account." Once we confirm the request is really
            from you, we will, within a reasonable time:
          </p>
          <ul>
            <li>Revoke every connected platform's access token, disconnecting all of your connected accounts.</li>
            <li>Delete your account record, subscription and billing history, uploaded media, and scheduled/post history.</li>
            <li>Cancel any active subscription or storage add-ons, effective immediately rather than waiting out the billing period, since the account itself is being removed.</li>
          </ul>
          <p>
            Records we're legally required to keep for tax/accounting purposes (e.g. sale and refund records for
            SARS bookkeeping) are retained as required by law even after account deletion, but are no longer
            linked to your connected-platform tokens or usable to access anything on your behalf.
          </p>

          <h3>How long it takes</h3>
          <p>
            Platform disconnects and subscription cancellations you trigger yourself in the Dashboard take
            effect immediately. Full account-deletion requests sent by email are processed within a reasonable
            time after we've verified the request — if it's been more than a few business days without a reply,
            follow up on the same email thread.
          </p>

          <h3>Contact us</h3>
          <p>
            Questions about deleting your data, or a request in progress? Email{" "}
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
