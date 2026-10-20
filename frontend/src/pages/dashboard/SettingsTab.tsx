// The "Settings" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { MediaStorageList } from "../../components/MediaStorageList";
import { formatBytes } from "../../lib/format";
import { GOOGLE_INTEGRATIONS_LIVE } from "./dashboardHelpers";
import { useDashboard } from "./DashboardContext";
import { WebhooksSection } from "./WebhooksSection";
import { SnippetsSection } from "./SnippetsSection";
import { PostingSlotsSection } from "./PostingSlotsSection";
import { RssFeedsSection } from "./RssFeedsSection";
import { ReviewLinksSection } from "./ReviewLinksSection";
import { CustomPlatformSettings } from "../../components/dashboard/CustomPlatformSettings";
import { LiveBilling } from "../../lib/billingFlag";
import { useWallet } from "../../lib/walletContext";


type SettingsSub = "general" | "security" | "team" | "automation" | "keys" | "billing";
const SETTINGS_SUBS: { id: SettingsSub; label: string }[] = [
  { id: "general", label: "General" },
  { id: "security", label: "Security" },
  { id: "team", label: "Team" },
  { id: "automation", label: "Automation" },
  { id: "keys", label: "Custom developer keys" },
  { id: "billing", label: "Plan & billing" },
];

export function SettingsTab() {
  const {
    session,
    deferredLoading,
    subscription,
    storageUsage,
    mediaFiles,
    mediaBusyId,
    storageAddons,
    addonBusy,
    account,
    businessNameInput,
    setBusinessNameInput,
    savingBusinessName,
    voiceProfileInput,
    setVoiceProfileInput,
    savingVoiceProfile,
    team,
    teamInviteEmail,
    setTeamInviteEmail,
    invitingTeamMember,
    removingTeamMemberId,
    resendingTeamInviteId,
    announcingAdmin,
    adminWindowExpiresAt,
    savingFailureAlerts,
    savingBrandingTag,
    gcalStatus,
    gcalConnecting,
    gcalDisconnecting,
    gsheetStatus,
    gsheetConnecting,
    gsheetDisconnecting,
    mfaFactorId,
    mfaEnrolling,
    mfaEnrollment,
    mfaVerifyCode,
    setMfaVerifyCode,
    mfaVerifying,
    mfaVerified,
    mfaUnenrolling,
    mfaRecoveryCodes,
    setMfaRecoveryCodes,
    mfaGeneratingRecoveryCodes,
    setRunTour,
    seatCapacity,
    seatAddonBusy,
    billingBusy,
    setShowCancelModal,
    mediaAltTextDrafts,
    setMediaAltTextDrafts,
    billingSectionRef,
    scrollToBillingPending,
    setScrollToBillingPending,
    handleDeleteMedia,
    handleSaveMediaAltText,
    handleCancelStorageAddon,
    handleCancelSeatAddon,
    handleSaveBusinessName,
    handleSaveVoiceProfile,
    handleInviteTeamMember,
    handleRemoveTeamMember,
    handleResendTeamInvite,
    handleToggleFailureAlerts,
    handleToggleBrandingTag,
    handleConnectGoogleCalendar,
    handleDisconnectGoogleCalendar,
    handleConnectGoogleSheets,
    handleDisconnectGoogleSheets,
    handleStartMfaEnrollment,
    handleCancelMfaEnrollment,
    handleConfirmMfaEnrollment,
    handleRemoveMfa,
    handleGenerateMfaRecoveryCodes,
    handleAnnounceAdminAction,
    accounts,
    platforms,
    refresh,
    setError,
  } = useDashboard();
  const { billingActive, wallet } = useWallet(); // billingActive: billing on and a normal (non-exempt) account, so the credit wallet is what is sold
  // Cancel works on the one subscription row, so it covers the new Growth and Pro plans and any older paid plan alike.
  const paidPlan = subscription?.tier !== undefined && subscription.tier !== "free" && subscription.status !== "cancelled";
  const walletPaid = billingActive && (wallet?.plan.walletPlan === "growth" || wallet?.plan.walletPlan === "pro");
  const cancelPending = subscription?.cancelAtPeriodEnd === true;
  const canCancel = (paidPlan || walletPaid) && !cancelPending;
  const pendingCancelEnd = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;
  const pendingCancelLine = paidPlan && cancelPending ? `Your plan is set to cancel${pendingCancelEnd ? ` on ${pendingCancelEnd}` : " at the end of this billing period"}.` : null;
  // The plan banner's Upgrade button asks for the Billing section, so open that sub-tab and scroll to it.
  const [sub, setSub] = useState<SettingsSub>(scrollToBillingPending ? "billing" : "general");
  useEffect(() => {
    if (!scrollToBillingPending) return;
    if (sub !== "billing") {
      setSub("billing");
      return;
    }
    billingSectionRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
    setScrollToBillingPending(false);
  }, [scrollToBillingPending, sub, billingSectionRef, setScrollToBillingPending]);
  // "Custom developer keys" (X and WhatsApp with the customer's own credentials) appears only when the backend lists one of
  // those platforms for THIS account: with the feature switches off there is no sub-tab at all. The backend decides who may
  // connect (plan, release switch); this only decides whether there is anything to show.
  const hasByokPlatforms = platforms.some((p) => p.platform === "x" || p.platform === "whatsapp");
  // If the platforms disappear while the sub-tab is open, show General instead of an empty page (derived, not an effect).
  const view: SettingsSub = sub === "keys" && !hasByokPlatforms ? "general" : sub;
  const webhookChannels = accounts.map((a) => ({
    id: a.id,
    label: `${a.platform.charAt(0).toUpperCase()}${a.platform.slice(1)}: ${a.display_name ?? a.platform_account_id}`,
  }));

  const visibleSubs = SETTINGS_SUBS.filter((t) => t.id !== "keys" || hasByokPlatforms);
  const idBase = useId();
  const tabId = (id: SettingsSub) => `${idBase}-tab-${id}`;
  const panelId = `${idBase}-panel`;
  const tabRefs = useRef<Partial<Record<SettingsSub, HTMLButtonElement | null>>>({});
  // WAI-ARIA tabs: one tab stop (the selected tab), arrow keys move between tabs, Home and End jump to the ends.
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % visibleSubs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + visibleSubs.length) % visibleSubs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = visibleSubs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = visibleSubs[next].id;
    setSub(target);
    tabRefs.current[target]?.focus();
  };

  return (
    <>
      <div className="settings-subtabs" role="tablist" aria-label="Settings sections">
        {visibleSubs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={tabId(t.id)}
            aria-selected={t.id === view}
            aria-controls={panelId}
            tabIndex={t.id === view ? 0 : -1}
            className={t.id === view ? "settings-subtab-active" : ""}
            onClick={() => setSub(t.id)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(view)}>
      {view === "keys" && hasByokPlatforms && <CustomPlatformSettings platforms={platforms} onConnected={() => void refresh()} onSeePlans={() => setSub("billing")} accounts={accounts} />}
      {view === "billing" && (
      <section>
        <h2>Storage</h2>
        {deferredLoading && !storageUsage && (
          // Same box as the real gauge, invisible, so the list below doesn't jump when the numbers arrive.
          <div className="storage-gauge" aria-hidden="true" style={{ visibility: "hidden" }}>
            <div className="storage-gauge-track">
              <div className="storage-gauge-fill" style={{ width: "0%" }} />
            </div>
            <div className="storage-gauge-label">
              <span>&nbsp;</span>
            </div>
          </div>
        )}
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
                      ? "Storage full. Delete files below to upload new media."
                      : "Getting full. Delete unused files to free up space."}
                  </span>
                )}
              </div>
            </div>
          );
        })()}
        {mediaFiles.length === 0 ? (
          <p className="empty" aria-busy={deferredLoading || undefined}>{deferredLoading ? "Loading media..." : "No uploaded media yet."}</p>
        ) : (
          <MediaStorageList
            mediaFiles={mediaFiles}
            renderItem={(m) => {
              const altDraft = mediaAltTextDrafts[m.id] ?? m.alt_text ?? "";
              const altDirty = altDraft !== (m.alt_text ?? "");
              return (
                <li key={m.id}>
                  {m.mime_type.startsWith("image/") ? (
                    // Real per-file alt text if the customer set one in the
                    // field below (the whole point of that field), rather
                    // than the hardcoded alt="" this thumbnail used to have
                    // regardless -- found in the 2026-09-06 compliance audit.
                    <img className="media-list-thumb" src={m.url} alt={m.alt_text || "Uploaded media, no alt text set yet"} />
                  ) : (
                    <div className="media-list-thumb" />
                  )}
                  <span className="media-list-meta">
                    {formatBytes(m.size_bytes)}
                    {m.width && m.height ? ` · ${m.width}×${m.height}` : ""} ·{" "}
                    {new Date(m.created_at).toLocaleDateString()}
                  </span>
                  {m.mime_type.startsWith("image/") && (
                    <input
                      type="text"
                      className="brand-label-input"
                      placeholder="Alt text (optional)"
                      value={altDraft}
                      maxLength={1000}
                      disabled={mediaBusyId === m.id}
                      onChange={(e) => setMediaAltTextDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                    />
                  )}
                  {altDirty && (
                    <button
                      className="btn-outline"
                      disabled={mediaBusyId !== null}
                      onClick={() => handleSaveMediaAltText(m.id, altDraft)}
                    >
                      {mediaBusyId === m.id ? "Saving..." : "Save"}
                    </button>
                  )}
                  <button
                    className="btn-outline"
                    onClick={() => handleDeleteMedia(m.id)}
                    disabled={mediaBusyId !== null}
                  >
                    {mediaBusyId === m.id ? "Deleting..." : "Delete"}
                  </button>
                </li>
              );
            }}
          />
        )}
      </section>
      )}

      {view === "general" && (
      <section>
        <h2>Account</h2>
        <form onSubmit={handleSaveBusinessName} className="account-name-form">
          <label>
            What should we call you?
            <input
              type="text"
              value={businessNameInput}
              onChange={(e) => setBusinessNameInput(e.target.value)}
              placeholder="Your business or brand name"
              maxLength={80}
            />
          </label>
          <button type="submit" disabled={savingBusinessName}>
            {savingBusinessName ? "Saving..." : "Save"}
          </button>
        </form>
        <p className="section-note">
          New here? <button type="button" className="link-button" data-tour="replay-tour" onClick={() => setRunTour(true)}>Replay the product tour</button>
        </p>
        <form onSubmit={handleSaveVoiceProfile} className="account-name-form">
          <label>
            Brand voice (default)
            <textarea
              value={voiceProfileInput}
              onChange={(e) => setVoiceProfileInput(e.target.value)}
              placeholder="e.g. Casual and funny, short sentences, lots of emoji, talks directly to the reader as 'you'"
              maxLength={2000}
              rows={3}
            />
          </label>
          <p className="section-note">
            Used by AI captions and hashtag suggestions. Running multiple brands? Set a different voice per brand in
            the Brands manager on the Social Platforms tab — that overrides this default for accounts in that brand.
          </p>
          <button type="submit" disabled={savingVoiceProfile}>
            {savingVoiceProfile ? "Saving..." : "Save"}
          </button>
        </form>
      </section>
      )}

      {view === "security" && (
      <section>
        <h2>Two-factor authentication</h2>
        <p className="section-note">
          Add a second step at sign-in using an authenticator app (Google Authenticator, Authy, 1Password, etc.),
          on top of your password. Optional — turn it on whenever you like, remove it whenever you like.
        </p>
        {mfaFactorId === undefined ? (
          <p className="section-note">Checking your two-factor status...</p>
        ) : mfaEnrollment ? (
          <div className="api-key-reveal">
            {mfaVerified ? (
              <>
                <p><strong>Two-factor authentication is now enabled.</strong></p>
                {mfaRecoveryCodes && (
                  <>
                    <p>
                      <strong>Save these recovery codes</strong> somewhere safe — each one lets you back into your
                      account if you ever lose access to your authenticator app. They won't be shown again.
                    </p>
                    <CodeBlock code={mfaRecoveryCodes.join("\n")} sensitive />
                  </>
                )}
                <button type="button" className="btn-outline" onClick={handleCancelMfaEnrollment}>
                  Done
                </button>
              </>
            ) : (
              <>
                <p>
                  <strong>Scan this QR code</strong> with your authenticator app, or enter the secret manually, then
                  enter the 6-digit code it shows to confirm.
                </p>
                <img src={mfaEnrollment.qrCode} alt="Two-factor authentication QR code" width={200} height={200} />
                <CodeBlock code={mfaEnrollment.secret} sensitive />
                <form onSubmit={handleConfirmMfaEnrollment} className="dm-automation-form">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-digit code"
                    value={mfaVerifyCode}
                    onChange={(e) => setMfaVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    maxLength={6}
                  />
                  <button type="submit" className="btn-primary" disabled={mfaVerifying || mfaVerifyCode.length !== 6}>
                    {mfaVerifying ? "Verifying..." : "Confirm"}
                  </button>
                </form>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={handleCancelMfaEnrollment}
                  disabled={mfaVerifying}
                  style={{ marginTop: 8 }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : mfaFactorId ? (
          <>
            <p className="status-badge status-active">Two-factor authentication is enabled</p>
            {mfaRecoveryCodes && (
              <div className="api-key-reveal" style={{ marginTop: 12 }}>
                <p>
                  <strong>Save these recovery codes</strong> somewhere safe — each one lets you back into your
                  account if you ever lose access to your authenticator app. They won't be shown again.
                </p>
                <CodeBlock code={mfaRecoveryCodes.join("\n")} sensitive />
                <button type="button" className="btn-outline" onClick={() => setMfaRecoveryCodes(null)}>
                  Done
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button
                type="button"
                className="btn-outline"
                onClick={() => handleGenerateMfaRecoveryCodes(true)}
                disabled={mfaGeneratingRecoveryCodes}
              >
                {mfaGeneratingRecoveryCodes ? "Generating..." : "Regenerate recovery codes"}
              </button>
              <button type="button" className="btn-outline" onClick={handleRemoveMfa} disabled={mfaUnenrolling}>
                {mfaUnenrolling ? "Removing..." : "Remove two-factor authentication"}
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="btn-outline" onClick={handleStartMfaEnrollment} disabled={mfaEnrolling}>
            {mfaEnrolling ? "Starting..." : "Enable two-factor authentication"}
          </button>
        )}
      </section>
      )}

      {view === "general" && (
      <section>
        <h2>Failure alerts</h2>
        <p className="section-note">
          Off by default. If you rely on LazyRelay for real income (client work, a business that needs posts
          to go out on time), turn this on to get an email the moment a post genuinely fails, instead of only
          finding out when you check your dashboard.
        </p>
        <label className="api-key-share-proof-toggle">
          <input
            type="checkbox"
            checked={account?.emailFailureAlertsEnabled ?? false}
            disabled={savingFailureAlerts || !account}
            onChange={(e) => handleToggleFailureAlerts(e.target.checked)}
          />
          Email me if a scheduled post fails
        </label>
      </section>
      )}

      {view === "general" && (
      <section>
        <h2>LazyRelay branding</h2>
        <p className="section-note">
          On the Free plan, posts published through LazyRelay carry a small "scheduled via LazyRelay" credit
          (in the first comment on Facebook/Instagram, or appended to the caption itself where a platform
          doesn't support a separate first comment). Turn this off any time — it never shows on a paid plan
          either way.
        </p>
        <label className="api-key-share-proof-toggle">
          <input
            type="checkbox"
            checked={account?.showBrandingTag ?? true}
            disabled={savingBrandingTag || !account}
            onChange={(e) => handleToggleBrandingTag(e.target.checked)}
          />
          Show the LazyRelay branding credit on my posts
        </label>
      </section>
      )}

      {view === "automation" && (<>
      <WebhooksSection channels={webhookChannels} onError={setError} />

      <SnippetsSection onError={setError} />

      <PostingSlotsSection onError={setError} />

      <RssFeedsSection onError={setError} />

      <ReviewLinksSection brands={[...new Set(accounts.map((a) => a.brand_label).filter((b): b is string => !!b))]} onError={setError} />
      </>)}

      {view === "automation" && (
      <section className={GOOGLE_INTEGRATIONS_LIVE ? undefined : "settings-section-disabled"}>
        <h2>
          Google Calendar {!GOOGLE_INTEGRATIONS_LIVE && <span className="coming-soon-badge">Coming soon</span>}
        </h2>
        <p className="section-note">
          Two-way sync with a dedicated "LazyRelay Posts" calendar on your Google account. Every event in it is
          a real scheduled post — move, edit, or delete one there and LazyRelay picks up the change. Create a
          new event there and it lands in LazyRelay as a planned idea for that day, ready for you to pick a
          platform and time. Subscribe to that calendar on your phone to see (and change) your posting
          schedule anywhere.
        </p>
        {!GOOGLE_INTEGRATIONS_LIVE ? (
          <p className="section-note">
            Built and working, but waiting on Google's own app verification review before it can open up to real
            customers. See <a href="/in-the-works/">what's in the works</a>.
          </p>
        ) : gcalStatus === undefined ? (
          <p className="section-note">Checking your Google Calendar connection...</p>
        ) : gcalStatus ? (
          <>
            <p>
              <strong>{gcalStatus.connected_email ? `Connected as ${gcalStatus.connected_email}.` : "Connected."}</strong>
              {gcalStatus.last_synced_at && ` Last synced ${new Date(gcalStatus.last_synced_at).toLocaleString()}.`}
            </p>
            <button type="button" className="btn-outline" onClick={handleDisconnectGoogleCalendar} disabled={gcalDisconnecting}>
              {gcalDisconnecting ? "Disconnecting..." : "Disconnect"}
            </button>
          </>
        ) : (
          <button type="button" onClick={handleConnectGoogleCalendar} disabled={gcalConnecting}>
            {gcalConnecting ? "Connecting..." : "Connect Google Calendar"}
          </button>
        )}
      </section>
      )}

      {view === "automation" && (
      <section className={GOOGLE_INTEGRATIONS_LIVE ? undefined : "settings-section-disabled"}>
        <h2>
          Google Sheets {!GOOGLE_INTEGRATIONS_LIVE && <span className="coming-soon-badge">Coming soon</span>}
        </h2>
        <p className="section-note">
          A live-updating spreadsheet mirror of your content calendar — one dedicated sheet on your Google
          account, one row per scheduled post. Handy for sharing a read-only view with a client, or bulk-reviewing
          a month of posts. One-way for now: edits happen in LazyRelay, the sheet always reflects the latest state.
        </p>
        {!GOOGLE_INTEGRATIONS_LIVE ? (
          <p className="section-note">
            Built and working, but waiting on Google's own app verification review before it can open up to real
            customers. See <a href="/in-the-works/">what's in the works</a>.
          </p>
        ) : gsheetStatus === undefined ? (
          <p className="section-note">Checking your Google Sheets connection...</p>
        ) : gsheetStatus ? (
          <>
            <p>
              <strong>{gsheetStatus.connected_email ? `Connected as ${gsheetStatus.connected_email}.` : "Connected."}</strong>
              {gsheetStatus.last_synced_at && ` Last synced ${new Date(gsheetStatus.last_synced_at).toLocaleString()}.`}
            </p>
            {gsheetStatus.spreadsheet_id && (
              <p>
                <a href={`https://docs.google.com/spreadsheets/d/${gsheetStatus.spreadsheet_id}/edit`} target="_blank" rel="noreferrer">
                  Open my sheet
                </a>
              </p>
            )}
            <button type="button" className="btn-outline" onClick={handleDisconnectGoogleSheets} disabled={gsheetDisconnecting}>
              {gsheetDisconnecting ? "Disconnecting..." : "Disconnect"}
            </button>
          </>
        ) : (
          <button type="button" onClick={handleConnectGoogleSheets} disabled={gsheetConnecting}>
            {gsheetConnecting ? "Connecting..." : "Connect Google Sheets"}
          </button>
        )}
      </section>
      )}

      {view === "team" && (() => {
        // The owner-only controls below are decided from the team list, so don't draw any of them (an empty list
        // reads as "you are the owner") until it has actually loaded.
        if (deferredLoading) return <p className="empty" aria-busy="true">Loading team...</p>;
        const myMembership = team.find((m) => m.user_id === session?.user.id);
        const isOwner = !myMembership || myMembership.role === "owner";
        // Mirrors checkSeatLimit's own counting rule (seatLimits.ts): every
        // non-owner row counts, pending invites included, since an unaccepted
        // invite still reserves a seat.
        const seatsUsed = team.filter((m) => m.role !== "owner").length;
        const seatTotalLimit = seatCapacity?.totalLimit ?? 0;
        const atSeatCap = seatTotalLimit > 0 && seatsUsed >= seatTotalLimit;
        return (
      <section>
        <h2>Seats</h2>
        <p className="section-note">
          Invite teammates to work in this account alongside you. Everyone on the team can post, schedule, and
          manage connected platforms; only the owner can change billing, webhooks, API keys, and the team itself.
        </p>
        {seatTotalLimit > 0 && (
          <p className="brands-manager-header">
            Seats ({seatsUsed}/{seatTotalLimit})
            {!!seatCapacity?.addonSlots && ` (includes ${seatCapacity.addonSlots} purchased add-on${seatCapacity.addonSlots === 1 ? "" : "s"})`}
          </p>
        )}
        {isOwner && (
          <form onSubmit={handleInviteTeamMember} className="dm-automation-form">
            <input
              type="email"
              placeholder="teammate@example.com"
              value={teamInviteEmail}
              onChange={(e) => setTeamInviteEmail(e.target.value)}
              maxLength={254}
              disabled={atSeatCap}
            />
            <button type="submit" disabled={invitingTeamMember || !teamInviteEmail.trim() || atSeatCap}>
              {invitingTeamMember ? "Inviting..." : "Invite"}
            </button>
          </form>
        )}
        {isOwner && atSeatCap && (
          <p className="section-note">At your plan's seat limit.</p>
        )}
        <ul className="media-list">
          {team.map((m) => {
            // Mirrors TEAM_INVITE_EXPIRY_MS / the invited_at check in
            // POST /team/accept-invite (backend/src/http/routes.ts) --
            // purely a display hint here, the real enforcement is server-side.
            const isExpired = !m.accepted_at && Date.now() - new Date(m.invited_at).getTime() > 72 * 60 * 60 * 1000;
            return (
            <li key={m.id}>
              <span className="media-list-meta">
                <strong>{m.invited_email ?? (m.user_id === session?.user.id ? session?.user.email : m.user_id)}</strong>
                {" ("}
                {m.role}
                {")"}
                {!m.accepted_at && (
                  <span className={`status-badge ${isExpired ? "status-cancelled" : "status-pending"}`}>
                    {isExpired ? "invite expired" : "invited, not yet accepted"}
                  </span>
                )}
              </span>
              {isOwner && !m.accepted_at && m.role !== "owner" && (
                <button
                  className="btn-outline"
                  onClick={() => handleResendTeamInvite(m.id)}
                  disabled={resendingTeamInviteId !== null}
                >
                  {resendingTeamInviteId === m.id ? "Resending..." : "Resend"}
                </button>
              )}
              {isOwner && m.role !== "owner" && (
                <button
                  className="btn-outline"
                  onClick={() => handleRemoveTeamMember(m.id, m.invited_email ?? "this member")}
                  disabled={removingTeamMemberId !== null}
                >
                  {removingTeamMemberId === m.id ? "Removing..." : "Remove"}
                </button>
              )}
            </li>
            );
          })}
        </ul>
        {isOwner && seatCapacity && seatCapacity.addons.length > 0 && (
          <ul className="media-list">
            {seatCapacity.addons.map((a) => (
              <li key={a.id}>
                <span className="media-list-meta">
                  +1 seat
                  <span className={`status-badge status-${a.status}`}>
                    {a.cancel_at_period_end
                      ? `cancelling${a.current_period_end ? `: ends ${new Date(a.current_period_end).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`
                      : a.status}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={seatAddonBusy !== null}
                  onClick={() => handleCancelSeatAddon(a.id)}
                >
                  {seatAddonBusy === a.id ? "Cancelling..." : "Cancel"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
        );
      })()}

      {view === "security" && (
      <section>
        <h2>Authorize admin support access</h2>
        <p className="section-note">
          If someone from LazyRelay support (or an AI agent working on your behalf, e.g. Claude) needs to look
          something up or fix something on your account using internal admin access, click below first. This opens
          a 10-minute window. Nothing works with admin access unless you open it, even with a valid admin key.
        </p>
        {adminWindowExpiresAt && new Date(adminWindowExpiresAt) > new Date() ? (
          <p className="status-badge status-active">
            Open until {new Date(adminWindowExpiresAt).toLocaleTimeString()}
          </p>
        ) : (
          <button type="button" className="btn-outline" onClick={handleAnnounceAdminAction} disabled={announcingAdmin}>
            {announcingAdmin ? "Opening..." : "Authorize next admin action (10 min)"}
          </button>
        )}
      </section>
      )}

      {view === "billing" && storageAddons.length > 0 && (
      <section>
        <h2>Storage add-ons</h2>
        <p className="section-note">Storage add-ons are no longer sold. You can cancel the ones you already have, any time.</p>
        <ul className="media-list">
          {storageAddons.map((a) => (
            <li key={a.id}>
              <span className="media-list-meta">
                +{a.gb_amount}GB storage
                <span className={`status-badge status-${a.status}`}>
                  {a.cancel_at_period_end
                    ? `cancelling${a.current_period_end ? `: ends ${new Date(a.current_period_end).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`
                    : a.status}
                </span>
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
      </section>
      )}

      {view === "billing" && (
      <section ref={billingSectionRef}>
        <h2>Billing</h2>
        {LiveBilling && billingActive ? (
          <Suspense fallback={null}><LiveBilling /></Suspense>
        ) : wallet?.exempt ? (
          <p className="section-note">Your account is set up separately, so there are no plans or credits to buy here.</p>
        ) : (
          <p className="section-note">Plans and credits are not available to buy right now.</p>
        )}
        {pendingCancelLine && <p className="section-note">{pendingCancelLine}</p>}
        {canCancel && (
          <button className="btn-outline" onClick={() => setShowCancelModal(true)} disabled={billingBusy !== null}>
            Cancel subscription
          </button>
        )}
      </section>
      )}
      </div>
    </>
  );
}
