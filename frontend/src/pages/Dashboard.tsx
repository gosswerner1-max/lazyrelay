// The logged-in dashboard shell. Split 2026-09-25 (pure mechanical
// extraction, no behavior/UI change) from a single ~6,000-line component:
//   - dashboard/useDashboardState.tsx — every piece of state, effect and
//     handler, unchanged, as one hook called once right here;
//   - dashboard/DashboardContext.tsx — hands that state to the tabs;
//   - dashboard/<Tab>Tab.tsx — each tab's JSX, moved verbatim;
//   - dashboard/dashboardHelpers.ts + dashboardComponents.tsx — module-level
//     helpers/components more than one file needs.
// This file keeps only the chrome around the tabs (plan banner, header, tab
// bar, first-run prompts, modals) and picks which tab to render.

import { lazy, Suspense } from "react";
import { BrandMark } from "../components/BrandMark";
import { NotificationBell } from "../components/NotificationBell";
import { Spinner } from "../components/Spinner";
import { CircuitBackground } from "../components/CircuitBackground";
import { SupportWidget } from "../components/SupportWidget";
import { PinterestConnectModal } from "../components/PinterestConnectModal";
import { type Tab } from "./dashboard/dashboardHelpers";
import { useDashboardState } from "./dashboard/useDashboardState";
import { DashboardContext } from "./dashboard/DashboardContext";
import { AnalyticsTab } from "./dashboard/AnalyticsTab";
import { MentionsTab } from "./dashboard/MentionsTab";
import { DmsTab } from "./dashboard/DmsTab";
import { BioPageTab } from "./dashboard/BioPageTab";
import { OverviewTab } from "./dashboard/OverviewTab";
import { SocialPlatformsTab } from "./dashboard/SocialPlatformsTab";
import { PostsTab } from "./dashboard/PostsTab";
import { CalendarTab } from "./dashboard/CalendarTab";
import { SettingsTab } from "./dashboard/SettingsTab";
import { ApiKeysTab } from "./dashboard/ApiKeysTab";
import "./Dashboard.css";

const ProductTour = lazy(() => import("../components/ProductTour").then((m) => ({ default: m.ProductTour })));
const MAIN_TABS: Tab[] = ["Overview", "Posts", "Calendar", "Social Platforms", "API Keys", "Settings"];
const MORE_TABS: Tab[] = ["Analytics", "Mentions", "DMs", "Bio Page"];

// Reply-to-comment and DM read/reply/automation for Facebook and Instagram
// depend on pages_manage_engagement / instagram_manage_comments / pages_messaging
// / instagram_manage_messages -- all still "Ready for testing" (Standard access,
// admin/tester accounts only) on Meta's app, not approved for real customers.
// Set 2026-09-08 to hide both tabs behind "Coming soon" rather than advertise
// a capability that would silently fail for any real customer. Flip back to
// true once those permissions clear Meta's App Review.
const COMMENTS_DMS_LIVE = false;
const DISABLED_TABS: Tab[] = COMMENTS_DMS_LIVE ? [] : ["Mentions", "DMs"];

export function Dashboard() {
  const state = useDashboardState();
  const {
    signOut,
    accounts,
    pendingSelection,
    checkedOptionIds,
    setCheckedOptionIds,
    selectionBusy,
    account,
    loading,
    error,
    notice,
    tab,
    setTab,
    runTour,
    showGcalPrompt,
    moreMenuOpen,
    setMoreMenuOpen,
    moreMenuRef,
    billingBusy,
    pendingTierChange,
    setPendingTierChange,
    showCancelModal,
    setShowCancelModal,
    cancelFeedback,
    setCancelFeedback,
    cancelDataDeletionAck,
    setCancelDataDeletionAck,
    showPinterestConnectModal,
    setShowPinterestConnectModal,
    setScrollToBillingPending,
    handleTourFinish,
    dismissGcalPrompt,
    finalizingUpgrade,
    handleFinalizeSelection,
    handleConnect,
    handleChangeTier,
    handleConnectGoogleCalendar,
    handleConfirmCancelSubscription,
    tierNames,
    currentTier,
    isFreePlan,
    isPendingCancellation,
    isLapsedCancelled,
    isFreeOrLapsed,
    periodEndDate,
  } = state;

  if (loading) {
    return (
      <div className="loading">
        <Spinner />
      </div>
    );
  }

  return (
    <DashboardContext.Provider value={state}>
    <>
      <CircuitBackground />
      <div className="plan-banner">
        <div className="plan-banner-inner">
          <span>
            {finalizingUpgrade ? (
              "Finalizing your upgrade..."
            ) : (
              <>
                You're on the <strong>{tierNames[currentTier]}</strong> plan
                {isFreePlan && ": 10 posts per connected account, refillable monthly"}
                {isPendingCancellation &&
                  `; cancels${periodEndDate ? ` on ${periodEndDate}` : " at the end of your billing period"}`}
                {isLapsedCancelled && "; cancelled"}
              </>
            )}
          </span>
          {isFreeOrLapsed && !finalizingUpgrade && (
            <button
              className="plan-banner-cta"
              onClick={() => {
                setTab("Settings");
                setScrollToBillingPending(true);
              }}
            >
              {isPendingCancellation || isLapsedCancelled ? "Resubscribe" : "Upgrade"}
            </button>
          )}
        </div>
      </div>
      <div className={tab === "Calendar" ? "dashboard dashboard-wide" : "dashboard"}>
      <header>
        <div className="wordmark">
          <BrandMark size={30} />
          <span>{account?.businessName ? `Welcome, ${account.businessName}` : "LazyRelay"}</span>
        </div>
        <div className="header-actions">
          {COMMENTS_DMS_LIVE && <NotificationBell onOpenTab={setTab} />}
          <a href="/guides" className="link">
            Guides
          </a>
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="tab-bar">
        {MAIN_TABS.map((t) => (
          <button
            key={t}
            data-tour={`tab-${t.toLowerCase().replace(/\s+/g, "-")}`}
            className={t === tab ? "tab-active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
        <div className="tab-more" ref={moreMenuRef}>
          <button
            className={MORE_TABS.includes(tab) ? "tab-active" : ""}
            onClick={() => setMoreMenuOpen((v) => !v)}
          >
            {MORE_TABS.includes(tab) ? tab : "More"} ▾
          </button>
          {moreMenuOpen && (
            <div className="tab-more-menu">
              {MORE_TABS.map((t) => {
                const disabled = DISABLED_TABS.includes(t);
                return (
                  <button
                    key={t}
                    className={`${t === tab ? "tab-active" : ""} ${disabled ? "tab-disabled" : ""}`.trim()}
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      setTab(t);
                      setMoreMenuOpen(false);
                    }}
                  >
                    {t}
                    {disabled && <span className="coming-soon-badge">Coming soon</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </nav>

      <Suspense fallback={null}>
        <ProductTour run={runTour} onFinish={handleTourFinish} />
      </Suspense>

      {showGcalPrompt && (
        <div className="modal-overlay" onClick={dismissGcalPrompt}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>Connect Google Calendar?</h2>
            <p>
              See and manage your scheduled posts right from your phone's calendar app — move, edit, or delete one
              there and LazyRelay picks up the change. You can always do this later from Settings.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  dismissGcalPrompt();
                  handleConnectGoogleCalendar();
                }}
              >
                Connect now
              </button>
              <button type="button" className="btn-outline" onClick={dismissGcalPrompt}>
                Maybe later
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {tab === "Analytics" && <AnalyticsTab />}

      {tab === "Mentions" && <MentionsTab />}

      {tab === "DMs" && <DmsTab />}

      {tab === "Bio Page" && <BioPageTab />}

      {tab === "Overview" && <OverviewTab />}

      {tab === "Social Platforms" && <SocialPlatformsTab />}

      {tab === "Posts" && <PostsTab />}

      {tab === "Calendar" && <CalendarTab />}

      {tab === "Settings" && <SettingsTab />}

      {tab === "API Keys" && <ApiKeysTab />}
      </div>

      {pendingSelection && (
        <div className="modal-overlay">
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Which {
                pendingSelection.platform === "instagram" ? "Instagram accounts" :
                pendingSelection.platform === "youtube" ? "YouTube channels" :
                "Facebook Pages"
              } should LazyRelay use?</h2>
            </div>
            <p className="modal-subtitle">
              Your account manages more than one — check the ones you want to connect. All are checked by default; uncheck
              any you'd rather leave out. You can always connect the rest separately later.
            </p>
            <div className="modal-actions" style={{ flexDirection: "column", alignItems: "stretch", gap: "0.5rem" }}>
              {pendingSelection.options.map((option) => (
                <label key={option.id} className="btn-outline" style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={checkedOptionIds.includes(option.id)}
                    disabled={selectionBusy}
                    onChange={(e) =>
                      setCheckedOptionIds((prev) =>
                        e.target.checked ? [...prev, option.id] : prev.filter((id) => id !== option.id),
                      )
                    }
                  />
                  {option.name}
                </label>
              ))}
              <button className="modal-confirm-cancel" disabled={selectionBusy || checkedOptionIds.length === 0} onClick={handleFinalizeSelection}>
                {selectionBusy
                  ? "Connecting..."
                  : checkedOptionIds.length === 0
                    ? "Select at least one"
                    : `Connect ${checkedOptionIds.length} selected`}
              </button>
            </div>
          </div>
        </div>
      )}

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
                You'll lose <strong>{accounts.length}</strong> connected account{accounts.length === 1 ? "" : "s"}. You'll need
                to reconnect them if you come back.
              </li>
              {currentTier !== "free" && <li>Your posts will drop back to the Free tier's 10-per-account monthly limit.</li>}
              <li>
                You'll keep access until {periodEndDate ? periodEndDate : "the end of your current billing period"}. This
                doesn't cancel immediately.
              </li>
              <li>
                <strong>30 days after your access ends</strong>, your posts and stored media are permanently deleted. We'll
                email you a reminder before that happens — download anything you want to keep before then.
              </li>
            </ul>
            <label className="modal-feedback-label">
              What's missing? What could we improve?
              <textarea
                className="modal-feedback-input"
                value={cancelFeedback}
                onChange={(e) => setCancelFeedback(e.target.value)}
                placeholder="Optional, helps us make LazyRelay better"
              />
            </label>
            <label className="modal-ack-label">
              <input
                type="checkbox"
                checked={cancelDataDeletionAck}
                onChange={(e) => setCancelDataDeletionAck(e.target.checked)}
              />
              I understand my posts and stored media will be permanently deleted 30 days after my access ends.
            </label>
            <div className="modal-actions">
              <button className="btn-outline" onClick={() => setShowCancelModal(false)}>
                Keep my plan
              </button>
              <button
                className="modal-confirm-cancel"
                onClick={handleConfirmCancelSubscription}
                disabled={billingBusy !== null || !cancelDataDeletionAck}
              >
                {billingBusy === "cancel" ? "Cancelling..." : "Submit & Continue to Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingTierChange && (
        <div className="modal-overlay" onClick={() => setPendingTierChange(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Switch to {pendingTierChange.displayName}?</h2>
              <button className="modal-close" onClick={() => setPendingTierChange(null)} aria-label="Close">
                &times;
              </button>
            </div>
            <p className="modal-subtitle">
              You'll move from <strong>{tierNames[currentTier]}</strong> to <strong>{pendingTierChange.displayName}</strong>.
              The prorated price difference is charged to (or credited on) your card on file immediately — this is not a
              fresh checkout, no card entry needed.
            </p>
            <div className="modal-actions">
              <button className="btn-outline" onClick={() => setPendingTierChange(null)}>
                Cancel
              </button>
              <button
                className="cta"
                onClick={() => {
                  const tier = pendingTierChange.tier;
                  setPendingTierChange(null);
                  handleChangeTier(tier);
                }}
                disabled={billingBusy !== null}
              >
                Confirm switch
              </button>
            </div>
          </div>
        </div>
      )}
      {showPinterestConnectModal && (
        <PinterestConnectModal
          onCancel={() => setShowPinterestConnectModal(false)}
          onConnect={() => {
            setShowPinterestConnectModal(false);
            handleConnect("pinterest");
          }}
        />
      )}
      <SupportWidget />
    </>
    </DashboardContext.Provider>
  );
}
