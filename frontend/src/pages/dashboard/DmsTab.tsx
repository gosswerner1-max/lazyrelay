// The "DMs" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { PlatformIcon } from "../../components/PlatformIcon";
import { Spinner } from "../../components/Spinner";
import { accountMatchesBrand } from "./dashboardHelpers";
import { BrandFilterSelect, TriageBadge } from "./dashboardComponents";
import { useDashboard } from "./DashboardContext";

export function DmsTab() {
  const {
    accounts,
    brandFilter,
    setBrandFilter,
    dmConversations,
    dmConversationsLoading,
    dmsAttentionOnly,
    setDmsAttentionOnly,
    openConversation,
    dmMessages,
    dmMessagesLoading,
    dmDraft,
    setDmDraft,
    dmSending,
    dmAutomations,
    automationSocialAccountId,
    setAutomationSocialAccountId,
    automationKeyword,
    setAutomationKeyword,
    automationMessage,
    setAutomationMessage,
    creatingAutomation,
    deletingAutomationId,
    handleOpenConversation,
    handleSendDM,
    handleCreateAutomation,
    handleDeleteAutomation,
  } = useDashboard();

  return (
    <>
      {(
      <section>
        <h2>Direct messages</h2>
        <p className="section-note">
          DMs from your connected accounts. Facebook and Instagram support this today. Sending only works
          within each platform's own 24-hour customer-service messaging window.
        </p>
        {dmConversationsLoading && <Spinner />}
        {!dmConversationsLoading && dmConversations && dmConversations.length === 0 && (
          <p className="empty">No conversations yet.</p>
        )}
        {!dmConversationsLoading && dmConversations && dmConversations.length > 0 && (() => {
          const brandFilteredConversations = dmConversations.filter((c) => accountMatchesBrand(accounts.find((a) => a.id === c.socialAccountId), brandFilter));
          const dmAttentionCount = brandFilteredConversations.filter((c) => c.triage?.needsAttention).length;
          const visibleConversations = dmsAttentionOnly ? brandFilteredConversations.filter((c) => c.triage?.needsAttention) : brandFilteredConversations;
          return (
          <div className="dm-layout-wrap">
            <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
            <label className="triage-filter">
              <input type="checkbox" checked={dmsAttentionOnly} onChange={(e) => setDmsAttentionOnly(e.target.checked)} />
              {dmAttentionCount > 0 ? `Show only the ${dmAttentionCount} that need attention` : "Show only conversations that need attention"}
            </label>
          <div className="dm-layout">
            <ul className="dm-conversation-list">
              {visibleConversations.length === 0 && <li className="empty">Nothing needs your attention right now.</li>}
              {visibleConversations.map((c) => (
                <li key={`${c.socialAccountId}-${c.conversationId}`}>
                  <button
                    className={openConversation?.conversationId === c.conversationId ? "dm-conversation-active" : ""}
                    onClick={() => handleOpenConversation(c)}
                  >
                    <PlatformIcon platform={c.platform} size={14} />
                    <span className="dm-conversation-name">{c.participantName}</span>
                    <TriageBadge triage={c.triage} />
                    {c.snippet && <span className="dm-conversation-snippet">{c.snippet}</span>}
                  </button>
                </li>
              ))}
            </ul>
            <div className="dm-thread">
              {!openConversation && <p className="empty">Select a conversation to view it.</p>}
              {openConversation && (
                <>
                  <div className="dm-thread-header">
                    <PlatformIcon platform={openConversation.platform} size={14} />
                    {openConversation.participantName}
                  </div>
                  {dmMessagesLoading && <Spinner />}
                  {!dmMessagesLoading && dmMessages && (
                    <ul className="dm-message-list">
                      {dmMessages.map((m) => (
                        <li key={m.id} className={m.isOwn ? "dm-message-own" : "dm-message-theirs"}>
                          {m.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  <form
                    className="dm-reply-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleSendDM();
                    }}
                  >
                    <input
                      type="text"
                      placeholder="Write a message..."
                      value={dmDraft}
                      onChange={(e) => setDmDraft(e.target.value)}
                      maxLength={2000}
                    />
                    <button type="submit" disabled={dmSending || !dmDraft.trim()}>
                      {dmSending ? "Sending..." : "Send"}
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>
          </div>
          );
        })()}
      </section>
      )}

      {(
      <section>
        <h2>DM automation</h2>
        <p className="section-note">
          When someone comments (optionally matching a keyword), automatically send them a DM, the same
          "comment and I'll message you" pattern popular for giveaways and product drops. Applies to every
          post from the last 30 days on the account you pick, not just one.
        </p>
        <form onSubmit={handleCreateAutomation} className="dm-automation-form">
          <select value={automationSocialAccountId} onChange={(e) => setAutomationSocialAccountId(e.target.value)}>
            <option value="">Pick an account...</option>
            {accounts
              .filter((a) => a.platform === "facebook" || a.platform === "instagram")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.platform}: {a.display_name ?? a.platform_account_id}
                </option>
              ))}
          </select>
          <input
            type="text"
            placeholder="Keyword (optional, blank matches every comment)"
            value={automationKeyword}
            onChange={(e) => setAutomationKeyword(e.target.value)}
            maxLength={100}
          />
          <input
            type="text"
            placeholder="DM message to send"
            value={automationMessage}
            onChange={(e) => setAutomationMessage(e.target.value)}
            maxLength={2000}
          />
          <button type="submit" disabled={creatingAutomation || !automationSocialAccountId || !automationMessage.trim()}>
            {creatingAutomation ? "Creating..." : "Create automation"}
          </button>
        </form>
        {dmAutomations && dmAutomations.length === 0 && <p className="empty">No automations yet.</p>}
        {dmAutomations && dmAutomations.length > 0 && (
          <ul className="media-list">
            {dmAutomations.map((a) => (
              <li key={a.id}>
                <span className="media-list-meta">
                  <strong>{a.social_accounts?.platform ?? "Unknown"}</strong>
                  {a.keyword ? `: keyword "${a.keyword}"` : ": every comment"} → "{a.dm_message}"
                </span>
                <button
                  className="btn-outline"
                  onClick={() => handleDeleteAutomation(a.id)}
                  disabled={deletingAutomationId !== null}
                >
                  {deletingAutomationId === a.id ? "Deleting..." : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
    </>
  );
}
