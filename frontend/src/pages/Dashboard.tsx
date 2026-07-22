import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { useAuth } from "../context/AuthContext";
import { api, type SocialAccount, type ScheduledPost, type Subscription } from "../lib/api";
import { RelaySignal } from "../components/RelaySignal";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import { Spinner } from "../components/Spinner";

const TABS = ["Overview", "Posts", "Accounts", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function Dashboard() {
  const { signOut } = useAuth();
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [billingBusy, setBillingBusy] = useState<"pro" | "business" | "cancel" | null>(null);

  const [content, setContent] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [selectedAccount, setSelectedAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaDragActive, setMediaDragActive] = useState(false);
  const [paddle, setPaddle] = useState<Paddle | undefined>(undefined);
  const [finalizingUpgrade, setFinalizingUpgrade] = useState(false);
  const pendingTierRef = useRef<"pro" | "business" | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [accs, pts, sub] = await Promise.all([
        api.listSocialAccounts(),
        api.listScheduledPosts(),
        api.getSubscription(),
      ]);
      setAccounts(accs);
      setPosts(pts);
      setSubscription(sub);
      if (accs.length > 0 && !selectedAccount) setSelectedAccount(accs[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Paddle.js renders the real payment overlay on this page —
  // Paddle Billing has no hosted Checkout Session URL the way Stripe does,
  // so a bare redirect to transaction.checkout.url just bounces back here
  // with an unused query param and never shows a payment form.
  useEffect(() => {
    const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN;
    if (!token) return;
    const environment = (import.meta.env.VITE_PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox") as
      | "production"
      | "sandbox";
    initializePaddle({
      token,
      environment,
      eventCallback: (event) => {
        // checkout.completed fires the instant the card is charged, but our
        // tier flip depends on Paddle's subscription.activated webhook,
        // which lands a few seconds later — an immediate refresh() here
        // reads the still-"free" row. Poll briefly instead of refreshing
        // once so the banner updates itself without a manual reload.
        if (event.name === "checkout.completed") {
          pollUntilUpgraded();
        }
      },
    }).then(setPaddle);
  }, []);

  async function pollUntilUpgraded() {
    const expectedTier = pendingTierRef.current;
    setFinalizingUpgrade(true);
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const sub = await api.getSubscription();
        const upgraded = expectedTier
          ? sub.tier === expectedTier && (sub.status === "active" || sub.status === "trialing")
          : sub.tier !== "free";
        if (upgraded) {
          setSubscription(sub);
          return;
        }
      }
      // Timed out waiting on the webhook — refresh once more anyway so the
      // banner shows whatever the real current state is rather than nothing.
      await refresh();
    } finally {
      setFinalizingUpgrade(false);
      pendingTierRef.current = null;
    }
  }

  async function handleConnect() {
    try {
      const { authorizeUrl } = await api.startConnect();
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSchedule(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.createScheduledPost({
        socialAccountId: selectedAccount,
        content,
        mediaUrl: mediaUrl ?? undefined,
        scheduledFor: new Date(scheduledFor).toISOString(),
      });
      setContent("");
      setScheduledFor("");
      setMediaUrl(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMediaFile(file: File) {
    setError(null);
    setMediaUploading(true);
    try {
      const { url } = await api.uploadMedia(file);
      setMediaUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaUploading(false);
    }
  }

  function handleMediaDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setMediaDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleMediaFile(file);
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteScheduledPost(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpgrade(tier: "pro" | "business") {
    setBillingBusy(tier);
    setError(null);
    try {
      const { transactionId, checkoutUrl } = await api.startCheckout(tier);
      if (paddle && transactionId) {
        pendingTierRef.current = tier;
        paddle.Checkout.open({ transactionId });
        return;
      }
      // Fallback only — bare redirect won't show a real payment form (see
      // the Paddle.js note above), but it's better than nothing if Paddle.js
      // itself failed to load (e.g. VITE_PADDLE_CLIENT_TOKEN missing).
      if (!checkoutUrl) {
        setError("Checkout couldn't start — no checkout URL was returned.");
        return;
      }
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBillingBusy(null);
    }
  }

  async function handleCancelSubscription() {
    if (!window.confirm("Cancel your subscription? You'll keep access until the end of the current billing period.")) {
      return;
    }
    setBillingBusy("cancel");
    setError(null);
    try {
      await api.cancelSubscription();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBillingBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <Spinner />
      </div>
    );
  }

  const tierNames = { free: "Free", pro: "Pro", business: "Business" } as const;
  const currentTier = subscription?.tier ?? "free";
  const isFreePlan = currentTier === "free";
  // A cancelled paid plan keeps access until the current period ends — it's
  // not lapsed to Free yet, so the banner/CTA copy should say "resubscribe,"
  // not "upgrade" (that read as contradictory: "You're on the Pro plan" next
  // to an "Upgrade to Pro" button).
  const isCancelling = !isFreePlan && subscription?.status === "cancelled";
  const isFreeOrLapsed = isFreePlan || isCancelling;
  const periodEndDate = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;

  return (
    <>
      <div className="plan-banner">
        <div className="plan-banner-inner">
          <span>
            {finalizingUpgrade ? (
              "Finalizing your upgrade..."
            ) : (
              <>
                You're on the <strong>{tierNames[currentTier]}</strong> plan
                {isFreePlan && " — 10 posts per connected account, refillable monthly"}
                {isCancelling && ` — cancels${periodEndDate ? ` on ${periodEndDate}` : " at the end of your billing period"}`}
              </>
            )}
          </span>
          {isFreeOrLapsed && !finalizingUpgrade && (
            <button className="plan-banner-cta" onClick={() => setTab("Settings")}>
              {isCancelling ? "Resubscribe" : "Upgrade to Pro"}
            </button>
          )}
        </div>
      </div>
      <div className="dashboard">
      <header>
        <div className="wordmark">
          <BrandMark size={30} />
          <span>LazyRelay</span>
        </div>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>

      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? "tab-active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      {error && <p className="error">{error}</p>}

      {(tab === "Overview" || tab === "Accounts") && (
      <section>
        <h2>Connected accounts</h2>
        {accounts.length === 0 ? (
          <p className="empty">No accounts connected yet — connect one to start scheduling posts.</p>
        ) : (
          <ul className="account-list">
            {accounts.map((a) => (
              <li key={a.id}>
                <span className="platform-badge">
                  <PlatformIcon platform={a.platform} size={13} />
                  {a.platform}
                </span>
                {a.display_name ?? a.platform_account_id}
              </li>
            ))}
          </ul>
        )}
        <button className="btn-outline" onClick={handleConnect}>+ Connect a social account</button>
      </section>
      )}

      {(tab === "Overview" || tab === "Posts") && (
      <>
      <section>
        <h2>Schedule a post</h2>
        {accounts.length === 0 ? (
          <p className="empty">Connect an account first.</p>
        ) : (
          <form onSubmit={handleSchedule} className="schedule-form">
            <label>
              Account
              <select value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name ?? a.platform_account_id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Content
              <textarea value={content} onChange={(e) => setContent(e.target.value)} required />
            </label>
            <label>
              Media (optional)
              <div
                className={`media-dropzone${mediaDragActive ? " media-dropzone-active" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setMediaDragActive(true);
                }}
                onDragLeave={() => setMediaDragActive(false)}
                onDrop={handleMediaDrop}
                onClick={() => mediaInputRef.current?.click()}
              >
                <input
                  ref={mediaInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleMediaFile(file);
                    e.target.value = "";
                  }}
                />
                {mediaUploading ? (
                  <span>Uploading...</span>
                ) : mediaUrl ? (
                  <div className="media-preview">
                    {mediaUrl.match(/\.(mp4|mov)$/i) ? (
                      <video src={mediaUrl} muted />
                    ) : (
                      <img src={mediaUrl} alt="Attached media preview" />
                    )}
                    <button
                      type="button"
                      className="media-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMediaUrl(null);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <span>
                    <strong>Drag and drop</strong> an image or video, or click to browse
                  </span>
                )}
              </div>
            </label>
            <label>
              When
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? "Scheduling..." : "Schedule"}
            </button>
          </form>
        )}
      </section>

      <section>
        <h2>Scheduled posts</h2>
        {posts.length === 0 ? (
          <p className="empty">Nothing scheduled yet.</p>
        ) : (
          <ul className="post-list">
            {posts.map((p) => {
              const result = p.post_results?.[0];
              return (
                <li key={p.id} className={`post-status-${p.status}`}>
                  <div className="post-content">{p.content}</div>
                  <div className="post-meta">
                    <span className={`status-badge status-${p.status}`}>{p.status}</span>
                    <span>{new Date(p.scheduled_for).toLocaleString()}</span>
                    {result && (
                      <span className={result.verified_live ? "verified" : "not-verified"}>
                        {result.verified_live ? (
                          <>
                            <RelaySignal size={14} pulsing /> Confirmed live
                          </>
                        ) : (
                          `Not confirmed — ${result.error_message ?? "couldn't verify"}`
                        )}
                      </span>
                    )}
                    {p.status === "pending" && (
                      <button className="btn-outline" onClick={() => handleDelete(p.id)}>
                        Cancel
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      </>
      )}

      {tab === "Settings" && (
      <section>
        <h2>Billing</h2>
        {(() => {
          const tierNames = { free: "Free", pro: "Pro", business: "Business" } as const;
          const canUpgrade = !subscription || subscription.tier === "free" || subscription.status === "cancelled";
          // A cancelled paid plan keeps access until the period end — label
          // the resume action "Resubscribe" so it doesn't read as
          // contradictory next to "Current plan: Pro".
          const isCancelling = subscription?.tier !== "free" && subscription?.status === "cancelled";
          const periodEndDate = subscription?.currentPeriodEnd
            ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : null;
          return (
            <>
              <p className="current-plan">
                Current plan: <strong>{subscription ? tierNames[subscription.tier] : "Free"}</strong>
                {subscription?.status && (
                  <span className={`status-badge status-${subscription.status}`}>
                    {isCancelling ? `cancelling${periodEndDate ? ` — ends ${periodEndDate}` : ""}` : subscription.status}
                  </span>
                )}
              </p>

              {canUpgrade ? (
                <div className="pricing-grid billing-upgrade-grid">
                  <div className="pricing-card">
                    <h3>Pro</h3>
                    <p className="pricing-price">
                      $24.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">15 accounts, unlimited posts, AI-agent access</p>
                    <button className="cta" onClick={() => handleUpgrade("pro")} disabled={billingBusy !== null}>
                      {billingBusy === "pro" ? "Starting checkout..." : isCancelling ? "Resubscribe to Pro" : "Upgrade to Pro"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Business</h3>
                    <p className="pricing-price">
                      $49<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">Unlimited accounts, priority support</p>
                    <button className="cta" onClick={() => handleUpgrade("business")} disabled={billingBusy !== null}>
                      {billingBusy === "business" ? "Starting checkout..." : isCancelling ? "Resubscribe to Business" : "Upgrade to Business"}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn-outline" onClick={handleCancelSubscription} disabled={billingBusy !== null}>
                  {billingBusy === "cancel" ? "Cancelling..." : "Cancel subscription"}
                </button>
              )}
            </>
          );
        })()}
      </section>
      )}
      </div>
    </>
  );
}
