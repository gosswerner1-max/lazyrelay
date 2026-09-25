// The "Settings" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { CodeBlock } from "../../components/CodeBlock";
import { MediaStorageList } from "../../components/MediaStorageList";
import { formatBytes } from "../../lib/format";
import { GOOGLE_INTEGRATIONS_LIVE } from "./dashboardHelpers";
import { useDashboard } from "./DashboardContext";

export function SettingsTab() {
  const {
    session,
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
    webhookUrlInput,
    setWebhookUrlInput,
    savingWebhook,
    regeneratingWebhookSecret,
    revealedWebhookSecret,
    setRevealedWebhookSecret,
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
    showAgencyBilling,
    setShowAgencyBilling,
    setPendingTierChange,
    setShowCancelModal,
    mediaAltTextDrafts,
    setMediaAltTextDrafts,
    billingSectionRef,
    handleDeleteMedia,
    handleSaveMediaAltText,
    handleUpgrade,
    handleBuyStorageAddon,
    handleCancelStorageAddon,
    handleBuySeatAddon,
    handleCancelSeatAddon,
    handleSaveBusinessName,
    handleSaveVoiceProfile,
    handleInviteTeamMember,
    handleRemoveTeamMember,
    handleResendTeamInvite,
    handleToggleFailureAlerts,
    handleSaveWebhook,
    handleClearWebhook,
    handleRegenerateWebhookSecret,
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
    currentTier,
  } = useDashboard();

  return (
    <>
      {(
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
                      ? "Storage full. Delete files below to upload new media."
                      : "Getting full. Delete unused files or upgrade for more space."}
                  </span>
                )}
              </div>
            </div>
          );
        })()}
        {mediaFiles.length === 0 ? (
          <p className="empty">No uploaded media yet.</p>
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

      {(
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

      {(
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
                <CodeBlock code={mfaRecoveryCodes.join("\n")} />
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

      {(
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

      {(
      <section>
        <h2>Webhook</h2>
        <p className="section-note">
          Get an HTTPS POST the moment a scheduled post's Proof-of-Publish check confirms it went live. Useful
          for wiring LazyRelay into your own systems, or a tool like Zapier, n8n, or Make. Each delivery is
          signed with your secret (HMAC-SHA256, in the X-LazyRelay-Signature header) so you can verify it
          genuinely came from LazyRelay.
        </p>
        <form onSubmit={handleSaveWebhook} className="dm-automation-form">
          <input
            type="url"
            placeholder="https://your-endpoint.example.com/webhook"
            value={webhookUrlInput}
            onChange={(e) => setWebhookUrlInput(e.target.value)}
            maxLength={2000}
          />
          <button type="submit" disabled={savingWebhook || !webhookUrlInput.trim()}>
            {savingWebhook ? "Saving..." : "Save"}
          </button>
          {account?.webhookUrl && (
            <button type="button" className="btn-outline" onClick={handleClearWebhook} disabled={savingWebhook}>
              Remove
            </button>
          )}
        </form>
        {account?.webhookConfigured && (
          <button
            type="button"
            className="btn-outline"
            onClick={handleRegenerateWebhookSecret}
            disabled={regeneratingWebhookSecret || !account.webhookUrl}
            style={{ marginTop: 8 }}
          >
            {regeneratingWebhookSecret ? "Generating..." : "Regenerate secret"}
          </button>
        )}
        {revealedWebhookSecret && (
          <div className="api-key-reveal" style={{ marginTop: 12 }}>
            <p><strong>Copy this secret now.</strong> It won't be shown again.</p>
            <CodeBlock code={revealedWebhookSecret} sensitive />
            <button type="button" className="btn-outline" onClick={() => setRevealedWebhookSecret(null)}>
              Done
            </button>
          </div>
        )}
      </section>
      )}

      {(
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
            customers. See <a href="/in-the-works">what's in the works</a>.
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

      {(
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
            customers. See <a href="/in-the-works">what's in the works</a>.
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

      {(() => {
        const myMembership = team.find((m) => m.user_id === session?.user.id);
        const isOwner = !myMembership || myMembership.role === "owner";
        // Mirrors checkSeatLimit's own counting rule (seatLimits.ts): every
        // non-owner row counts, pending invites included, since an unaccepted
        // invite still reserves a seat.
        const seatsUsed = team.filter((m) => m.role !== "owner").length;
        const seatTotalLimit = seatCapacity?.totalLimit ?? 0;
        const atSeatCap = seatTotalLimit > 0 && seatsUsed >= seatTotalLimit;
        const canBuySeatAddon = subscription?.tier === "enterprise" || subscription?.tier === "agency" || subscription?.tier === "agency_plus";
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
        {isOwner && atSeatCap && canBuySeatAddon && (
          <p className="section-note">
            At your plan's seat limit.{" "}
            <button type="button" className="btn-outline" disabled={seatAddonBusy !== null} onClick={handleBuySeatAddon}>
              {seatAddonBusy === "checkout" ? "Starting checkout..." : "Buy another seat ($10/mo)"}
            </button>
          </p>
        )}
        {isOwner && atSeatCap && !canBuySeatAddon && (
          <p className="section-note">At your plan's seat limit. Upgrade to Business, Agency, or Agency Plus for more seats.</p>
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

      {(
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

      {currentTier !== "free" && (
      <section>
        <h2>Buy more storage</h2>
        <p className="section-note">Add extra space on top of your plan's included storage. Cancel any add-on separately, any time.</p>
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
        )}
      </section>
      )}

      {(
      <section ref={billingSectionRef}>
        <h2>Billing</h2>
        {(() => {
          const tierNames = {
    free: "Free",
    pro: "Starter",
    business: "Pro",
    enterprise: "Business",
    agency: "Agency",
    agency_plus: "Agency Plus",
  } as const;
          // Deferred cancellation (migration 0043): `status` only becomes
          // "cancelled" once the real period-end cancellation lands via
          // webhook, so this stays keyed on status alone — a customer with
          // a pending cancellation is still genuinely on their paid plan
          // and shouldn't see upgrade/resubscribe buttons yet.
          const canUpgrade = !subscription || subscription.tier === "free" || subscription.status === "cancelled";
          // Truly lapsed (tier already reverted) — label the resume action
          // "Resubscribe" so it doesn't read as contradictory next to
          // "Current plan: Pro". Distinct from isPendingCancellation below:
          // by the time this is true, cancelAtPeriodEnd has already been
          // reset (see syncSubscriptionFromWebhook), so the two never
          // overlap.
          const isCancelling = subscription?.tier !== "free" && subscription?.status === "cancelled";
          // Still on the paid plan, but a cancellation is scheduled for the
          // end of the current period — real access continues (resolveTier
          // still grants it server-side); this only drives the status badge
          // text so the customer sees an accurate "cancelling: ends X"
          // instead of nothing changing at all after they click cancel.
          const isPendingCancellation = subscription?.tier !== "free" && subscription?.cancelAtPeriodEnd === true;
          const periodEndDate = subscription?.currentPeriodEnd
            ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : null;
          // One button per pricing card, three real states (found live
          // 2026-08-21 that only the first of these existed -- an already-
          // paying customer had no self-serve way to move tiers at all,
          // only cancel-and-lose-access):
          // 1. This card matches the customer's current tier -> disabled
          //    "Current plan" badge, not a button at all.
          // 2. canUpgrade (Free, or a lapsed/cancelled account) -> the
          //    existing checkout-overlay flow via handleUpgrade.
          // 3. Already on a different paid tier -> the real proration flow
          //    via handleChangeTier, no checkout overlay needed.
          function renderTierAction(tierCode: "pro" | "business" | "enterprise" | "agency" | "agency_plus", displayName: string) {
            if (subscription?.tier === tierCode && !isCancelling) {
              return (
                <button className="cta cta-current-plan" disabled>
                  Current plan
                </button>
              );
            }
            if (canUpgrade) {
              return (
                <button className="cta" onClick={() => handleUpgrade(tierCode)} disabled={billingBusy !== null}>
                  {billingBusy === tierCode ? "Starting checkout..." : isCancelling ? `Resubscribe to ${displayName}` : `Upgrade to ${displayName}`}
                </button>
              );
            }
            return (
              <button
                className="cta"
                onClick={() => setPendingTierChange({ tier: tierCode, displayName })}
                disabled={billingBusy !== null}
              >
                {billingBusy === tierCode ? "Starting checkout..." : `Switch to ${displayName}`}
              </button>
            );
          }
          return (
            <>
              <p className="current-plan">
                Current plan: <strong>{subscription ? tierNames[subscription.tier] : "Free"}</strong>
                {subscription?.status && (
                  <span className={`status-badge status-${subscription.status}`}>
                    {isPendingCancellation
                      ? `cancelling${periodEndDate ? `: ends ${periodEndDate}` : ""}`
                      : isCancelling
                        ? "cancelled"
                        : subscription.status}
                  </span>
                )}
              </p>

              <div className="pricing-grid billing-upgrade-grid">
                <div className="pricing-card">
                  <h3>Starter: 5GB storage</h3>
                  <p className="pricing-price">
                    $29.99<span className="pricing-period">/mo</span>
                  </p>
                  <p className="pricing-note">20 accounts, unlimited posts, AI-agent access</p>
                  {renderTierAction("pro", "Starter")}
                </div>
                <div className="pricing-card">
                  <h3>Pro: 10GB storage</h3>
                  <p className="pricing-price">
                    $59.99<span className="pricing-period">/mo</span>
                  </p>
                  <p className="pricing-note">40 accounts, unlimited posts, AI-agent access, priority support</p>
                  {renderTierAction("business", "Pro")}
                </div>
                <div className="pricing-card">
                  <h3>Business: 20GB storage</h3>
                  <p className="pricing-price">
                    $99.99<span className="pricing-period">/mo</span>
                  </p>
                  <p className="pricing-note">100 accounts, unlimited posts, AI-agent access, priority support</p>
                  {renderTierAction("enterprise", "Business")}
                </div>
              </div>

              {!showAgencyBilling && (
                <button type="button" className="btn-outline pricing-agency-toggle" onClick={() => setShowAgencyBilling(true)}>
                  Running an agency? See Agency plans &rarr;
                </button>
              )}

              {showAgencyBilling && (
                <div className="pricing-grid pricing-grid-agency">
                  <div className="pricing-card">
                    <h3>Agency: 20GB storage</h3>
                    <p className="pricing-price">
                      $149.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">100 accounts, 12 brands, 3 team seats, AI-agent access, priority support</p>
                    {renderTierAction("agency", "Agency")}
                  </div>
                  <div className="pricing-card">
                    <h3>Agency Plus: 20GB storage</h3>
                    <p className="pricing-price">
                      $199.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">150 accounts, 20 brands, 6 team seats, AI-agent access, priority support</p>
                    {renderTierAction("agency_plus", "Agency Plus")}
                  </div>
                </div>
              )}

              {!canUpgrade && (
                <button className="btn-outline" onClick={() => setShowCancelModal(true)} disabled={billingBusy !== null}>
                  Cancel subscription
                </button>
              )}
            </>
          );
        })()}
      </section>
      )}
    </>
  );
}
