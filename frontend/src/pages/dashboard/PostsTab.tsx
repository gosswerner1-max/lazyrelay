// The "Posts" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { api, type ScheduledPost } from "../../lib/api";
import { TIKTOK_PROCESSING_NOTICE, TIKTOK_PRIVACY_LEVEL_LABELS } from "../../lib/tiktokPostChecks";
import { RelaySignal } from "../../components/RelaySignal";
import { PlatformIcon } from "../../components/PlatformIcon";
import { SocialPostPreview } from "../../components/SocialPostPreview";
import { AccountPicker } from "../../components/AccountPicker";
import { DateTimePicker, TimeOfDayPicker } from "../../components/DateTimePicker";
import { DayOfWeekPicker } from "../../components/DayOfWeekPicker";
import { bestTimeFor } from "../../lib/bestTimes";
import { PostErrorDetail } from "../../components/PostErrorDetail";
import { accountMatchesBrand, localDateKey } from "./dashboardHelpers";
import { BrandFilterSelect } from "./dashboardComponents";
import { useDashboard } from "./DashboardContext";

export function PostsTab() {
  const {
    mediaInputRef,
    coverImageInputRef,
    accounts,
    posts,
    setPosts,
    sharingProofId,
    shareProofResult,
    setError,
    setTab,
    brandFilter,
    setBrandFilter,
    content,
    setContent,
    aiTopic,
    setAiTopic,
    requiresApproval,
    setRequiresApproval,
    editingDraftId,
    draftBusy,
    mediaAltText,
    setMediaAltText,
    perAccountContent,
    setPerAccountContent,
    approvingId,
    reschedulingId,
    pauseResumeId,
    duplicatingId,
    aiGenerating,
    hashtagGenerating,
    ideasGenerating,
    contentIdeas,
    scheduleDate,
    setScheduleDate,
    scheduleTime,
    setScheduleTime,
    scheduleTimezone,
    selectedAccountIds,
    submitting,
    recurringSchedules,
    rsEditingId,
    rsContent,
    setRsContent,
    rsSelectedAccountIds,
    rsDaysOfWeek,
    rsTimeOfDay,
    setRsTimeOfDay,
    rsTimezone,
    rsSubmitting,
    rsBusyId,
    mediaUrl,
    setMediaUrl,
    mediaUploading,
    mediaUploadProgress,
    mediaDragActive,
    setMediaDragActive,
    coverImageUrl,
    setCoverImageUrl,
    coverImageUploading,
    coverImageUploadProgress,
    pinterestBoards,
    boardsLoading,
    selectedBoardId,
    setSelectedBoardId,
    tiktokCreatorInfo,
    setMediaDuration,
    destinationLink,
    setDestinationLink,
    firstComment,
    setFirstComment,
    tiktokPrivacyLevel,
    setTiktokPrivacyLevel,
    tiktokAllowComment,
    setTiktokAllowComment,
    tiktokAllowDuet,
    setTiktokAllowDuet,
    tiktokAllowStitch,
    setTiktokAllowStitch,
    tiktokDiscloseCommercial,
    setTiktokDiscloseCommercial,
    tiktokBrandOrganic,
    setTiktokBrandOrganic,
    tiktokBrandContent,
    setTiktokBrandContent,
    tiktokConsentGiven,
    setTiktokConsentGiven,
    HISTORY_PAGE_SIZE,
    historyHasMore,
    setHistoryHasMore,
    historyLoadingMore,
    setHistoryLoadingMore,
    csvInputRef,
    csvRows,
    setCsvRows,
    bulkImporting,
    selectedPinterestAccountId,
    toggleSelectedAccount,
    toggleRsAccount,
    toggleRsDay,
    resetRsForm,
    startEditingRecurringSchedule,
    submitRecurringSchedule,
    handleTogglePauseResume,
    handleDeleteRecurringSchedule,
    handleGenerateCaption,
    handleGetContentIdeas,
    handleUseContentIdea,
    handleSuggestHashtags,
    tiktokCantPostReason,
    tiktokVideoTooLongText,
    tiktokPublishBlockedText,
    handleSaveDraft,
    handleEditDraft,
    handleCancelEditDraft,
    handleSchedule,
    handlePostNow,
    handleMediaFile,
    handleCoverImageFile,
    handleMediaDrop,
    handleApprove,
    handleReschedulePost,
    handlePostExistingNow,
    handleTogglePause,
    handleDuplicatePost,
    handleDelete,
    handleCsvFile,
    handleBulkImport,
    handleShareProof,
  } = useDashboard();

  return (
    <>
    <section>
      <h2>Schedule a one-time post</h2>
      {accounts.length === 0 ? (
        <p className="empty">
          Connect an account first.{" "}
          <button type="button" className="link-button" onClick={() => setTab("Social Platforms")}>
            Connect one now
          </button>
        </p>
      ) : (
        <form onSubmit={handleSchedule} className="schedule-form">
          <label>
            Post to
            <AccountPicker accounts={accounts} selectedIds={selectedAccountIds} onToggle={toggleSelectedAccount} />
            {selectedAccountIds.length > 0 && (
              <div className="best-time-hints">
                {[...new Set(selectedAccountIds.map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean))].map(
                  (platform) => {
                    const guidance = bestTimeFor(platform as string);
                    return (
                      <p key={platform} className="best-time-hint">
                        <PlatformIcon platform={platform as string} size={12} /> Best general time for {platform}:{" "}
                        <strong>{guidance.windows}</strong>: {guidance.note}
                      </p>
                    );
                  },
                )}
                <p className="best-time-disclaimer">General industry benchmark, not personalized to your account's own audience yet.</p>
              </div>
            )}
          </label>
          {selectedAccountIds.length > 1 && (
            <div className="per-platform-tailoring">
              <p className="section-note">
                Posting the same caption everywhere by default. Customize it for a specific platform below if you want
                different wording, length, or hashtags there.
              </p>
              {selectedAccountIds.map((id) => {
                const account = accounts.find((a) => a.id === id);
                if (!account) return null;
                const isCustomized = id in perAccountContent;
                return (
                  <div key={id} className="per-platform-row">
                    <label className="account-checkbox">
                      <input
                        type="checkbox"
                        checked={isCustomized}
                        onChange={(e) => {
                          if (e.target.checked) {
                            // Seed the override from the shared caption so
                            // customizing starts from what's already
                            // written, not a blank field.
                            setPerAccountContent((prev) => ({ ...prev, [id]: content }));
                          } else {
                            setPerAccountContent((prev) => {
                              const next = { ...prev };
                              delete next[id];
                              return next;
                            });
                          }
                        }}
                      />
                      <PlatformIcon platform={account.platform} size={14} />
                      Customize caption for {account.display_name ?? account.platform_account_id}
                    </label>
                    {isCustomized && (
                      <textarea
                        value={perAccountContent[id]}
                        onChange={(e) => setPerAccountContent((prev) => ({ ...prev, [id]: e.target.value }))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {selectedPinterestAccountId && (
            <label>
              Pinterest board
              {boardsLoading ? (
                <p className="muted">Loading your boards...</p>
              ) : pinterestBoards.length === 0 ? (
                <p className="muted">
                  No boards found yet. LazyRelay will create a default board the first time you post.
                </p>
              ) : (
                <select value={selectedBoardId ?? ""} onChange={(e) => setSelectedBoardId(e.target.value)}>
                  {pinterestBoards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}
          {selectedPinterestAccountId && (
            <label>
              Destination link (optional)
              <input
                type="text"
                value={destinationLink ?? ""}
                onChange={(e) => setDestinationLink(e.target.value)}
                placeholder="Where does this Pin take people when clicked?"
              />
              <span className="section-note">Pinterest-only — where a click on the Pin leads to, separate from the image itself.</span>
            </label>
          )}
          {selectedPinterestAccountId && (
            <p className="section-note">
              Pinterest: up to 10 pins a day per account. New account or new website? Start with 1 to 3 a day.
            </p>
          )}
          <div className="content-ideas-row">
            <button type="button" className="btn-outline" disabled={ideasGenerating} onClick={handleGetContentIdeas}>
              {ideasGenerating ? "Thinking..." : "Not sure what to post? Get ideas"}
            </button>
          </div>
          {contentIdeas && (
            <ul className="content-ideas-list">
              {contentIdeas.map((idea, i) => (
                <li key={i}>
                  <button type="button" onClick={() => handleUseContentIdea(idea)}>
                    {idea}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="ai-caption-row">
            <input
              type="text"
              placeholder={'What\'s this post about? (e.g. "new summer sale, 20% off")'}
              value={aiTopic}
              onChange={(e) => setAiTopic(e.target.value)}
            />
            <button type="button" className="btn-outline" disabled={aiGenerating} onClick={handleGenerateCaption}>
              {aiGenerating ? "Writing..." : "Generate with AI"}
            </button>
          </div>
          <label>
            Content
            <textarea value={content} onChange={(e) => setContent(e.target.value)} required />
          </label>
          <div className="hashtag-suggest-row">
            <button type="button" className="btn-outline" disabled={hashtagGenerating} onClick={handleSuggestHashtags}>
              {hashtagGenerating ? "Suggesting..." : "Suggest hashtags"}
            </button>
          </div>
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
                <span>Uploading... {mediaUploadProgress}%</span>
              ) : mediaUrl ? (
                <div className="media-preview">
                  {mediaUrl.match(/\.(mp4|mov)$/i) ? (
                    <video
                      src={mediaUrl}
                      muted
                      onLoadedMetadata={(e) => {
                        const sec = e.currentTarget.duration;
                        if (Number.isFinite(sec)) setMediaDuration({ url: mediaUrl, sec });
                      }}
                    />
                  ) : (
                    <img src={mediaUrl} alt="Attached media preview" />
                  )}
                  <button
                    type="button"
                    className="media-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMediaUrl(null);
                      setMediaAltText(null);
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
          {mediaUrl && !mediaUrl.match(/\.(mp4|mov)$/i) && (
            <label>
              Image description (alt text, optional)
              <input
                type="text"
                value={mediaAltText ?? ""}
                onChange={(e) => setMediaAltText(e.target.value)}
                placeholder="Describe the image for screen-reader users"
                maxLength={1000}
              />
              <span className="section-note">Used by platforms that support it (Mastodon and Bluesky today) — ignored elsewhere.</span>
            </label>
          )}
          {selectedAccountIds.length > 0 && (
            <div>
              <span className="field-label">Preview</span>
              <div className="social-preview-row">
                {Array.from(
                  new Set(
                    selectedAccountIds
                      .map((id) => accounts.find((a) => a.id === id)?.platform)
                      .filter((p): p is string => Boolean(p)),
                  ),
                ).map((platform) => {
                  const account = accounts.find((a) => selectedAccountIds.includes(a.id) && a.platform === platform);
                  if (!account) return null;
                  const displayName =
                    platform === "tiktok"
                      ? tiktokCreatorInfo?.nickname ?? account.display_name ?? account.platform_account_id
                      : account.display_name ?? account.platform_account_id;
                  return (
                    <SocialPostPreview
                      key={platform}
                      platform={platform}
                      displayName={displayName}
                      mediaUrl={mediaUrl}
                      caption={content}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {mediaUrl?.match(/\.(mp4|mov)$/i) &&
            (() => {
              const selectedPlatforms = selectedAccountIds.map((id) => accounts.find((a) => a.id === id)?.platform);
              const hasPinterest = selectedPlatforms.includes("pinterest");
              const hasYoutube = selectedPlatforms.includes("youtube");
              if (!hasPinterest && !hasYoutube) return null;
              // Pinterest requires this for video Pins; YouTube treats it as an
              // optional custom thumbnail (falls back to its own auto-generated
              // one if not set) -- same coverImageUrl field either way, adapters
              // that don't need it just ignore it.
              const label = hasPinterest
                ? "Cover image (required for Pinterest video Pins)"
                : "Custom thumbnail (optional — YouTube auto-generates one otherwise)";
              const placeholder = hasPinterest
                ? "Click to choose a cover image for your Pinterest video Pin"
                : "Click to choose a custom thumbnail for your YouTube video";
              return (
                <label>
                  {label}
                  <div
                    className="media-dropzone"
                    onClick={() => coverImageInputRef.current?.click()}
                  >
                    <input
                      ref={coverImageInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleCoverImageFile(file);
                        e.target.value = "";
                      }}
                    />
                    {coverImageUploading ? (
                      <span>Uploading... {coverImageUploadProgress}%</span>
                    ) : coverImageUrl ? (
                      <div className="media-preview">
                        <img src={coverImageUrl} alt="Cover image preview" />
                        <button
                          type="button"
                          className="media-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCoverImageUrl(null);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <span>{placeholder}</span>
                    )}
                  </div>
                </label>
              );
            })()}
          {selectedAccountIds.some((id) => {
            const platform = accounts.find((a) => a.id === id)?.platform;
            return platform === "facebook" || platform === "instagram";
          }) && (
            <label>
              First comment (optional)
              <input
                type="text"
                value={firstComment ?? ""}
                onChange={(e) => setFirstComment(e.target.value)}
                placeholder="Posted as the first comment right after this goes live"
              />
              <span className="section-note">Facebook and Instagram only for now, ignored on other platforms.</span>
            </label>
          )}
          {(() => {
            const tiktokAccount = accounts.find((a) => selectedAccountIds.includes(a.id) && a.platform === "tiktok");
            if (!tiktokAccount) return null;
            return (
              <div className="tiktok-post-settings">
                <div className="tiktok-post-heading">
                  <PlatformIcon platform="tiktok" size={16} />
                  Posting as{" "}
                  {tiktokCreatorInfo?.nickname ?? tiktokAccount.display_name ?? tiktokAccount.platform_account_id} on
                  TikTok
                </div>
                {tiktokCantPostReason && (
                  <span className="section-note" style={{ color: "var(--error)" }}>
                    {tiktokCantPostReason}
                  </span>
                )}
                {tiktokVideoTooLongText && (
                  <span className="section-note" style={{ color: "var(--error)" }}>
                    {tiktokVideoTooLongText}
                  </span>
                )}
                <span className="section-note">{TIKTOK_PROCESSING_NOTICE}</span>
                <span className="section-note">
                  <strong style={{ color: "var(--error)" }}>*</strong> required. Everything else below is optional and off by default.
                </span>
                <label>
                  Who can view this on TikTok <strong style={{ color: "var(--error)" }}>*</strong>
                  <select
                    value={tiktokPrivacyLevel ?? ""}
                    onChange={(e) => setTiktokPrivacyLevel(e.target.value || null)}
                    required
                  >
                    <option value="" disabled>
                      Choose who can see this post
                    </option>
                    {/* TikTok's own guidelines require these options to follow
                        privacy_level_options from the creator_info API rather than
                        a fixed list -- e.g. a private account never gets
                        PUBLIC_TO_EVERYONE, and gets FOLLOWER_OF_CREATOR instead.
                        Falls back to every documented value while creator info
                        hasn't loaded yet (or a lookup failed), matching this form's
                        existing fail-open pattern rather than blocking on it. */}
                    {(tiktokCreatorInfo?.privacyLevelOptions?.length
                      ? tiktokCreatorInfo.privacyLevelOptions
                      : Object.keys(TIKTOK_PRIVACY_LEVEL_LABELS)
                    ).map((level) => (
                      <option
                        key={level}
                        value={level}
                        disabled={level === "SELF_ONLY" && tiktokBrandContent}
                        title={level === "SELF_ONLY" && tiktokBrandContent ? "Branded content visibility cannot be set to private." : undefined}
                      >
                        {TIKTOK_PRIVACY_LEVEL_LABELS[level] ?? level}
                      </option>
                    ))}
                  </select>
                  {tiktokBrandContent && tiktokPrivacyLevel === "SELF_ONLY" && (
                    <span className="section-note">Branded content visibility cannot be set to private — choose a different option.</span>
                  )}
                </label>

                <span className="section-note">Optional — leave unchecked if none of these apply:</span>
                <label className="approval-checkbox-label">
                  <input type="checkbox" checked={tiktokAllowComment} onChange={(e) => setTiktokAllowComment(e.target.checked)} />
                  Allow comments
                </label>
                <label className="approval-checkbox-label">
                  <input type="checkbox" checked={tiktokAllowDuet} onChange={(e) => setTiktokAllowDuet(e.target.checked)} />
                  Allow duet
                </label>
                <label className="approval-checkbox-label">
                  <input type="checkbox" checked={tiktokAllowStitch} onChange={(e) => setTiktokAllowStitch(e.target.checked)} />
                  Allow stitch
                </label>
                <label className="approval-checkbox-label">
                  <input
                    type="checkbox"
                    checked={tiktokDiscloseCommercial}
                    onChange={(e) => {
                      setTiktokDiscloseCommercial(e.target.checked);
                      if (!e.target.checked) {
                        setTiktokBrandOrganic(false);
                        setTiktokBrandContent(false);
                      }
                    }}
                  />
                  Disclose commercial content
                </label>
                {tiktokDiscloseCommercial && (
                  <>
                    <label className="approval-checkbox-label">
                      <input type="checkbox" checked={tiktokBrandOrganic} onChange={(e) => setTiktokBrandOrganic(e.target.checked)} />
                      Your Brand — promoting yourself or your own business
                    </label>
                    <label
                      className="approval-checkbox-label"
                      title={tiktokPrivacyLevel === "SELF_ONLY" ? "Branded content visibility cannot be set to private." : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={tiktokBrandContent}
                        disabled={tiktokPrivacyLevel === "SELF_ONLY"}
                        onChange={(e) => setTiktokBrandContent(e.target.checked)}
                      />
                      Branded Content — promoting another brand or a third party
                    </label>
                    {tiktokBrandOrganic && !tiktokBrandContent && (
                      <span className="section-note">Your photo/video will be labeled as "Promotional content".</span>
                    )}
                    {tiktokBrandContent && (
                      <span className="section-note">Your photo/video will be labeled as "Paid partnership".</span>
                    )}
                  </>
                )}

                <label className="approval-checkbox-label tiktok-consent-required">
                  <input
                    type="checkbox"
                    checked={tiktokConsentGiven}
                    onChange={(e) => setTiktokConsentGiven(e.target.checked)}
                  />
                  <strong>
                    <span style={{ color: "var(--error)" }}>*</span> By posting, you agree to TikTok's{tiktokBrandContent ? " Branded Content Policy and" : ""} Music Usage Confirmation.
                  </strong>
                </label>
              </div>
            );
          })()}
          <label>
            When to post
            <DateTimePicker
              date={scheduleDate}
              time={scheduleTime}
              timezoneLabel={scheduleTimezone}
              onApply={(d, t) => {
                setScheduleDate(d);
                setScheduleTime(t);
              }}
            />
          </label>
          <label className="approval-checkbox-label">
            <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
            Require approval before this goes out
          </label>
          {editingDraftId && (
            <p className="section-note">
              Editing a draft. Save it as a draft again, or pick accounts + a time above and Schedule/Post Now to
              turn it into a real post.{" "}
              <button type="button" className="btn-outline" onClick={handleCancelEditDraft}>
                Cancel edit
              </button>
            </p>
          )}
          <div className="schedule-form-actions">
            <span title={tiktokPublishBlockedText ?? undefined}>
              <button type="submit" disabled={submitting || tiktokPublishBlockedText !== null}>
                {submitting ? "Scheduling..." : "Schedule"}
              </button>
            </span>
            <span title={tiktokPublishBlockedText ?? undefined}>
              <button
                type="button"
                className="post-now-btn"
                disabled={submitting || tiktokPublishBlockedText !== null}
                onClick={handlePostNow}
              >
                {submitting ? "Posting..." : "Post Now"}
              </button>
            </span>
            <button type="button" className="btn-outline" disabled={draftBusy || submitting} onClick={handleSaveDraft}>
              {draftBusy ? "Saving..." : editingDraftId ? "Update draft" : "Save as draft"}
            </button>
          </div>
          {tiktokPublishBlockedText && <p className="section-note">{tiktokPublishBlockedText}</p>}
        </form>
      )}
    </section>

    <section>
      <h2>Bulk import (CSV)</h2>
      <p className="muted">
        Columns: <code>platform</code>, <code>content</code>, <code>scheduled_for</code> (ISO date/time), <code>media_url</code>{" "}
        (optional). <code>platform</code> is matched against your connected accounts. If you have more than one account on the
        same platform, the first one connected is used.
      </p>
      <div className="bulk-import-controls">
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleCsvFile(file);
            e.target.value = "";
          }}
        />
        {csvRows.length > 0 && (
          <button type="button" className="btn-outline" onClick={() => setCsvRows([])}>
            Clear
          </button>
        )}
      </div>

      {csvRows.length > 0 && (
        <>
          <div className="table-scroll">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Platform</th>
                <th>Content</th>
                <th>Scheduled for</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {csvRows.map((row, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{row.platform}</td>
                  <td>{row.content.length > 60 ? `${row.content.slice(0, 60)}…` : row.content}</td>
                  <td>{row.scheduledFor}</td>
                  <td className={row.error ? "csv-row-error" : "csv-row-ok"}>{row.error ?? "Ready"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="schedule-form-actions">
            <button type="button" disabled={bulkImporting || csvRows.every((r) => r.error)} onClick={handleBulkImport}>
              {bulkImporting ? "Importing..." : `Import ${csvRows.filter((r) => !r.error).length} post${csvRows.filter((r) => !r.error).length === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      )}
    </section>

    <section>
      <h2>Recurring schedules</h2>
      <p className="muted">
        Set up a weekly content cadence once. LazyRelay keeps posting it to your chosen platforms every week until you pause or delete it.
      </p>
      {accounts.length === 0 ? (
        <p className="empty">
          Connect an account first.{" "}
          <button type="button" className="link-button" onClick={() => setTab("Social Platforms")}>
            Connect one now
          </button>
        </p>
      ) : (
        <form onSubmit={submitRecurringSchedule} className="schedule-form">
          <label>
            Post to
            <AccountPicker accounts={accounts} selectedIds={rsSelectedAccountIds} onToggle={toggleRsAccount} />
          </label>
          <label>
            Content
            <textarea value={rsContent} onChange={(e) => setRsContent(e.target.value)} required />
          </label>
          <label>
            Days of the week
            <DayOfWeekPicker selected={rsDaysOfWeek} onToggle={toggleRsDay} />
          </label>
          <TimeOfDayPicker time={rsTimeOfDay} onChange={setRsTimeOfDay} timezoneLabel={rsTimezone} />
          <div className="schedule-form-actions">
            <button type="submit" disabled={rsSubmitting}>
              {rsSubmitting ? "Saving..." : rsEditingId ? "Save changes" : "Create recurring schedule"}
            </button>
            {rsEditingId && (
              <button type="button" className="btn-outline" onClick={resetRsForm}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
      )}

      {recurringSchedules.length === 0 ? (
        <p className="empty">No recurring schedules yet.</p>
      ) : (
        <ul className="post-list">
          {recurringSchedules.map((s) => {
            const dayLabels = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
            const days = s.days_of_week.map((d) => dayLabels[d]).join(", ");
            return (
              <li key={s.id} className={`post-status-${s.status === "active" ? "pending" : "failed"}`}>
                <div className="post-platform">
                  {s.social_account_ids.map((id) => {
                    const account = accounts.find((a) => a.id === id);
                    return account ? <PlatformIcon key={id} platform={account.platform} size={14} /> : null;
                  })}
                </div>
                <div className="post-content">{s.content}</div>
                <div className="post-meta">
                  <span className={`status-badge status-${s.status === "active" ? "pending" : "failed"}`}>
                    {s.status === "active" ? "Active" : "Paused"}
                  </span>
                  <span>
                    {days} at {s.time_of_day.slice(0, 5)} ({s.timezone})
                  </span>
                  <button className="btn-outline" disabled={rsBusyId === s.id} onClick={() => handleTogglePauseResume(s)}>
                    {s.status === "active" ? "Pause" : "Resume"}
                  </button>
                  <button className="btn-outline" disabled={rsBusyId === s.id} onClick={() => startEditingRecurringSchedule(s)}>
                    Edit
                  </button>
                  <button className="btn-outline" disabled={rsBusyId === s.id} onClick={() => handleDeleteRecurringSchedule(s.id)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>

    {(() => {
      const brandFiltered = posts.filter((p) => accountMatchesBrand(accounts.find((a) => a.id === p.social_account_id), brandFilter));
      const upcoming = brandFiltered.filter((p) => p.status === "pending" || p.status === "posting" || p.status === "needs_approval" || p.status === "draft");
      // Drafts have no scheduled_for (nullable, migration 0049) and must
      // never land in History — explicit posted/failed match (not a
      // negative "isn't pending/posting/needs_approval" filter, which
      // would silently catch drafts too) plus a type predicate narrows
      // scheduled_for to non-null for every use below.
      const history = brandFiltered
        .filter((p): p is ScheduledPost & { scheduled_for: string } => (p.status === "posted" || p.status === "failed") && p.scheduled_for !== null)
        .slice()
        .sort((a, b) => new Date(b.scheduled_for).getTime() - new Date(a.scheduled_for).getTime());

      // Fetches an additional real page from the backend (see
      // GET /scheduled-posts/history) rather than slicing an
      // already-fully-loaded array — `posts` only ever holds what's been
      // explicitly fetched, so this is the only way to see anything
      // beyond the initial page.
      async function handleLoadMoreHistory() {
        const oldest = history[history.length - 1];
        if (!oldest) return;
        setHistoryLoadingMore(true);
        try {
          const more = await api.loadMoreHistory(oldest.scheduled_for);
          setPosts((prev) => [...prev, ...more]);
          setHistoryHasMore(more.length === HISTORY_PAGE_SIZE);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setHistoryLoadingMore(false);
        }
      }

      const renderPost = (p: ScheduledPost) => {
        const result = p.post_results?.[0];
        const account = accounts.find((a) => a.id === p.social_account_id);
        return (
          <li key={p.id} className={`post-status-${p.status}`}>
            {account && (
              <div className="post-platform">
                <PlatformIcon platform={account.platform} size={14} />
                {account.display_name ?? account.platform_account_id}
              </div>
            )}
            <div className="post-content">{p.content}</div>
            <div className="post-meta">
              <span className={`status-badge status-${p.status}`}>
                {p.status === "needs_approval" ? "Needs approval" : p.status}
              </span>
              {/* A draft has no scheduled_for yet (nullable, migration 0049) —
                  show nothing rather than a bogus epoch date. */}
              {p.status !== "draft" && p.scheduled_for && <span>{new Date(p.scheduled_for).toLocaleString()}</span>}
              {p.status === "draft" && (
                <button className="btn-outline" onClick={() => handleEditDraft(p)}>
                  Edit
                </button>
              )}
              {result && (
                result.verified_live ? (
                  <span className="verified">
                    <RelaySignal size={14} pulsing /> Confirmed live
                  </span>
                ) : (
                  <PostErrorDetail errorMessage={result.error_message} platform={account?.platform} />
                )
              )}
              {result?.verified_live && (
                <button className="btn-outline" disabled={sharingProofId === p.id} onClick={() => handleShareProof(p.id)}>
                  {sharingProofId === p.id ? "..." : "Share proof"}
                </button>
              )}
              {shareProofResult?.postId === p.id && (
                <span className="section-note">
                  {shareProofResult.copied ? "Link copied: " : "Couldn't auto-copy, here's the link: "}
                  <a href={shareProofResult.url} target="_blank" rel="noopener noreferrer">
                    {shareProofResult.url}
                  </a>
                </span>
              )}
              {p.status === "needs_approval" && (
                <button
                  className="btn-outline"
                  disabled={approvingId === p.id}
                  onClick={() => handleApprove(p.id)}
                >
                  {approvingId === p.id ? "Approving..." : "Approve"}
                </button>
              )}
              {p.status === "pending" && (
                <>
                  <button className="btn-outline" disabled={reschedulingId === p.id} onClick={() => handleReschedulePost(p.id)}>
                    {reschedulingId === p.id ? "..." : "Move"}
                  </button>
                  {!p.paused_at && (
                    <button className="btn-outline" disabled={reschedulingId === p.id} onClick={() => handlePostExistingNow(p.id)}>
                      Post now
                    </button>
                  )}
                  <button className="btn-outline" disabled={pauseResumeId === p.id} onClick={() => handleTogglePause(p.id, Boolean(p.paused_at))}>
                    {pauseResumeId === p.id ? "..." : p.paused_at ? "Resume" : "Pause"}
                  </button>
                  <button className="btn-outline" disabled={duplicatingId === p.id} onClick={() => handleDuplicatePost(p.id)}>
                    {duplicatingId === p.id ? "..." : "Duplicate"}
                  </button>
                </>
              )}
              {p.status !== "posting" && (
                <button className="btn-outline" onClick={() => handleDelete(p.id, p.status !== "pending" && p.status !== "needs_approval")}>
                  {p.status === "pending" || p.status === "needs_approval" ? "Cancel" : "Delete"}
                </button>
              )}
            </div>
          </li>
        );
      };

      return (
        <>
          <section>
            <h2>Upcoming</h2>
            <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
            {upcoming.length === 0 ? (
              <p className="empty">Nothing scheduled yet.</p>
            ) : (
              // Grouped by local calendar date into collapsible sections,
              // same pattern as History below — a flat list got
              // unmanageably long once an account had more than a
              // handful of upcoming posts (Werner flagged this directly,
              // 2026-09-04, after a real bulk-scheduling batch). Soonest
              // date opens expanded, everything further out starts
              // collapsed.
              (() => {
                // needs_approval posts promoted from an undated plan can
                // still have no scheduled_for — grouped under their own
                // key rather than crashing localDateKey on null, sorted
                // to the very front since "no time picked yet" needs
                // attention before anything already scheduled.
                const NO_DATE_KEY = "no-date";
                const groups = new Map<string, ScheduledPost[]>();
                for (const p of upcoming) {
                  const key = p.scheduled_for ? localDateKey(p.scheduled_for) : NO_DATE_KEY;
                  (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
                }
                const sortedKeys = [...groups.keys()].sort((a, b) => {
                  if (a === NO_DATE_KEY) return -1;
                  if (b === NO_DATE_KEY) return 1;
                  return a.localeCompare(b);
                });
                return sortedKeys.map((key, i) => {
                  const groupPosts = groups.get(key)!;
                  const label =
                    key === NO_DATE_KEY
                      ? "No time picked yet"
                      : new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
                          weekday: "long",
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                        });
                  return (
                    <details key={key} className="post-date-group" open={i === 0}>
                      <summary>
                        <span className="post-date-group-label">
                          <span className="post-date-group-chevron" aria-hidden="true" />
                          {label}
                        </span>
                        <span className="post-date-group-count">
                          {groupPosts.length} post{groupPosts.length === 1 ? "" : "s"}
                        </span>
                      </summary>
                      <ul className="post-list">{groupPosts.map(renderPost)}</ul>
                    </details>
                  );
                });
              })()
            )}
          </section>

          <section>
            <h2>History</h2>
            {history.length === 0 ? (
              <p className="empty">No posts sent yet.</p>
            ) : (
              <>
                {(() => {
                  // Grouped by local calendar date into collapsible
                  // sections — a flat list got unmanageably long once a
                  // customer had more than a handful of posts (Werner
                  // flagged this directly, 2026-08-07). Most recent date
                  // opens expanded, everything older starts collapsed.
                  const groups = new Map<string, ScheduledPost[]>();
                  for (const p of history) {
                    const key = localDateKey(p.scheduled_for);
                    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
                  }
                  const sortedKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));
                  return sortedKeys.map((key, i) => {
                    const posts = groups.get(key)!;
                    const label = new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    });
                    return (
                      <details key={key} className="post-date-group" open={i === 0}>
                        <summary>
                          <span className="post-date-group-label">
                            <span className="post-date-group-chevron" aria-hidden="true" />
                            {label}
                          </span>
                          <span className="post-date-group-count">
                            {posts.length} post{posts.length === 1 ? "" : "s"}
                          </span>
                        </summary>
                        <ul className="post-list">{posts.map(renderPost)}</ul>
                      </details>
                    );
                  });
                })()}
                {historyHasMore && (
                  <button className="btn-outline" disabled={historyLoadingMore} onClick={handleLoadMoreHistory}>
                    {historyLoadingMore ? "Loading..." : "Load more"}
                  </button>
                )}
              </>
            )}
          </section>
        </>
      );
    })()}
    </>
  );
}
