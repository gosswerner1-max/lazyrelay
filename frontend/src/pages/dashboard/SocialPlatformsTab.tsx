// The "Social Platforms" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { PlatformIcon } from "../../components/PlatformIcon";
import { AccountGroupList } from "../../components/AccountPicker";
import { brandCapFor } from "./dashboardHelpers";
import { useDashboard } from "./DashboardContext";
import { byokBadge, X_CONNECT_PATH, xTileState } from "../../lib/xByok";

export function SocialPlatformsTab() {
  const {
    accounts,
    platforms,
    subscription,
    disconnectingAccountId,
    brands,
    newBrandName,
    setNewBrandName,
    brandBusy,
    brandVoiceDrafts,
    setBrandVoiceDrafts,
    brandVoiceBusyId,
    assigningAccountId,
    brandCapacity,
    brandAddonBusy,
    connectingPlatform,
    setShowPinterestConnectModal,
    setShowMastodonServerModal,
    setShowWhopConnectModal,
    handleConnect,
    handleDisconnectAccount,
    handleCreateBrand,
    handleDeleteBrand,
    handleSaveBrandVoice,
    handleAssignBrand,
    handleBuyBrandAddon,
    handleCancelBrandAddon,
  } = useDashboard();

  return (
    <section>
      <h2>Connected social platforms</h2>
      {accounts.length === 0 ? (
        <p className="empty">No accounts connected yet. Connect one to start scheduling posts.</p>
      ) : (
        <AccountGroupList
          accounts={accounts}
          renderGroupBody={(list) => (
            <ul className="account-list account-picker-group-list">
              {list.map((a) => (
                <li key={a.id}>
                  <span className="platform-badge">
                    <PlatformIcon platform={a.platform} size={13} />
                    {a.platform}
                  </span>
                  {a.display_name ?? a.platform_account_id}
                  {a.platform === "x" && byokBadge(a.byokStatus) && (
                    <span role="status" title={byokBadge(a.byokStatus)!.hint} style={{ color: "#ff5a1f", fontSize: 12, fontWeight: 600, marginLeft: 8 }}>
                      {byokBadge(a.byokStatus)!.text}
                    </span>
                  )}
                  {a.needs_reconnect_at && (
                    <span role="status" style={{ color: "#ff5a1f", fontSize: 12, fontWeight: 600, marginLeft: 8 }}>
                      Reconnect needed: connect this account again below
                    </span>
                  )}
                  <select
                    className="brand-label-input"
                    value={a.brand_id ?? ""}
                    disabled={assigningAccountId === a.id || brands.length === 0}
                    onChange={(e) => handleAssignBrand(a.id, e.target.value || null)}
                    aria-label="Assign brand"
                  >
                    <option value="">{brands.length === 0 ? "No brands yet" : "No brand"}</option>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={disconnectingAccountId !== null}
                    onClick={() => handleDisconnectAccount(a)}
                  >
                    {disconnectingAccountId === a.id ? "Disconnecting..." : "Disconnect"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        />
      )}
      <div className="brands-manager">
        {(() => {
          // Real effective cap once loaded (base tier limit + purchased
          // add-on slots); falls back to the static tier mirror only for
          // the brief window before GET /brand-addons has returned.
          const totalLimit = brandCapacity?.totalLimit ?? brandCapFor(subscription?.tier);
          const atCap = brands.length >= totalLimit;
          const canBuyAddon = subscription?.tier && subscription.tier !== "free";
          return (
            <>
              <p className="brands-manager-header">
                Brands ({brands.length}/{totalLimit})
                {!!brandCapacity?.addonSlots && ` — includes ${brandCapacity.addonSlots} purchased add-on${brandCapacity.addonSlots === 1 ? "" : "s"}`}
              </p>
              {brands.length > 0 && (
                <ul className="brands-list">
                  {brands.map((b) => {
                    const voiceDraft = brandVoiceDrafts[b.id] ?? b.voice_profile ?? "";
                    const voiceDirty = voiceDraft !== (b.voice_profile ?? "");
                    return (
                      <li key={b.id} className="brands-list-item">
                        <div className="brands-list-item-header">
                          {b.name}
                          <button
                            type="button"
                            className="btn-outline"
                            disabled={brandBusy}
                            onClick={() => handleDeleteBrand(b.id)}
                          >
                            Delete
                          </button>
                        </div>
                        <textarea
                          className="brand-voice-input"
                          value={voiceDraft}
                          onChange={(e) => setBrandVoiceDrafts((prev) => ({ ...prev, [b.id]: e.target.value }))}
                          placeholder="Voice override for this brand — leave blank to use your account's default"
                          maxLength={2000}
                          rows={2}
                        />
                        {voiceDirty && (
                          <button
                            type="button"
                            className="btn-outline"
                            disabled={brandVoiceBusyId === b.id}
                            onClick={() => handleSaveBrandVoice(b)}
                          >
                            {brandVoiceBusyId === b.id ? "Saving..." : "Save voice"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="brands-new">
                <input
                  type="text"
                  className="brand-label-input"
                  placeholder="New brand name"
                  value={newBrandName}
                  maxLength={60}
                  disabled={brandBusy || atCap}
                  onChange={(e) => setNewBrandName(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-outline"
                  disabled={brandBusy || !newBrandName.trim() || atCap}
                  onClick={handleCreateBrand}
                >
                  {brandBusy ? "Saving..." : "Add brand"}
                </button>
              </div>
              {atCap && canBuyAddon && (
                <p className="section-note">
                  At your plan's brand limit.{" "}
                  <button type="button" className="btn-outline" disabled={brandAddonBusy !== null} onClick={handleBuyBrandAddon}>
                    {brandAddonBusy === "checkout" ? "Starting checkout..." : "Buy another brand slot — $10/mo"}
                  </button>
                </p>
              )}
              {brandCapacity && brandCapacity.addons.length > 0 && (
                <ul className="media-list">
                  {brandCapacity.addons.map((a) => (
                    <li key={a.id}>
                      <span className="media-list-meta">
                        +1 brand slot
                        <span className={`status-badge status-${a.status}`}>
                          {a.cancel_at_period_end
                            ? `cancelling${a.current_period_end ? `: ends ${new Date(a.current_period_end).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`
                            : a.status}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn-outline"
                        disabled={brandAddonBusy !== null}
                        onClick={() => handleCancelBrandAddon(a.id)}
                      >
                        {brandAddonBusy === a.id ? "Cancelling..." : "Cancel"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        })()}
      </div>
      <p className="section-note">
        Create a brand for each business you run through LazyRelay, then assign your connected accounts to it.
        You can then filter Overview, Posts, Calendar, Analytics, Mentions, and DMs down to a single brand.
      </p>
      <h3>Connect a platform</h3>
      <div className="platform-grid">
        {platforms
          .filter((p) => !p.comingSoon || p.platform === "x")
          .map((p) => {
          // A platform not yet configured on this deploy (missing env
          // vars) is just as unclickable as a genuine "coming soon" one —
          // dim both the same way rather than only handling the X/Reddit
          // case and letting an unconfigured tile error on click.
          const disabled = p.comingSoon || !p.configured;
          const connectedCount = accounts.filter((a) => a.platform === p.platform).length;
          // X is connected with the customer's own keys: locked behind a plan (the backend says which) or a link to the keys page.
          const xTile = p.platform === "x" ? xTileState(p) : null;
          const xLocked = xTile?.kind === "upgrade" && !disabled;
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
                    : xLocked
                      ? "Connecting X with your own developer keys is part of the Pro plan and above"
                      : connectedCount > 0
                        ? "Connected: click to connect another account"
                        : undefined
              }
              onClick={() =>
                p.platform === "x"
                  ? window.location.assign(xLocked ? "/pricing" : X_CONNECT_PATH)
                  : p.platform === "pinterest"
                  ? setShowPinterestConnectModal(true)
                  : p.platform === "mastodon"
                    ? setShowMastodonServerModal(true)
                    : p.platform === "whop"
                      ? setShowWhopConnectModal(true)
                      : handleConnect(p.platform)
              }
            >
              <PlatformIcon platform={p.platform} size={20} comingSoon={disabled} />
              <span className="platform-tile-name" style={p.platform === "devto" ? { textTransform: "none" } : undefined}>{p.platform === "devto" ? "dev.to" : p.platform}</span>
              {p.comingSoon && <span className="platform-tile-badge">Coming soon</span>}
              {xLocked && xTile?.kind === "upgrade" && <span className="platform-tile-badge">{xTile.label}</span>}
              {!disabled && !xLocked && connectedCount > 0 && (
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
  );
}
