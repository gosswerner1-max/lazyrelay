import { useEffect, useState, type FormEvent } from "react";
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
        scheduledFor: new Date(scheduledFor).toISOString(),
      });
      setContent("");
      setScheduledFor("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
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
      const { checkoutUrl } = await api.startCheckout(tier);
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

  return (
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
        <button onClick={handleConnect}>+ Connect a social account</button>
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
                    {p.status === "pending" && <button onClick={() => handleDelete(p.id)}>Cancel</button>}
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
          return (
            <>
              <p className="current-plan">
                Current plan: <strong>{subscription ? tierNames[subscription.tier] : "Free"}</strong>
                {subscription?.status && subscription.status !== "cancelled" && (
                  <span className={`status-badge status-${subscription.status}`}>{subscription.status}</span>
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
                      {billingBusy === "pro" ? "Starting checkout..." : "Upgrade to Pro"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Business</h3>
                    <p className="pricing-price">
                      $49<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">Unlimited accounts, priority support</p>
                    <button className="cta" onClick={() => handleUpgrade("business")} disabled={billingBusy !== null}>
                      {billingBusy === "business" ? "Starting checkout..." : "Upgrade to Business"}
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={handleCancelSubscription} disabled={billingBusy !== null}>
                  {billingBusy === "cancel" ? "Cancelling..." : "Cancel subscription"}
                </button>
              )}
            </>
          );
        })()}
      </section>
      )}
    </div>
  );
}
