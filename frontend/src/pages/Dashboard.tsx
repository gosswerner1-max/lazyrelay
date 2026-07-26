import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { useAuth } from "../context/AuthContext";
import { api, type SocialAccount, type ScheduledPost, type Subscription, type StorageUsage, type MediaFile, type StorageAddon, type PlatformInfo } from "../lib/api";
import { RelaySignal } from "../components/RelaySignal";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import { Spinner } from "../components/Spinner";

const TABS = ["Overview", "Posts", "Accounts", "Settings"] as const;
type Tab = (typeof TABS)[number];

// Read once at module scope (not inside the component) — React 18
// StrictMode double-mounts components in dev, and a component-scoped
// effect that reads-then-strips the URL loses the value on the second
// mount, since the window was already mutated by the first. Module
// evaluation only happens once per page load regardless of StrictMode.
function readAndClearConnectParams(): { connectError: string | null; connected: boolean } {
  const params = new URLSearchParams(window.location.search);
  const connectError = params.get("connectError");
  const connected = params.get("connected") !== null;
  if (connectError || connected) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return { connectError, connected };
}
const connectParams = readAndClearConnectParams();

export function Dashboard() {
  const { signOut } = useAuth();
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [mediaBusyId, setMediaBusyId] = useState<string | null>(null);
  const [storageAddons, setStorageAddons] = useState<StorageAddon[]>([]);
  const [addonBusy, setAddonBusy] = useState<5 | 20 | 50 | string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [billingBusy, setBillingBusy] = useState<"pro" | "business" | "enterprise" | "cancel" | null>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelFeedback, setCancelFeedback] = useState("");

  const [content, setContent] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaDragActive, setMediaDragActive] = useState(false);
  const [paddle, setPaddle] = useState<Paddle | undefined>(undefined);
  const [finalizingUpgrade, setFinalizingUpgrade] = useState(false);
  const pendingTierRef = useRef<"pro" | "business" | "enterprise" | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [accs, pts, sub, usage, media, addons, plats] = await Promise.all([
        api.listSocialAccounts(),
        api.listScheduledPosts(),
        api.getSubscription(),
        api.getStorageUsage(),
        api.listMedia(),
        api.listStorageAddons(),
        api.getPlatforms(),
      ]);
      setAccounts(accs);
      setPosts(pts);
      setSubscription(sub);
      setStorageUsage(usage);
      setMediaFiles(media);
      setStorageAddons(addons);
      setPlatforms(plats);
      // Drop any selected account that disappeared (e.g. disconnected)
      // since the last refresh, rather than silently submitting for it.
      setSelectedAccountIds((prev) => prev.filter((id) => accs.some((a) => a.id === id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // The OAuth callback redirects here with ?connected=1 or ?connectError=...
  // (the customer's browser lands on the backend's own domain mid-flow,
  // then bounces back here) — connectParams was already read + stripped
  // from the URL once at module scope (see readAndClearConnectParams), so
  // this just surfaces whatever it found.
  useEffect(() => {
    if (connectParams.connectError) {
      setError(connectParams.connectError);
    } else if (connectParams.connected) {
      setNotice("Account connected!");
      refresh();
    }
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

  async function handleConnect(platform: string) {
    setConnectingPlatform(platform);
    setError(null);
    try {
      const { authorizeUrl } = await api.startConnect(platform);
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConnectingPlatform(null);
    }
  }

  function toggleSelectedAccount(id: string) {
    setSelectedAccountIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  async function handleSchedule(e: FormEvent) {
    e.preventDefault();
    if (selectedAccountIds.length === 0) {
      setError("Select at least one connected account to post to.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // One scheduled_posts row per selected account — same content/media/time
      // fanned out to every platform the customer checked, via the existing
      // single-post endpoint rather than a new batch one.
      for (const socialAccountId of selectedAccountIds) {
        await api.createScheduledPost({
          socialAccountId,
          content,
          mediaUrl: mediaUrl ?? undefined,
          scheduledFor: new Date(scheduledFor).toISOString(),
        });
      }
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
      // Usage/quota just changed — refresh the gauge and file list so
      // they're never stale relative to what was just uploaded.
      const [usage, media] = await Promise.all([api.getStorageUsage(), api.listMedia()]);
      setStorageUsage(usage);
      setMediaFiles(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaUploading(false);
    }
  }

  async function handleDeleteMedia(id: string) {
    if (!window.confirm("Delete this file? This can't be undone.")) return;
    setMediaBusyId(id);
    setError(null);
    try {
      await api.deleteMedia(id);
      const [usage, media] = await Promise.all([api.getStorageUsage(), api.listMedia()]);
      setStorageUsage(usage);
      setMediaFiles(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaBusyId(null);
    }
  }

  function formatBytes(bytes: number): string {
    const MB = 1024 * 1024;
    const GB = MB * 1024;
    if (bytes >= GB) return `${(bytes / GB).toFixed(2)}GB`;
    return `${(bytes / MB).toFixed(1)}MB`;
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

  async function handleUpgrade(tier: "pro" | "business" | "enterprise") {
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

  async function handleBuyStorageAddon(gbAmount: 5 | 20 | 50) {
    setAddonBusy(gbAmount);
    setError(null);
    try {
      const { transactionId, checkoutUrl } = await api.startStorageAddonCheckout(gbAmount);
      if (paddle && transactionId) {
        paddle.Checkout.open({ transactionId });
        // Storage add-ons don't flip a tier the pricing banner cares about,
        // just the quota gauge — poll the addon list + usage briefly instead
        // of the tier-polling pollUntilUpgraded() above.
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const addons = await api.listStorageAddons();
          if (addons.some((a) => a.gb_amount === gbAmount)) {
            setStorageAddons(addons);
            const usage = await api.getStorageUsage();
            setStorageUsage(usage);
            break;
          }
        }
        return;
      }
      if (!checkoutUrl) {
        setError("Checkout couldn't start — no checkout URL was returned.");
        return;
      }
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddonBusy(null);
    }
  }

  async function handleCancelStorageAddon(id: string) {
    if (!window.confirm("Cancel this storage add-on? You'll lose the extra space at the end of the billing period.")) {
      return;
    }
    setAddonBusy(id);
    setError(null);
    try {
      await api.cancelStorageAddon(id);
      const [addons, usage] = await Promise.all([api.listStorageAddons(), api.getStorageUsage()]);
      setStorageAddons(addons);
      setStorageUsage(usage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddonBusy(null);
    }
  }

  async function handleConfirmCancelSubscription() {
    setBillingBusy("cancel");
    setError(null);
    try {
      await api.cancelSubscription(cancelFeedback);
      setShowCancelModal(false);
      setCancelFeedback("");
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

  const tierNames = { free: "Free", pro: "Starter", business: "Pro", enterprise: "Business" } as const;
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
              {isCancelling ? "Resubscribe" : "Upgrade"}
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
      {notice && <p className="notice">{notice}</p>}

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
        <h3>Connect a platform</h3>
        <div className="platform-grid">
          {platforms.map((p) => {
            // A platform not yet configured on this deploy (missing env
            // vars) is just as unclickable as a genuine "coming soon" one —
            // dim both the same way rather than only handling the X/Reddit
            // case and letting an unconfigured tile error on click.
            const disabled = p.comingSoon || !p.configured;
            const connectedCount = accounts.filter((a) => a.platform === p.platform).length;
            return (
              <button
                key={p.platform}
                type="button"
                className={`platform-tile${disabled ? " platform-tile-coming-soon" : ""}${connectedCount > 0 ? " platform-tile-connected" : ""}`}
                disabled={disabled || connectingPlatform !== null}
                title={
                  p.comingSoon
                    ? "Coming soon"
                    : !p.configured
                      ? "Not set up on this deploy yet"
                      : connectedCount > 0
                        ? "Connected — click to connect another account"
                        : undefined
                }
                onClick={() => handleConnect(p.platform)}
              >
                <PlatformIcon platform={p.platform} size={20} comingSoon={disabled} />
                <span className="platform-tile-name">{p.platform}</span>
                {p.comingSoon && <span className="platform-tile-badge">Coming soon</span>}
                {!disabled && connectedCount > 0 && (
                  <span className="platform-tile-badge platform-tile-badge-connected">
                    &#10003; Connected{connectedCount > 1 ? ` (${connectedCount})` : ""}
                  </span>
                )}
                {!disabled && connectingPlatform === p.platform && <span className="platform-tile-badge">Connecting...</span>}
              </button>
            );
          })}
        </div>
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
              Post to
              <div className="account-checkbox-list">
                {accounts.map((a) => (
                  <label key={a.id} className="account-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedAccountIds.includes(a.id)}
                      onChange={() => toggleSelectedAccount(a.id)}
                    />
                    <PlatformIcon platform={a.platform} size={14} />
                    {a.display_name ?? a.platform_account_id}
                  </label>
                ))}
              </div>
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
        <h2>Storage</h2>
        {storageUsage && (() => {
          const pct = Math.min(100, (storageUsage.usedBytes / storageUsage.quotaBytes) * 100);
          const fillClass = pct >= 100 ? "storage-gauge-full" : pct >= 85 ? "storage-gauge-warn" : "";
          return (
            <div className="storage-gauge">
              <div className="storage-gauge-track">
                <div className={`storage-gauge-fill ${fillClass}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="storage-gauge-label">
                <span>
                  {formatBytes(storageUsage.usedBytes)} of {formatBytes(storageUsage.quotaBytes)} used
                </span>
                {pct >= 85 && (
                  <span>
                    {pct >= 100
                      ? "Storage full — delete files below to upload new media."
                      : "Getting full — delete unused files or upgrade for more space."}
                  </span>
                )}
              </div>
            </div>
          );
        })()}
        {mediaFiles.length === 0 ? (
          <p className="empty">No uploaded media yet.</p>
        ) : (
          <ul className="media-list">
            {mediaFiles.map((m) => (
              <li key={m.id}>
                {m.mime_type.startsWith("image/") ? (
                  <img className="media-list-thumb" src={m.url} alt="" />
                ) : (
                  <div className="media-list-thumb" />
                )}
                <span className="media-list-meta">
                  {formatBytes(m.size_bytes)}
                  {m.width && m.height ? ` · ${m.width}×${m.height}` : ""} ·{" "}
                  {new Date(m.created_at).toLocaleDateString()}
                </span>
                <button
                  className="btn-outline"
                  onClick={() => handleDeleteMedia(m.id)}
                  disabled={mediaBusyId !== null}
                >
                  {mediaBusyId === m.id ? "Deleting..." : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {tab === "Settings" && currentTier !== "free" && (
      <section>
        <h2>Buy more storage</h2>
        <p className="pricing-note">Add extra space on top of your plan's included storage — cancel any add-on separately, any time.</p>
        <div className="pricing-grid billing-upgrade-grid">
          {([
            { gb: 5 as const, price: "2.99" },
            { gb: 20 as const, price: "7.99" },
            { gb: 50 as const, price: "14.99" },
          ]).map(({ gb, price }) => (
            <div className="pricing-card" key={gb}>
              <h3>+{gb}GB</h3>
              <p className="pricing-price">
                ${price}<span className="pricing-period">/mo</span>
              </p>
              <button className="cta" onClick={() => handleBuyStorageAddon(gb)} disabled={addonBusy !== null}>
                {addonBusy === gb ? "Starting checkout..." : `Add +${gb}GB`}
              </button>
            </div>
          ))}
        </div>
        {storageAddons.length > 0 && (
          <ul className="media-list">
            {storageAddons.map((a) => (
              <li key={a.id}>
                <span className="media-list-meta">
                  +{a.gb_amount}GB storage
                  <span className={`status-badge status-${a.status}`}>{a.status}</span>
                </span>
                <button
                  className="btn-outline"
                  onClick={() => handleCancelStorageAddon(a.id)}
                  disabled={addonBusy !== null}
                >
                  {addonBusy === a.id ? "Cancelling..." : "Cancel"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {tab === "Settings" && (
      <section>
        <h2>Billing</h2>
        {(() => {
          const tierNames = { free: "Free", pro: "Starter", business: "Pro", enterprise: "Business" } as const;
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
                    <h3>Starter — 5GB storage</h3>
                    <p className="pricing-price">
                      $24.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">20 accounts, unlimited posts, AI-agent access</p>
                    <button className="cta" onClick={() => handleUpgrade("pro")} disabled={billingBusy !== null}>
                      {billingBusy === "pro" ? "Starting checkout..." : isCancelling ? "Resubscribe to Starter" : "Upgrade to Starter"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Pro — 10GB storage</h3>
                    <p className="pricing-price">
                      $48.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">40 accounts, unlimited posts, AI-agent access, priority support</p>
                    <button className="cta" onClick={() => handleUpgrade("business")} disabled={billingBusy !== null}>
                      {billingBusy === "business" ? "Starting checkout..." : isCancelling ? "Resubscribe to Pro" : "Upgrade to Pro"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Business — 20GB storage</h3>
                    <p className="pricing-price">
                      $79.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">100 accounts, unlimited posts, AI-agent access, priority support</p>
                    <button className="cta" onClick={() => handleUpgrade("enterprise")} disabled={billingBusy !== null}>
                      {billingBusy === "enterprise" ? "Starting checkout..." : isCancelling ? "Resubscribe to Business" : "Upgrade to Business"}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn-outline" onClick={() => setShowCancelModal(true)} disabled={billingBusy !== null}>
                  Cancel subscription
                </button>
              )}
            </>
          );
        })()}
      </section>
      )}
      </div>

      {showCancelModal && (
        <div className="modal-overlay" onClick={() => setShowCancelModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>We're sorry to see you go</h2>
              <button className="modal-close" onClick={() => setShowCancelModal(false)} aria-label="Close">
                &times;
              </button>
            </div>
            <p className="modal-subtitle">Before you cancel, please note:</p>
            <ul className="modal-loss-list">
              <li>
                You'll lose <strong>{accounts.length}</strong> connected account{accounts.length === 1 ? "" : "s"} — you'll need
                to reconnect them if you come back.
              </li>
              {currentTier !== "free" && <li>Your posts will drop back to the Free tier's 10-per-account monthly limit.</li>}
              <li>
                You'll keep access until {periodEndDate ? periodEndDate : "the end of your current billing period"} — this
                doesn't cancel immediately.
              </li>
            </ul>
            <label className="modal-feedback-label">
              What's missing? What could we improve?
              <textarea
                className="modal-feedback-input"
                value={cancelFeedback}
                onChange={(e) => setCancelFeedback(e.target.value)}
                placeholder="Optional — helps us make LazyRelay better"
              />
            </label>
            <div className="modal-actions">
              <button className="btn-outline" onClick={() => setShowCancelModal(false)}>
                Keep my plan
              </button>
              <button className="modal-confirm-cancel" onClick={handleConfirmCancelSubscription} disabled={billingBusy !== null}>
                {billingBusy === "cancel" ? "Cancelling..." : "Submit & Continue to Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
