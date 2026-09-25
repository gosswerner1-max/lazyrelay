// All of the Dashboard's state, effects and handlers — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). Dashboard.tsx calls this hook exactly once, so every hook
// here runs in the same component, in the same order, as before the split.


import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { useAuth } from "../../context/AuthContext";
import { supabase } from "../../lib/supabase";
import type { OAuthGrant } from "@supabase/supabase-js";
import { api, type SocialAccount, type Brand, type BrandCapacity, type ScheduledPost, type Subscription, type StorageUsage, type MediaFile, type StorageAddon, type PlatformInfo, type Account, type ApiKey, type RecurringSchedule, type AnalyticsSummary, type BioPage, type MentionPost, type DMConversation, type DMMessage, type DMAutomation, type TeamMember, type SeatCapacity } from "../../lib/api";
import { isTiktokDisclosureIncomplete } from "../../lib/tiktokDisclosure";
import { isVideoTooLongForTiktok, tiktokVideoTooLongMessage, type TiktokCreatorInfo } from "../../lib/tiktokPostChecks";
import { type Tab, TOUR_SEEN_KEY, GCAL_PROMPT_SEEN_KEY, useIsMobile, connectParams, parseCsv } from "./dashboardHelpers";

export function useDashboardState() {
  const { signOut, session } = useAuth();
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const coverImageInputRef = useRef<HTMLInputElement>(null);
  // refresh() re-fetches the account on every call (including after
  // unrelated actions like scheduling a post) — only seed the business-name
  // input from the server once, so it never clobbers text the user is
  // actively typing into the Settings field.
  const businessNameSeeded = useRef(false);
  const voiceProfileSeeded = useRef(false);
  const webhookUrlSeeded = useRef(false);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [mediaBusyId, setMediaBusyId] = useState<string | null>(null);
  const [disconnectingAccountId, setDisconnectingAccountId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<{
    token: string;
    platform: string;
    options: { id: string; name: string }[];
  } | null>(null);
  const [checkedOptionIds, setCheckedOptionIds] = useState<string[]>([]);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [storageAddons, setStorageAddons] = useState<StorageAddon[]>([]);
  const [addonBusy, setAddonBusy] = useState<5 | 20 | 50 | string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [businessNameInput, setBusinessNameInput] = useState("");
  const [savingBusinessName, setSavingBusinessName] = useState(false);
  const [voiceProfileInput, setVoiceProfileInput] = useState("");
  const [savingVoiceProfile, setSavingVoiceProfile] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeyCanShareProof, setApiKeyCanShareProof] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [showRevokedKeys, setShowRevokedKeys] = useState(false);
  const [oauthGrants, setOauthGrants] = useState<OAuthGrant[]>([]);
  const [oauthGrantsLoading, setOauthGrantsLoading] = useState(true);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamInviteEmail, setTeamInviteEmail] = useState("");
  const [invitingTeamMember, setInvitingTeamMember] = useState(false);
  const [removingTeamMemberId, setRemovingTeamMemberId] = useState<string | null>(null);
  const [resendingTeamInviteId, setResendingTeamInviteId] = useState<string | null>(null);
  const [revokingGrantClientId, setRevokingGrantClientId] = useState<string | null>(null);
  const [announcingAdmin, setAnnouncingAdmin] = useState(false);
  const [adminWindowExpiresAt, setAdminWindowExpiresAt] = useState<string | null>(null);
  const [savingFailureAlerts, setSavingFailureAlerts] = useState(false);
  const [webhookUrlInput, setWebhookUrlInput] = useState("");
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [regeneratingWebhookSecret, setRegeneratingWebhookSecret] = useState(false);
  const [revealedWebhookSecret, setRevealedWebhookSecret] = useState<string | null>(null);
  // undefined = not yet checked, null = checked and not connected, object =
  // connected. Same lazy-load sentinel pattern as mfaFactorId below.
  const [gcalStatus, setGcalStatus] = useState<
    { google_calendar_id?: string; connected_email?: string | null; last_synced_at?: string | null } | null | undefined
  >(undefined);
  const [gcalConnecting, setGcalConnecting] = useState(false);
  const [gcalDisconnecting, setGcalDisconnecting] = useState(false);
  // Same undefined/null/object sentinel pattern as gcalStatus above, for
  // the independent Google Sheets connection.
  const [gsheetStatus, setGsheetStatus] = useState<
    { spreadsheet_id?: string; connected_email?: string | null; last_synced_at?: string | null } | null | undefined
  >(undefined);
  const [gsheetConnecting, setGsheetConnecting] = useState(false);
  const [gsheetDisconnecting, setGsheetDisconnecting] = useState(false);
  // undefined = not yet checked (listFactors() hasn't resolved), null = checked
  // and no verified TOTP factor exists, string = the verified factor's id.
  // Mirrors the undefined/null-as-sentinel lazy-load pattern used for
  // mentions/dmConversations/bioPage below (tab-gated effect, fetch once).
  const [mfaFactorId, setMfaFactorId] = useState<string | null | undefined>(undefined);
  const [mfaEnrolling, setMfaEnrolling] = useState(false);
  const [mfaEnrollment, setMfaEnrollment] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [mfaVerifyCode, setMfaVerifyCode] = useState("");
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [mfaVerified, setMfaVerified] = useState(false);
  const [mfaUnenrolling, setMfaUnenrolling] = useState(false);
  // Recovery codes (2026-08-26) -- reveal-once, same as newlyCreatedKey /
  // revealedWebhookSecret above. Populated right after a successful
  // enrollment (auto-generated) or an explicit "Regenerate" click; never
  // fetched back from the server, since the backend never stores plaintext.
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[] | null>(null);
  const [mfaGeneratingRecoveryCodes, setMfaGeneratingRecoveryCodes] = useState(false);
  const [sharingProofId, setSharingProofId] = useState<string | null>(null);
  const [shareProofResult, setShareProofResult] = useState<{ postId: string; url: string; copied: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [runTour, setRunTour] = useState(false);
  const [showGcalPrompt, setShowGcalPrompt] = useState(false);
  const [brandFilter, setBrandFilter] = useState("");
  const [brands, setBrands] = useState<Brand[]>([]);
  const [newBrandName, setNewBrandName] = useState("");
  const [brandBusy, setBrandBusy] = useState(false);
  // Per-brand voice override drafts, same pattern as mediaAltTextDrafts —
  // keyed by brand id so editing one brand's voice never touches another's.
  const [brandVoiceDrafts, setBrandVoiceDrafts] = useState<Record<string, string>>({});
  const [brandVoiceBusyId, setBrandVoiceBusyId] = useState<string | null>(null);
  const [assigningAccountId, setAssigningAccountId] = useState<string | null>(null);
  // Phase 1b (2026-08-16) — real effective brand capacity (base tier limit +
  // purchased add-on slots) and the add-ons themselves, from GET /brand-addons.
  const [brandCapacity, setBrandCapacity] = useState<BrandCapacity | null>(null);
  const [seatCapacity, setSeatCapacity] = useState<SeatCapacity | null>(null);
  const [brandAddonBusy, setBrandAddonBusy] = useState<"checkout" | string | null>(null);
  const pendingBrandAddonRef = useRef(false);
  const [seatAddonBusy, setSeatAddonBusy] = useState<"checkout" | string | null>(null);
  const pendingSeatAddonRef = useRef(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [billingBusy, setBillingBusy] = useState<"pro" | "business" | "enterprise" | "agency" | "agency_plus" | "cancel" | null>(null);
  // The Billing section's own 3-card grid, plus the "See Agency plans"
  // reveal below it — mirrors Landing.tsx's AGENCY_PRICING pattern exactly
  // (same reasoning: 5 cards in one row doesn't fit, and agencies are a
  // smaller audience than the main 3 tiers). The backend/API layer already
  // fully supported "agency"/"agency_plus" (startCheckout, /subscription
  // /checkout, the Paddle price IDs) — only this dashboard UI was missing
  // a way to actually reach them, despite the marketing copy already
  // promising "upgrade to ... Agency, or Agency Plus any time from your
  // dashboard" (found live 2026-08-21).
  const [showAgencyBilling, setShowAgencyBilling] = useState(false);
  // Confirmation gate for handleChangeTier -- an already-paying customer's
  // "Switch to X" charges/credits the prorated difference immediately, no
  // Paddle checkout overlay in between to double as a natural confirm step
  // the way a fresh subscription's "Upgrade to X" already has. Added
  // 2026-08-21 after Werner flagged live that an accidental click would
  // otherwise change the plan with zero confirmation.
  const [pendingTierChange, setPendingTierChange] = useState<{
    tier: "pro" | "business" | "enterprise" | "agency" | "agency_plus";
    displayName: string;
  } | null>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelFeedback, setCancelFeedback] = useState("");
  const [cancelDataDeletionAck, setCancelDataDeletionAck] = useState(false);

  const [content, setContent] = useState("");
  const [aiTopic, setAiTopic] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);
  // Drafts (2026-08-16) — set while the compose form is editing an existing
  // draft rather than starting a fresh post; submitPost/handleSaveDraft both
  // branch on it. Cleared on save/schedule/cancel-edit.
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  // Alt text (2026-08-16) — accessibility description for the attached
  // media; only reaches the platform on adapters that support it
  // (Mastodon today), harmless to set regardless.
  const [mediaAltText, setMediaAltText] = useState<string | null>(null);
  // Per-file alt-text edits in the media library (Storage tab) — same
  // draft-until-Save pattern the brand-label input used before it became a
  // real picker; a file's own alt text is edited independently of whatever
  // was typed for it at compose time.
  const [mediaAltTextDrafts, setMediaAltTextDrafts] = useState<Record<string, string>>({});
  // Per-platform tailoring (2026-08-16) — when posting to several accounts
  // at once, an entry here overrides the shared `content` for that specific
  // account. An account with no entry uses the shared content, same as
  // before this feature existed — nothing changes for the common
  // one-caption-fits-all case.
  const [perAccountContent, setPerAccountContent] = useState<Record<string, string>>({});
  const [approvingId, setApprovingId] = useState<string | null>(null);
  // Move/post-now/pause/resume/duplicate (2026-08-30) — covers both "move to
  // another day" and "post now" since both call the same reschedule
  // endpoint (backend already treats scheduledFor=now as legitimate).
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [pauseResumeId, setPauseResumeId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [hashtagGenerating, setHashtagGenerating] = useState(false);
  const [ideasGenerating, setIdeasGenerating] = useState(false);
  const [contentIdeas, setContentIdeas] = useState<string[] | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [recurringSchedules, setRecurringSchedules] = useState<RecurringSchedule[]>([]);
  const [rsEditingId, setRsEditingId] = useState<string | null>(null);
  const [rsContent, setRsContent] = useState("");
  const [rsSelectedAccountIds, setRsSelectedAccountIds] = useState<string[]>([]);
  const [rsDaysOfWeek, setRsDaysOfWeek] = useState<number[]>([]);
  const [rsTimeOfDay, setRsTimeOfDay] = useState("09:00");
  const [rsTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [rsSubmitting, setRsSubmitting] = useState(false);
  const [rsBusyId, setRsBusyId] = useState<string | null>(null);
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  // Guidance dialog shown before every Pinterest connect (see
  // PinterestConnectModal.tsx) -- not persisted, appears on each press.
  const [showPinterestConnectModal, setShowPinterestConnectModal] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaUploadProgress, setMediaUploadProgress] = useState(0);
  const [mediaDragActive, setMediaDragActive] = useState(false);
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(null);
  const [coverImageUploading, setCoverImageUploading] = useState(false);
  const [coverImageUploadProgress, setCoverImageUploadProgress] = useState(0);
  const [pinterestBoards, setPinterestBoards] = useState<{ id: string; name: string }[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  // TikTok creator info (nickname, max video length, can-post-right-now) for
  // the selected TikTok account, and the attached video's length as read by
  // the browser from the media preview -- remembered together with the file
  // it belongs to, so a replaced or removed file never reuses an old length.
  const [tiktokCreatorInfo, setTiktokCreatorInfo] = useState<TiktokCreatorInfo | null>(null);
  const [mediaDuration, setMediaDuration] = useState<{ url: string; sec: number } | null>(null);
  // Pinterest's own "Destination Link" -- where a click on the Pin takes
  // someone, distinct from the image/video itself. Found completely missing
  // in a 2026-08-19 security review: the compose form never had a field for
  // it at all, so every Pin's destination link was silently blank.
  const [destinationLink, setDestinationLink] = useState<string | null>(null);
  const [firstComment, setFirstComment] = useState<string | null>(null);
  // TikTok's own Content Sharing Guidelines require this app's UI to show a
  // real privacy choice with no default selection, and interaction toggles
  // unchecked by default -- found missing entirely 2026-09-05 while applying
  // for the Content Posting API's audited status. null privacyLevel means
  // "customer hasn't chosen yet"; the backend rejects a TikTok post without
  // one rather than silently defaulting it (see postCreation.ts).
  const [tiktokPrivacyLevel, setTiktokPrivacyLevel] = useState<string | null>(null);
  const [tiktokAllowComment, setTiktokAllowComment] = useState(false);
  const [tiktokAllowDuet, setTiktokAllowDuet] = useState(false);
  const [tiktokAllowStitch, setTiktokAllowStitch] = useState(false);
  // TikTok's Content Sharing Guidelines require a commercial-content
  // disclosure control -- off by default, found missing entirely 2026-09-05
  // alongside the privacy/interaction fields above, same audit application.
  // discloseCommercial is UI-only (no matching column): it just gates
  // whether the Your Brand/Branded Content checkboxes show at all. The two
  // checkboxes are what actually get sent to TikTok (brand_organic_toggle /
  // brand_content_toggle) -- see PostRequest.tiktokBrandOrganic and
  // migration 0084.
  const [tiktokDiscloseCommercial, setTiktokDiscloseCommercial] = useState(false);
  const [tiktokBrandOrganic, setTiktokBrandOrganic] = useState(false);
  const [tiktokBrandContent, setTiktokBrandContent] = useState(false);
  // TikTok's Content Sharing Guidelines: "there should be a declaration
  // asking for a user's consent before the publish button" -- found
  // 2026-09-05 that this needs to be an actual required checkbox, not just
  // disclosure text, since the guideline is asking for consent, not merely
  // stating a fact. Gates Schedule/Post Now (not draft-saving, since nothing
  // is actually published yet); never sent to the backend, purely a
  // client-side gate matching the guideline's UX requirement.
  const [tiktokConsentGiven, setTiktokConsentGiven] = useState(false);
  // The initial /scheduled-posts fetch already caps History at the
  // backend's page size (see routes.ts) — this just tracks whether a
  // fetched page came back full (there's probably more to load) so the
  // button can hide itself once a page returns short.
  const HISTORY_PAGE_SIZE = 50;
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [paddle, setPaddle] = useState<Paddle | undefined>(undefined);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvRows, setCsvRows] = useState<
    Array<{ platform: string; content: string; scheduledFor: string; mediaUrl: string; socialAccountId: string | null; error: string | null }>
  >([]);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // The plan-banner "Upgrade" button only ever switched to the Settings
  // tab — the Billing section lives further down that page, below Storage
  // and Account, so a customer landed at the top and had no visible plan
  // cards to click (found live 2026-08-21). Same scroll-into-view fix and
  // same "auto" not "smooth" reasoning as the calendar day-detail panel
  // above.
  const billingSectionRef = useRef<HTMLDivElement>(null);
  const [scrollToBillingPending, setScrollToBillingPending] = useState(false);
  useEffect(() => {
    if (tab === "Settings" && scrollToBillingPending && billingSectionRef.current) {
      billingSectionRef.current.scrollIntoView({ behavior: "auto", block: "start" });
      setScrollToBillingPending(false);
    }
  }, [tab, scrollToBillingPending]);
  // First-time product tour (2026-08-27) — fires once real data has
  // loaded, not on the loading skeleton, so its steps have something real
  // to point at. localStorage rather than a backend field: this is a
  // client-only convenience, not something that needs to sync across
  // devices or survive the user clearing site data.
  useEffect(() => {
    if (!loading && !localStorage.getItem(TOUR_SEEN_KEY)) {
      setRunTour(true);
    }
  }, [loading]);
  const handleTourFinish = () => {
    setRunTour(false);
    localStorage.setItem(TOUR_SEEN_KEY, "1");
  };
  // First-run "connect Google Calendar?" prompt (2026-08-30) — waits for
  // the tour to be out of the way (either finished or already seen before)
  // so the two first-run UIs never compete for attention, and only shows
  // once gcalStatus has actually resolved to "not connected" (undefined
  // means still loading, not "no").
  useEffect(() => {
    if (loading || runTour) return;
    if (gcalStatus !== null) return;
    if (localStorage.getItem(GCAL_PROMPT_SEEN_KEY)) return;
    setShowGcalPrompt(true);
  }, [loading, runTour, gcalStatus]);
  function dismissGcalPrompt() {
    setShowGcalPrompt(false);
    localStorage.setItem(GCAL_PROMPT_SEEN_KEY, "1");
  }
  // "Compact view" (the week-row list) vs "Calendar view" (a time-block
  // week grid, hour rows only where something's scheduled) — Werner's own
  // reference, a competitor's toggle of the same name. Calendar view
  // navigates by week, not month, so it gets its own anchor date rather
  // than reusing calendarMonth.
  const [calendarViewMode, setCalendarViewMode] = useState<"compact" | "calendar">("compact");
  const [calendarWeekStart, setCalendarWeekStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  });
  // Called unconditionally here (not inside the `tab === "Calendar"` block
  // below) — that block is a conditional IIFE, and a hook called inside it
  // would only run some renders, breaking React's rules of hooks.
  const isMobile = useIsMobile();
  // Calendar redesign (2026-08-30) — replaces the old below-grid
  // .calendar-day-detail panel with two anchored popovers. dayPopoverAnchor
  // holds the clicked element's rect (day cell, mini-month day, or "+
  // Create" -> Idea) so the popover renders next to whatever was actually
  // clicked; selectedDay (already existed) still drives which day's
  // content it shows.
  const [dayPopoverAnchor, setDayPopoverAnchor] = useState<DOMRect | null>(null);
  const [eventPopover, setEventPopover] = useState<{ post: ScheduledPost; anchor: DOMRect } | null>(null);
  const [eventPopoverPanel, setEventPopoverPanel] = useState<null | "menu" | "move" | "duplicate">(null);
  const [calendarSearch, setCalendarSearch] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  // Clicking the "Connected as [email]" indicator in the Calendar sidebar
  // (2026-08-30, Werner's idea) narrows the grid to posts that actually
  // reached that Google Calendar (google_event_id set) rather than every
  // post regardless of sync state.
  const [syncedOnlyFilter, setSyncedOnlyFilter] = useState(false);

  function openDayPopover(key: string, el: HTMLElement) {
    const anchor = el.getBoundingClientRect();
    if (key === selectedDay && dayPopoverAnchor) {
      setSelectedDay(null);
      setDayPopoverAnchor(null);
      return;
    }
    setSelectedDay(key);
    setDayPopoverAnchor(anchor);
    setEventPopover(null);
  }

  function openEventPopover(post: ScheduledPost, el: HTMLElement) {
    setEventPopover({ post, anchor: el.getBoundingClientRect() });
    setEventPopoverPanel(null);
    setSelectedDay(null);
    setDayPopoverAnchor(null);
  }

  function closeEventPopover() {
    setEventPopover(null);
    setEventPopoverPanel(null);
  }

  function isoFromDateTime(date: string, time: string): string {
    return new Date(`${date}T${time}`).toISOString();
  }

  async function handleReschedulePostTo(id: string, date: string, time: string) {
    setReschedulingId(id);
    setError(null);
    try {
      await api.rescheduleScheduledPost(id, isoFromDateTime(date, time));
      await refresh();
      closeEventPopover();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReschedulingId(null);
    }
  }

  async function handleDuplicatePostTo(id: string, date: string, time: string) {
    setDuplicatingId(id);
    setError(null);
    try {
      await api.duplicateScheduledPost(id, isoFromDateTime(date, time));
      await refresh();
      closeEventPopover();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDuplicatingId(null);
    }
  }

  // eventPopover holds a snapshot of the clicked post, not a live reference
  // into `posts` — so a pause/resume/post-now action that refreshes `posts`
  // in place (popover stays open, only Move/Duplicate close it) would
  // otherwise leave the popover showing stale status/paused_at. This keeps
  // it in sync whenever `posts` changes.
  useEffect(() => {
    if (!eventPopover) return;
    const fresh = posts.find((p) => p.id === eventPopover.post.id);
    if (fresh && fresh !== eventPopover.post) {
      setEventPopover((prev) => (prev ? { ...prev, post: fresh } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts]);

  // The Calendar tab's own "add a plan for this day" mini-form — deliberately
  // separate from the big Posts-tab compose state (content/mediaUrl etc.),
  // since a planned idea isn't the same thing as a post being composed.
  const [planContent, setPlanContent] = useState("");
  const [planMediaUrl, setPlanMediaUrl] = useState<string | null>(null);
  const [planMediaUploading, setPlanMediaUploading] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  // Pre-selected platform(s) + time for a plan item (2026-08-20) — both
  // optional, unlike the Posts tab's compose form. Left empty, a plan item
  // stays a pure idea exactly as before; filled in, "Add to scheduler"
  // can promote it directly with no second round of data entry.
  const [planAccountIds, setPlanAccountIds] = useState<string[]>([]);
  const [planTime, setPlanTime] = useState("");
  const [promotingPlanId, setPromotingPlanId] = useState<string | null>(null);
  const [mentions, setMentions] = useState<MentionPost[] | null>(null);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [mentionsAttentionOnly, setMentionsAttentionOnly] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingCommentId, setReplyingCommentId] = useState<string | null>(null);
  const [replySentCommentId, setReplySentCommentId] = useState<string | null>(null);
  const [dmConversations, setDmConversations] = useState<DMConversation[] | null>(null);
  const [dmConversationsLoading, setDmConversationsLoading] = useState(false);
  const [dmsAttentionOnly, setDmsAttentionOnly] = useState(false);
  const [openConversation, setOpenConversation] = useState<DMConversation | null>(null);
  const [dmMessages, setDmMessages] = useState<DMMessage[] | null>(null);
  const [dmMessagesLoading, setDmMessagesLoading] = useState(false);
  const [dmDraft, setDmDraft] = useState("");
  const [dmSending, setDmSending] = useState(false);
  const [dmAutomations, setDmAutomations] = useState<DMAutomation[] | null>(null);
  const [automationSocialAccountId, setAutomationSocialAccountId] = useState("");
  const [automationKeyword, setAutomationKeyword] = useState("");
  const [automationMessage, setAutomationMessage] = useState("");
  const [creatingAutomation, setCreatingAutomation] = useState(false);
  const [deletingAutomationId, setDeletingAutomationId] = useState<string | null>(null);
  const [bioPage, setBioPage] = useState<BioPage | null | undefined>(undefined);
  const [bioLoading, setBioLoading] = useState(false);
  const [bioSaving, setBioSaving] = useState(false);
  const [bioSlug, setBioSlug] = useState("");
  const [bioTitle, setBioTitle] = useState("");
  const [bioBio, setBioBio] = useState("");
  const [bioLinkLabel, setBioLinkLabel] = useState("");
  const [bioLinkUrl, setBioLinkUrl] = useState("");
  const [bioLinkBusy, setBioLinkBusy] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsRangeDays, setAnalyticsRangeDays] = useState(30);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightResult, setInsightResult] = useState<{ insight: string } | { insufficientData: true; postsWithData: number; needed: number } | null>(null);
  const [finalizingUpgrade, setFinalizingUpgrade] = useState(false);
  const pendingTierRef = useRef<"pro" | "business" | "enterprise" | "agency" | "agency_plus" | null>(null);
  const pendingStorageAddonRef = useRef<5 | 20 | 50 | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [accs, pts, sub, usage, media, addons, plats, acct, keys, recurring, brandList, brandCap, teamList, seatCap] = await Promise.all([
        api.listSocialAccounts(),
        api.listScheduledPosts(),
        api.getSubscription(),
        api.getStorageUsage(),
        api.listMedia(),
        api.listStorageAddons(),
        api.getPlatforms(),
        api.getAccount(),
        api.listApiKeys(),
        api.listRecurringSchedules(),
        api.getBrands(),
        api.getBrandAddons(),
        api.listTeam(),
        api.getSeatAddons(),
      ]);
      setAccounts(accs);
      setBrands(brandList);
      setBrandCapacity(brandCap);
      setSeatCapacity(seatCap);
      setPosts(pts);
      // A fresh refresh() replaces `posts` with just the first History
      // page again (see GET /scheduled-posts), discarding any additional
      // pages a prior "Load more" had appended — recompute rather than
      // assuming there's more: an account with fewer history posts than
      // one page (e.g. this session's test account, 10 posts) got that
      // entire history back in this single response, and the button
      // shouldn't show at all in that case, not just hide itself after a
      // wasted click.
      const historyCount = pts.filter((p) => p.status === "posted" || p.status === "failed").length;
      setHistoryHasMore(historyCount >= HISTORY_PAGE_SIZE);
      setSubscription(sub);
      setStorageUsage(usage);
      setMediaFiles(media);
      setStorageAddons(addons);
      setPlatforms(plats);
      setAccount(acct);
      setRecurringSchedules(recurring);
      if (!businessNameSeeded.current) {
        setBusinessNameInput(acct.businessName ?? "");
        businessNameSeeded.current = true;
      }
      if (!voiceProfileSeeded.current) {
        setVoiceProfileInput(acct.voiceProfile ?? "");
        voiceProfileSeeded.current = true;
      }
      if (!webhookUrlSeeded.current) {
        setWebhookUrlInput(acct.webhookUrl ?? "");
        webhookUrlSeeded.current = true;
      }
      setApiKeys(keys);
      setTeam(teamList);
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

  // OAuth grants (third-party apps authorized via the hosted MCP server's
  // consent screen) live entirely on Supabase's side, not LazyRelay's own
  // API -- loaded separately from refresh()'s Promise.all, which only
  // covers api.* calls against LazyRelay's backend.
  useEffect(() => {
    supabase.auth.oauth
      .listGrants()
      .then(({ data, error: err }) => {
        if (err) {
          setError(err.message);
          return;
        }
        setOauthGrants(data ?? []);
      })
      .finally(() => setOauthGrantsLoading(false));
  }, []);

  useEffect(() => {
    if (!moreMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreMenuOpen]);

  // Post status (pending -> posting -> posted/failed) is written by the
  // scheduler seconds after refresh() first loads the page, so without
  // this the Posts tab shows a stale "PENDING" pill until the customer
  // manually reloads. Poll the lightweight list endpoint (not the full
  // refresh()) every 4s while there's still a due-but-unresolved post,
  // and stop once nothing is left unresolved. Must also count "posting"
  // (the scheduler's claim-in-progress status, scheduler.ts:111) alongside
  // "pending" — checking "pending" alone means the moment a poll tick
  // observes a post mid-claim, this effect's own `posts` dependency
  // re-fires, sees zero "pending" rows left, and tears the interval down
  // right before the real posted/failed resolution ever lands (confirmed
  // live 2026-08-06: a test post sat on "POSTING" indefinitely in the UI
  // while the database already said "posted").
  //
  // Overview no longer renders the Upcoming/History list (2026-08-07
  // redesign — it has its own chart summary now), but it still needs live
  // updates: a post resolving from pending to posted/failed should move
  // the KPI counts and status bar without a manual reload, same bug class
  // as the original stuck-PENDING pill. So on Overview this also re-fetches
  // `analytics`, not just `posts`.
  useEffect(() => {
    if (tab !== "Posts" && tab !== "Overview") return;
    const hasUnresolvedDue = posts.some(
      (p) => (p.status === "pending" || p.status === "posting") && !!p.scheduled_for && new Date(p.scheduled_for) <= new Date()
    );
    if (!hasUnresolvedDue) return;
    const interval = setInterval(() => {
      api.listScheduledPosts().then(setPosts).catch(() => {});
      if (tab === "Overview") {
        api.getAnalyticsSummary(30).then(setAnalytics).catch(() => {});
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [tab, posts]);

  // Slow heartbeat — the fast poller above only ever starts once something
  // is ALREADY due; if nothing was due yet when the tab loaded, nothing
  // re-triggers its `hasUnresolvedDue` check, so a post that becomes due
  // later (and fires in the background) never surfaces without a manual
  // reload. This is exactly the "History doesn't auto-refresh" gap Werner
  // flagged 2026-08-19. A slow re-fetch here updates `posts`, which
  // re-runs the effect above and hands off to the fast poller the moment
  // something newly-due needs snappier updates.
  //
  // Calendar included since 2026-08-31 (Phase 3 Google Calendar sync made
  // inbound updates near-instant on the backend, which only matters if the
  // frontend actually re-fetches — Calendar derives its whole view from
  // `posts`, same as Posts/Overview, but was the one tab with no live
  // refresh at all, confirmed live: a customer sitting on Calendar while a
  // sync happened elsewhere saw stale data until a manual reload).
  useEffect(() => {
    if (tab !== "Posts" && tab !== "Overview" && tab !== "Calendar") return;
    const heartbeat = setInterval(() => {
      api.listScheduledPosts().then(setPosts).catch(() => {});
    }, 60000);
    return () => clearInterval(heartbeat);
  }, [tab]);

  // Refetch-on-focus, added 2026-08-31 alongside the Calendar heartbeat fix
  // above — the scenario that surfaced both gaps: tab away to Google
  // Calendar (or anywhere else), make a change, tab back to LazyRelay, and
  // see it reflected immediately rather than waiting up to 60s for the
  // heartbeat. visibilitychange (not window "focus") to also catch
  // switching virtual desktops/apps, not just window focus specifically.
  // Deliberately calls the lightweight listScheduledPosts(), same scope as
  // the heartbeat, not the full refresh() Promise.all -- an alt-tab habit
  // shouldn't re-fetch all 14 endpoints every time.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      api.listScheduledPosts().then(setPosts).catch(() => {});
      if (tab === "Overview" || tab === "Analytics") {
        api.getAnalyticsSummary(tab === "Overview" ? 30 : analyticsRangeDays, brandFilter || undefined).then(setAnalytics).catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [tab, analyticsRangeDays, brandFilter]);

  // Lazy-loaded, not part of refresh() — analytics isn't needed on first
  // paint for most customers, and re-fetching it every time an unrelated
  // action (scheduling a post, connecting an account) calls refresh() would
  // just be wasted queries for a tab that might never be opened. Overview
  // now renders its own chart summary built from this same data (2026-08-07
  // redesign), so it needs the fetch too — Overview always uses the default
  // 30-day range rather than the Analytics tab's own picker.
  useEffect(() => {
    if (tab !== "Analytics" && tab !== "Overview") return;
    const days = tab === "Overview" ? 30 : analyticsRangeDays;
    setAnalyticsLoading(true);
    setInsightResult(null);
    api
      .getAnalyticsSummary(days, brandFilter || undefined)
      .then(setAnalytics)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setAnalyticsLoading(false));
  }, [tab, analyticsRangeDays, brandFilter]);

  // Lazy-loaded — fetching comments hits each platform's API per post, so
  // this should only run when the customer actually opens the tab, not on
  // every dashboard load.
  useEffect(() => {
    if (tab !== "Mentions" || mentions !== null) return;
    setMentionsLoading(true);
    api
      .getMentions()
      .then((res) => setMentions(res.posts))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMentionsLoading(false));
  }, [tab, mentions]);

  // Same lazy-load reasoning as Mentions.
  useEffect(() => {
    if (tab !== "DMs" || dmConversations !== null) return;
    setDmConversationsLoading(true);
    api
      .getDMs()
      .then((res) => setDmConversations(res.conversations))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDmConversationsLoading(false));
  }, [tab, dmConversations]);

  useEffect(() => {
    if (tab !== "DMs" || dmAutomations !== null) return;
    api
      .listDMAutomations()
      .then(setDmAutomations)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [tab, dmAutomations]);

  // Same lazy-load reasoning as Mentions/DMs above — only fetched once the
  // customer actually opens Settings, where the two-factor section lives.
  // supabase.auth.mfa.listFactors() doesn't throw on failure (it returns
  // {data, error}), unlike the api.* helpers above, so the error has to be
  // checked and thrown manually to land in the same .catch.
  useEffect(() => {
    if (tab !== "Settings" || mfaFactorId !== undefined) return;
    supabase.auth.mfa
      .listFactors()
      .then(({ data, error }) => {
        if (error) throw error;
        setMfaFactorId(data.totp[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [tab, mfaFactorId]);

  // Fetched once real data has loaded, regardless of tab -- originally
  // lazy-loaded only on Settings, but the Calendar tab's sidebar and the
  // first-run "connect Google Calendar?" prompt (2026-08-30) both need to
  // know this before the customer has necessarily opened Settings at all.
  // Re-fetched (via gcalStatus reset to undefined) after a connect/
  // disconnect action below.
  useEffect(() => {
    if (loading || gcalStatus !== undefined) return;
    api
      .getGoogleCalendarStatus()
      .then((status) => setGcalStatus(status.connected ? status : null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [loading, gcalStatus]);

  // Same lazy-load-once pattern as gcalStatus above, independent connection.
  useEffect(() => {
    if (loading || gsheetStatus !== undefined) return;
    api
      .getGoogleSheetsStatus()
      .then((status) => setGsheetStatus(status.connected ? status : null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [loading, gsheetStatus]);

  // Also lazy-loaded, same reasoning as analytics — only fetched once the
  // customer actually opens the tab.
  useEffect(() => {
    if (tab !== "Bio Page" || bioPage !== undefined) return;
    setBioLoading(true);
    api
      .getBioPage()
      .then((page) => {
        setBioPage(page);
        if (page) {
          setBioSlug(page.slug);
          setBioTitle(page.title);
          setBioBio(page.bio);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBioLoading(false));
  }, [tab, bioPage]);

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
    } else if (connectParams.selectAccount) {
      const token = connectParams.selectAccount;
      api
        .getPendingSelection(token)
        .then((pending) => {
          setPendingSelection({ token, ...pending });
          // Default to "connect all" — the common case for a customer who
          // genuinely manages several Pages — while still letting them
          // uncheck the ones they don't want.
          setCheckedOptionIds(pending.options.map((o) => o.id));
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }
    if (connectParams.prefillContent || connectParams.prefillMediaUrl) {
      setTab("Posts");
      if (connectParams.prefillContent) setContent(connectParams.prefillContent);
      if (connectParams.prefillMediaUrl) setMediaUrl(connectParams.prefillMediaUrl);
    }
    if (connectParams.gcalConnectError) {
      setError(connectParams.gcalConnectError);
    } else if (connectParams.gcalConnected) {
      setNotice("Google Calendar connected!");
      setTab("Settings");
      setGcalStatus(undefined); // triggers the lazy-load effect above to re-fetch
    }
    if (connectParams.gsheetConnectError) {
      setError(connectParams.gsheetConnectError);
    } else if (connectParams.gsheetConnected) {
      setNotice("Google Sheets connected!");
      setTab("Settings");
      setGsheetStatus(undefined); // triggers the lazy-load effect above to re-fetch
    }
  }, []);

  async function handleFinalizeSelection() {
    if (!pendingSelection || checkedOptionIds.length === 0) return;
    setSelectionBusy(true);
    setError(null);
    try {
      await api.finalizeSelection(pendingSelection.token, checkedOptionIds);
      setPendingSelection(null);
      setCheckedOptionIds([]);
      setNotice(checkedOptionIds.length === 1 ? "Account connected!" : `${checkedOptionIds.length} accounts connected!`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelectionBusy(false);
    }
  }

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
        // Both pending refs are checked here rather than polling from
        // inside handleUpgrade/handleBuyStorageAddon right after
        // Checkout.open() — that used to start the poll the instant the
        // overlay opened, racing against the customer actually entering a
        // card and finishing checkout, so the 15s window was almost always
        // gone before the real purchase completed (found live 2026-08-11 —
        // the storage gauge never updated on its own after a real add-on
        // purchase). Waiting for the real checkout.completed event fixes
        // both paths the same way.
        if (event.name === "checkout.completed") {
          if (pendingTierRef.current) {
            pollUntilUpgraded();
          } else if (pendingStorageAddonRef.current) {
            pollUntilAddonAdded();
          } else if (pendingBrandAddonRef.current) {
            pollUntilBrandAddonAdded();
          } else if (pendingSeatAddonRef.current) {
            pollUntilSeatAddonAdded();
          }
        }
      },
    }).then(setPaddle);
  }, []);

  // Real board list for the compose form's board picker — fetched whenever
  // the selected Pinterest account changes, not on every render. Only one
  // Pinterest account's boards are shown even if multiple accounts are
  // checked (matching how the AI caption/hashtag helpers above already
  // treat "the first selected account" as the representative one) — a
  // customer with two connected Pinterest accounts posting to both at once
  // is an edge case not worth a per-account picker today.
  const selectedPinterestAccountId = selectedAccountIds.find(
    (id) => accounts.find((a) => a.id === id)?.platform === "pinterest",
  );
  useEffect(() => {
    if (!selectedPinterestAccountId) {
      setPinterestBoards([]);
      setSelectedBoardId(null);
      return;
    }
    setBoardsLoading(true);
    api
      .getBoards(selectedPinterestAccountId)
      .then((boards) => {
        setPinterestBoards(boards);
        setSelectedBoardId((prev) => (prev && boards.some((b) => b.id === prev) ? prev : (boards[0]?.id ?? null)));
      })
      .catch(() => setPinterestBoards([]))
      .finally(() => setBoardsLoading(false));
  }, [selectedPinterestAccountId]);

  // TikTok's "Required UX Implementation" point 1 -- load the selected TikTok
  // account's live creator info. A failed lookup leaves it null, so the form
  // never blocks on a TikTok hiccup (the backend re-checks at posting time).
  const tiktokInfoAccountId = selectedAccountIds.find((id) => accounts.find((a) => a.id === id)?.platform === "tiktok");
  useEffect(() => {
    setTiktokCreatorInfo(null);
    if (!tiktokInfoAccountId) return;
    let cancelled = false;
    api
      .getTiktokCreatorInfo(tiktokInfoAccountId)
      .then((info) => {
        if (cancelled) return;
        setTiktokCreatorInfo(info);
        // The privacy dropdown's real options only arrive with this call. If
        // the customer already picked one (e.g. from a prior account
        // selection) and it turns out this creator doesn't actually have
        // that option -- a private account never gets PUBLIC_TO_EVERYONE --
        // clear it rather than let an invalid value reach submit.
        setTiktokPrivacyLevel((current) =>
          current && info.privacyLevelOptions.length > 0 && !info.privacyLevelOptions.includes(current)
            ? null
            : current,
        );
      })
      .catch(() => {
        if (!cancelled) setTiktokCreatorInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tiktokInfoAccountId]);

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

  /** Same shape as pollUntilUpgraded(), for storage add-ons — kept as a
   *  separate function since it polls a different endpoint pair and
   *  doesn't touch the tier-upgrade banner state. */
  async function pollUntilAddonAdded() {
    const gbAmount = pendingStorageAddonRef.current;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const addons = await api.listStorageAddons();
        if (addons.some((a) => a.gb_amount === gbAmount)) {
          setStorageAddons(addons);
          const usage = await api.getStorageUsage();
          setStorageUsage(usage);
          return;
        }
      }
      // Timed out waiting on the webhook — refresh once more anyway so the
      // gauge shows whatever the real current state is rather than nothing.
      const [addons, usage] = await Promise.all([api.listStorageAddons(), api.getStorageUsage()]);
      setStorageAddons(addons);
      setStorageUsage(usage);
    } finally {
      setAddonBusy(null);
      pendingStorageAddonRef.current = null;
    }
  }

  /** Same shape as pollUntilAddonAdded(), for brand add-ons. Matches on total
   *  add-on count increasing rather than a specific size (every brand add-on
   *  is identical — just +1 slot), unlike the gb_amount match above. */
  async function pollUntilBrandAddonAdded() {
    const countBefore = brandCapacity?.addonSlots ?? 0;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const cap = await api.getBrandAddons();
        if (cap.addonSlots > countBefore) {
          setBrandCapacity(cap);
          return;
        }
      }
      // Timed out waiting on the webhook — refresh once more anyway so the
      // capacity shown is whatever the real current state is, not stale.
      setBrandCapacity(await api.getBrandAddons());
    } finally {
      setBrandAddonBusy(null);
      pendingBrandAddonRef.current = false;
    }
  }

  /** Same shape as pollUntilBrandAddonAdded(), for seat add-ons. */
  async function pollUntilSeatAddonAdded() {
    const countBefore = seatCapacity?.addonSlots ?? 0;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const cap = await api.getSeatAddons();
        if (cap.addonSlots > countBefore) {
          setSeatCapacity(cap);
          return;
        }
      }
      // Timed out waiting on the webhook — refresh once more anyway so the
      // capacity shown is whatever the real current state is, not stale.
      setSeatCapacity(await api.getSeatAddons());
    } finally {
      setSeatAddonBusy(null);
      pendingSeatAddonRef.current = false;
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

  async function handleDisconnectAccount(a: SocialAccount) {
    if (
      !window.confirm(
        `Disconnect ${a.display_name ?? a.platform_account_id} (${a.platform})? Any scheduled posts still using this account will fail next time they're due.`,
      )
    )
      return;
    setDisconnectingAccountId(a.id);
    setError(null);
    try {
      await api.disconnectSocialAccount(a.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnectingAccountId(null);
    }
  }

  async function handleCreateBrand() {
    const name = newBrandName.trim();
    if (!name) return;
    setBrandBusy(true);
    setError(null);
    try {
      const brand = await api.createBrand(name);
      setBrands((prev) => [...prev, brand].sort((a, b) => a.name.localeCompare(b.name)));
      setNewBrandName("");
    } catch (err) {
      // Surfaces the backend's friendly cap-reached / duplicate-name messages.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrandBusy(false);
    }
  }

  async function handleDeleteBrand(id: string) {
    setBrandBusy(true);
    setError(null);
    try {
      await api.deleteBrand(id);
      await refresh(); // reloads brands + accounts (any account on it is now unbranded)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrandBusy(false);
    }
  }

  /** Saves this brand's AI-caption/hashtag voice override — beats the
   *  account-level default (Settings tab) for any account linked to this
   *  brand. */
  async function handleSaveBrandVoice(brand: Brand) {
    const draft = brandVoiceDrafts[brand.id] ?? brand.voice_profile ?? "";
    setBrandVoiceBusyId(brand.id);
    setError(null);
    try {
      const updated = await api.updateBrand(brand.id, brand.name, draft.trim() || null);
      setBrands((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrandVoiceBusyId(null);
    }
  }

  async function handleAssignBrand(accountId: string, brandId: string | null) {
    setAssigningAccountId(accountId);
    setError(null);
    try {
      const updated = await api.setAccountBrand(accountId, brandId);
      setAccounts((prev) => prev.map((a) => (a.id === accountId ? updated : a)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssigningAccountId(null);
    }
  }

  function toggleSelectedAccount(id: string) {
    setSelectedAccountIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
    // Deselecting an account drops any per-platform override for it too —
    // otherwise a stale override could silently resurface if the same
    // account gets reselected later in the same compose session.
    setPerAccountContent((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function toggleRsAccount(id: string) {
    setRsSelectedAccountIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  function toggleRsDay(day: number) {
    setRsDaysOfWeek((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  }

  function resetRsForm() {
    setRsEditingId(null);
    setRsContent("");
    setRsSelectedAccountIds([]);
    setRsDaysOfWeek([]);
    setRsTimeOfDay("09:00");
  }

  function startEditingRecurringSchedule(s: RecurringSchedule) {
    setRsEditingId(s.id);
    setRsContent(s.content);
    setRsSelectedAccountIds(s.social_account_ids);
    setRsDaysOfWeek(s.days_of_week);
    setRsTimeOfDay(s.time_of_day.slice(0, 5));
  }

  async function submitRecurringSchedule(e: FormEvent) {
    e.preventDefault();
    if (rsSelectedAccountIds.length === 0) {
      setError("Select at least one connected account for this recurring schedule.");
      return;
    }
    if (rsDaysOfWeek.length === 0) {
      setError("Pick at least one day of the week for this recurring schedule.");
      return;
    }
    setRsSubmitting(true);
    setError(null);
    try {
      const input = {
        content: rsContent,
        socialAccountIds: rsSelectedAccountIds,
        daysOfWeek: rsDaysOfWeek,
        timeOfDay: rsTimeOfDay,
        timezone: rsTimezone,
      };
      if (rsEditingId) {
        await api.updateRecurringSchedule(rsEditingId, input);
      } else {
        await api.createRecurringSchedule(input);
      }
      resetRsForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRsSubmitting(false);
    }
  }

  async function handleTogglePauseResume(s: RecurringSchedule) {
    setRsBusyId(s.id);
    setError(null);
    try {
      await api.updateRecurringSchedule(s.id, { status: s.status === "active" ? "paused" : "active" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRsBusyId(null);
    }
  }

  async function handleDeleteRecurringSchedule(id: string) {
    if (!window.confirm("Delete this recurring schedule? Already-generated upcoming posts can either be cancelled too, or left to fire once more.")) return;
    const cancelUpcoming = window.confirm("Also cancel any already-generated upcoming posts from this schedule? Choose Cancel to keep them.");
    setRsBusyId(id);
    setError(null);
    try {
      await api.deleteRecurringSchedule(id, cancelUpcoming);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRsBusyId(null);
    }
  }

  async function handleGenerateCaption() {
    if (!aiTopic.trim()) {
      setError("Type what the post should be about first.");
      return;
    }
    setAiGenerating(true);
    setError(null);
    try {
      const firstAccount = accounts.find((a) => a.id === selectedAccountIds[0]);
      const { caption } = await api.generateCaption(aiTopic.trim(), firstAccount?.platform, undefined, firstAccount?.id);
      setContent(caption);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiGenerating(false);
    }
  }

  async function handleGetContentIdeas() {
    setIdeasGenerating(true);
    setError(null);
    try {
      const { ideas } = await api.getContentIdeas();
      setContentIdeas(ideas);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIdeasGenerating(false);
    }
  }

  function handleUseContentIdea(idea: string) {
    setAiTopic(idea);
    setContentIdeas(null);
  }

  async function handleGetInsight() {
    setInsightLoading(true);
    setInsightResult(null);
    setError(null);
    try {
      const result = await api.getAnalyticsInsight(analyticsRangeDays, brandFilter || undefined);
      setInsightResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInsightLoading(false);
    }
  }

  async function handleSuggestHashtags() {
    if (!content.trim()) {
      setError("Write (or generate) the post content first.");
      return;
    }
    setHashtagGenerating(true);
    setError(null);
    try {
      const firstAccount = accounts.find((a) => a.id === selectedAccountIds[0]);
      const { hashtags } = await api.suggestHashtags(content.trim(), firstAccount?.platform, firstAccount?.id);
      if (hashtags.length > 0) {
        setContent((prev) => `${prev.trim()}\n\n${hashtags.join(" ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setHashtagGenerating(false);
    }
  }

  // TikTok Content Sharing Guidelines, "Required UX Implementation" point 3a:
  // disclosure toggle on + neither option ticked => publish is disabled, and
  // hovering must show exactly this message.
  const TIKTOK_DISCLOSURE_HOVER = "You need to indicate if your content promotes yourself, a third party, or both.";
  const tiktokDisclosureIncomplete = isTiktokDisclosureIncomplete(
    selectedAccountIds,
    accounts,
    tiktokDiscloseCommercial,
    tiktokBrandOrganic,
    tiktokBrandContent,
  );
  // TikTok's "Required UX Implementation" point 1: stop when TikTok says this
  // account can't post more right now, and when the video is longer than
  // TikTok allows for this account.
  const tiktokSelected = selectedAccountIds.some((id) => accounts.find((a) => a.id === id)?.platform === "tiktok");
  const mediaDurationSec = mediaDuration && mediaDuration.url === mediaUrl ? mediaDuration.sec : null;
  const tiktokCantPostReason =
    tiktokSelected && tiktokCreatorInfo && !tiktokCreatorInfo.canPost ? tiktokCreatorInfo.cantPostReason : null;
  const tiktokMaxVideoSec = tiktokCreatorInfo?.maxVideoDurationSec ?? null;
  const tiktokVideoTooLongText =
    tiktokSelected &&
    mediaDurationSec !== null &&
    tiktokMaxVideoSec !== null &&
    isVideoTooLongForTiktok(mediaDurationSec, tiktokMaxVideoSec)
      ? tiktokVideoTooLongMessage(mediaDurationSec, tiktokMaxVideoSec)
      : null;
  // Whichever TikTok rule currently blocks Schedule/Post Now, most serious
  // first; null when nothing does.
  const tiktokPublishBlockedText =
    tiktokCantPostReason ?? tiktokVideoTooLongText ?? (tiktokDisclosureIncomplete ? TIKTOK_DISCLOSURE_HOVER : null);

  async function submitPost(scheduledForIso: string, requiresApprovalOverride = requiresApproval) {
    if (selectedAccountIds.length === 0) {
      setError("Select at least one connected account to post to.");
      return;
    }
    if (selectedAccountIds.some((id) => accounts.find((a) => a.id === id)?.platform === "tiktok") && !tiktokPrivacyLevel) {
      setError("Choose who can see this post on TikTok before scheduling.");
      return;
    }
    if (tiktokPublishBlockedText) {
      setError(tiktokPublishBlockedText);
      return;
    }
    if (selectedAccountIds.some((id) => accounts.find((a) => a.id === id)?.platform === "tiktok") && !tiktokConsentGiven) {
      setError("Agree to TikTok's Music Usage Confirmation before posting.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // One scheduled_posts row per selected account — same media/time fanned
      // out to every platform the customer checked, via the existing
      // single-post endpoint rather than a new batch one. Content is the
      // shared caption UNLESS this account has a per-platform override
      // (2026-08-16, see perAccountContent). If a draft is being edited
      // (2026-08-16), its row is PROMOTED in place for the first selected
      // account (via PATCH .../schedule) rather than left orphaned while a
      // brand-new row is created — any additional selected accounts still
      // get their own fresh rows, same as the normal multi-account flow.
      for (let i = 0; i < selectedAccountIds.length; i++) {
        const socialAccountId = selectedAccountIds[i];
        const fields = {
          socialAccountId,
          content: perAccountContent[socialAccountId] ?? content,
          mediaUrl: mediaUrl ?? undefined,
          coverImageUrl: coverImageUrl ?? undefined,
          // Only meaningful when this account is on Pinterest — every other
          // adapter's post() ignores it, same as coverImageUrl above.
          boardId: accounts.find((a) => a.id === socialAccountId)?.platform === "pinterest"
            ? (selectedBoardId ?? undefined)
            : undefined,
          // Same Pinterest-only gate as boardId above.
          destinationLink: accounts.find((a) => a.id === socialAccountId)?.platform === "pinterest"
            ? (destinationLink?.trim() ? destinationLink.trim() : undefined)
            : undefined,
          // Only consumed server-side for Facebook/Instagram today — harmless
          // no-op for every other platform, same pattern as boardId above.
          firstComment: firstComment?.trim() ? firstComment.trim() : undefined,
          // Only consumed by Mastodon today (see PostRequest.mediaAltText) —
          // every other adapter simply ignores it, same pattern as above.
          mediaAltText: mediaAltText?.trim() ? mediaAltText.trim() : undefined,
          // TikTok-only, same gate pattern as boardId/destinationLink above.
          // The backend rejects a TikTok post with no privacy level rather
          // than defaulting it — see postCreation.ts.
          ...(accounts.find((a) => a.id === socialAccountId)?.platform === "tiktok"
            ? {
                tiktokPrivacyLevel: tiktokPrivacyLevel ?? undefined,
                tiktokDisableComment: !tiktokAllowComment,
                tiktokDisableDuet: !tiktokAllowDuet,
                tiktokDisableStitch: !tiktokAllowStitch,
                tiktokBrandOrganic: tiktokDiscloseCommercial && tiktokBrandOrganic,
                tiktokBrandContent: tiktokDiscloseCommercial && tiktokBrandContent,
              }
            : {}),
          scheduledFor: scheduledForIso,
          requiresApproval: requiresApprovalOverride,
        };
        if (i === 0 && editingDraftId) {
          await api.scheduleDraft(editingDraftId, fields);
        } else {
          await api.createScheduledPost(fields);
        }
      }
      setContent("");
      setScheduleDate("");
      setScheduleTime("");
      setMediaUrl(null);
      setCoverImageUrl(null);
      setDestinationLink(null);
      setFirstComment(null);
      setMediaAltText(null);
      setTiktokPrivacyLevel(null);
      setTiktokAllowComment(false);
      setTiktokAllowDuet(false);
      setTiktokAllowStitch(false);
      setTiktokDiscloseCommercial(false);
      setTiktokBrandOrganic(false);
      setTiktokBrandContent(false);
      setTiktokConsentGiven(false);
      setPerAccountContent({});
      setRequiresApproval(false);
      setEditingDraftId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Saves whatever's currently in the compose form as a draft — no account
   *  or time required, unlike a real scheduled post. Updates the existing
   *  draft row in place if one's being edited (editingDraftId set),
   *  otherwise creates a new one. Deliberately does NOT touch
   *  selectedAccountIds/scheduleDate/scheduleTime — those aren't draft
   *  fields, and clearing them would lose a customer's in-progress account
   *  picks for no reason. */
  async function handleSaveDraft() {
    if (!content.trim()) {
      setError("Write something before saving it as a draft.");
      return;
    }
    setDraftBusy(true);
    setError(null);
    try {
      const fields = {
        content,
        mediaUrl: mediaUrl ?? undefined,
        coverImageUrl: coverImageUrl ?? undefined,
        firstComment: firstComment?.trim() ? firstComment.trim() : undefined,
        mediaAltText: mediaAltText?.trim() ? mediaAltText.trim() : undefined,
        tiktokPrivacyLevel: tiktokPrivacyLevel ?? undefined,
        tiktokDisableComment: !tiktokAllowComment,
        tiktokDisableDuet: !tiktokAllowDuet,
        tiktokDisableStitch: !tiktokAllowStitch,
        tiktokBrandOrganic: tiktokDiscloseCommercial && tiktokBrandOrganic,
        tiktokBrandContent: tiktokDiscloseCommercial && tiktokBrandContent,
      };
      if (editingDraftId) {
        await api.updateDraft(editingDraftId, fields);
      } else {
        await api.saveDraft(fields);
      }
      setContent("");
      setMediaUrl(null);
      setCoverImageUrl(null);
      setFirstComment(null);
      setMediaAltText(null);
      setTiktokPrivacyLevel(null);
      setTiktokAllowComment(false);
      setTiktokAllowDuet(false);
      setTiktokAllowStitch(false);
      setTiktokDiscloseCommercial(false);
      setTiktokBrandOrganic(false);
      setTiktokBrandContent(false);
      setTiktokConsentGiven(false);
      setEditingDraftId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusy(false);
    }
  }

  /** Loads a draft back into the compose form for editing. Account/time are
   *  deliberately left for the customer to fill in fresh — a draft by
   *  definition never had them. */
  function handleEditDraft(p: ScheduledPost) {
    setContent(p.content);
    setMediaUrl(p.media_url);
    setCoverImageUrl(p.cover_image_url);
    setDestinationLink(p.destination_link);
    setFirstComment(p.first_comment);
    setMediaAltText(p.media_alt_text);
    setTiktokPrivacyLevel(p.tiktok_privacy_level);
    setTiktokAllowComment(!p.tiktok_disable_comment);
    setTiktokAllowDuet(!p.tiktok_disable_duet);
    setTiktokAllowStitch(!p.tiktok_disable_stitch);
    setTiktokDiscloseCommercial(p.tiktok_brand_organic || p.tiktok_brand_content);
    setTiktokBrandOrganic(p.tiktok_brand_organic);
    setTiktokBrandContent(p.tiktok_brand_content);
    setEditingDraftId(p.id);
    setError(null);
  }

  function handleCancelEditDraft() {
    setContent("");
    setMediaUrl(null);
    setCoverImageUrl(null);
    setDestinationLink(null);
    setFirstComment(null);
    setMediaAltText(null);
    setTiktokPrivacyLevel(null);
    setTiktokAllowComment(false);
    setTiktokAllowDuet(false);
    setTiktokAllowStitch(false);
    setTiktokDiscloseCommercial(false);
    setTiktokBrandOrganic(false);
    setTiktokBrandContent(false);
    setTiktokConsentGiven(false);
    setEditingDraftId(null);
  }

  async function handleSchedule(e: FormEvent) {
    e.preventDefault();
    if (!scheduleDate || !scheduleTime) {
      setError("Pick both a date and a time to schedule this post for.");
      return;
    }
    await submitPost(new Date(`${scheduleDate}T${scheduleTime}`).toISOString());
  }

  async function handlePostNow() {
    // "Post Now" + an approval gate would just sit forever waiting for
    // someone to approve a post already meant to fire immediately —
    // ignore the checkbox for this path rather than confuse the customer
    // with a post that silently never goes out.
    await submitPost(new Date().toISOString(), false);
  }

  async function handleMediaFile(file: File) {
    setError(null);
    setMediaUploading(true);
    setMediaUploadProgress(0);
    try {
      const { url } = await api.uploadMedia(file, setMediaUploadProgress);
      setMediaUrl(url);
      setMediaAltText(null); // fresh file, no description yet
      // Usage/quota just changed — refresh the gauge and file list so
      // they're never stale relative to what was just uploaded.
      const [usage, media] = await Promise.all([api.getStorageUsage(), api.listMedia()]);
      setStorageUsage(usage);
      setMediaFiles(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaUploading(false);
      setMediaUploadProgress(0);
    }
  }

  async function handleCoverImageFile(file: File) {
    setError(null);
    setCoverImageUploading(true);
    setCoverImageUploadProgress(0);
    try {
      const { url } = await api.uploadMedia(file, setCoverImageUploadProgress);
      setCoverImageUrl(url);
      const [usage, media] = await Promise.all([api.getStorageUsage(), api.listMedia()]);
      setStorageUsage(usage);
      setMediaFiles(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCoverImageUploading(false);
      setCoverImageUploadProgress(0);
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

  async function handleSaveMediaAltText(id: string, altText: string) {
    setMediaBusyId(id);
    setError(null);
    try {
      await api.updateMediaAltText(id, altText.trim() || null);
      setMediaFiles(await api.listMedia());
      setMediaAltTextDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaBusyId(null);
    }
  }

  function handleMediaDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setMediaDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleMediaFile(file);
  }

  async function handleSaveBioPage(e: FormEvent) {
    e.preventDefault();
    setBioSaving(true);
    setError(null);
    try {
      const saved = await api.saveBioPage({ slug: bioSlug, title: bioTitle, bio: bioBio });
      setBioPage({ ...saved, links: bioPage?.links ?? [] });
      setNotice("Bio page saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBioSaving(false);
    }
  }

  async function handleAddBioLink(e: FormEvent) {
    e.preventDefault();
    if (!bioLinkLabel.trim() || !bioLinkUrl.trim()) return;
    setBioLinkBusy(true);
    setError(null);
    try {
      const link = await api.addBioLink({ label: bioLinkLabel.trim(), url: bioLinkUrl.trim() });
      setBioPage((prev) => (prev ? { ...prev, links: [...prev.links, link] } : prev));
      setBioLinkLabel("");
      setBioLinkUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBioLinkBusy(false);
    }
  }

  async function handleDeleteBioLink(id: string) {
    setError(null);
    try {
      await api.deleteBioLink(id);
      setBioPage((prev) => (prev ? { ...prev, links: prev.links.filter((l) => l.id !== id) } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleApprove(id: string) {
    setApprovingId(id);
    setError(null);
    try {
      await api.approveScheduledPost(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovingId(null);
    }
  }

  // Stopgap prompt()-based date entry (2026-08-30) — a real date-picker
  // popover is coming in the Calendar redesign; this exists so move/
  // post-now/duplicate are genuinely clickable end-to-end in the meantime.
  function promptForDateTime(message: string): string | null {
    const input = window.prompt(`${message}\n(e.g. "2026-09-15 14:30", your local time)`);
    if (!input) return null;
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
      setError(`Couldn't understand "${input}" as a date/time.`);
      return null;
    }
    return date.toISOString();
  }

  async function handleReschedulePost(id: string) {
    const scheduledFor = promptForDateTime("Move this post to when?");
    if (!scheduledFor) return;
    setReschedulingId(id);
    setError(null);
    try {
      await api.rescheduleScheduledPost(id, scheduledFor);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReschedulingId(null);
    }
  }

  async function handlePostExistingNow(id: string) {
    if (!window.confirm("Post this now? It will go out within about 30 seconds.")) return;
    setReschedulingId(id);
    setError(null);
    try {
      await api.rescheduleScheduledPost(id, new Date().toISOString());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReschedulingId(null);
    }
  }

  async function handleTogglePause(id: string, isPaused: boolean) {
    setPauseResumeId(id);
    setError(null);
    try {
      if (isPaused) {
        await api.resumeScheduledPost(id);
      } else {
        await api.pauseScheduledPost(id);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPauseResumeId(null);
    }
  }

  async function handleDuplicatePost(id: string) {
    const scheduledFor = promptForDateTime("Duplicate this post to when?");
    if (!scheduledFor) return;
    setDuplicatingId(id);
    setError(null);
    try {
      await api.duplicateScheduledPost(id, scheduledFor);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDuplicatingId(null);
    }
  }

  async function handlePlanMediaFile(file: File) {
    setError(null);
    setPlanMediaUploading(true);
    try {
      const { url } = await api.uploadMedia(file);
      setPlanMediaUrl(url);
      const [usage, media] = await Promise.all([api.getStorageUsage(), api.listMedia()]);
      setStorageUsage(usage);
      setMediaFiles(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanMediaUploading(false);
    }
  }

  function togglePlanAccount(id: string) {
    setPlanAccountIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  /** Saves a note/idea for a specific calendar day — a draft anchored to
   *  that day (migration 0059), not yet a real scheduled post. If a
   *  platform and time were also picked (migration 0060), those are stored
   *  on the same draft row so "Add to scheduler" (below) can promote it
   *  directly later with no further data entry. */
  async function handleAddPlanItem(day: string) {
    if (!planContent.trim()) {
      setError("Write something before adding it to the planner.");
      return;
    }
    setPlanBusy(true);
    setError(null);
    try {
      const scheduledFor = planAccountIds.length > 0 && planTime ? new Date(`${day}T${planTime}`).toISOString() : undefined;
      await api.saveDraft({
        content: planContent,
        mediaUrl: planMediaUrl ?? undefined,
        plannedDate: day,
        plannedAccountIds: planAccountIds.length > 0 ? planAccountIds : undefined,
        scheduledFor,
      });
      setPlanContent("");
      setPlanMediaUrl(null);
      setPlanAccountIds([]);
      setPlanTime("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  /** "Add to scheduler" for a planned item. If a platform (or several) and
   *  a time were already picked when the idea was written (migration 0060,
   *  `planned_account_ids` + `scheduled_for`), promotes it directly — one
   *  real post per planned platform, the exact same fan-out submitPost()
   *  uses for a real multi-account post, just triggered from the calendar
   *  instead of the Posts tab form, no re-entry. Otherwise (an older plan
   *  item, or one where a platform was never picked) falls back to loading
   *  it into the Posts tab's compose form so the customer can finish it
   *  there, same as before this feature existed. */
  async function handlePromotePlanItem(p: ScheduledPost) {
    if (!p.planned_account_ids || p.planned_account_ids.length === 0 || !p.scheduled_for) {
      handleEditDraft(p);
      setTab("Posts");
      return;
    }
    setPromotingPlanId(p.id);
    setError(null);
    try {
      for (let i = 0; i < p.planned_account_ids.length; i++) {
        const socialAccountId = p.planned_account_ids[i];
        const platform = accounts.find((a) => a.id === socialAccountId)?.platform;
        const fields = {
          socialAccountId,
          content: p.content,
          mediaUrl: p.media_url ?? undefined,
          coverImageUrl: p.cover_image_url ?? undefined,
          boardId: platform === "pinterest" ? (p.board_id ?? undefined) : undefined,
          destinationLink: platform === "pinterest" ? (p.destination_link ?? undefined) : undefined,
          firstComment: p.first_comment ?? undefined,
          mediaAltText: p.media_alt_text ?? undefined,
          scheduledFor: p.scheduled_for,
        };
        if (i === 0) {
          await api.scheduleDraft(p.id, fields);
        } else {
          await api.createScheduledPost(fields);
        }
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromotingPlanId(null);
    }
  }

  async function handleDelete(id: string, isHistory: boolean) {
    if (isHistory && !window.confirm("Delete this post? This can't be undone.")) return;
    try {
      await api.deleteScheduledPost(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCsvFile(file: File) {
    setError(null);
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length === 0) {
      setError("That CSV file has no rows.");
      return;
    }
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const platformIdx = header.indexOf("platform");
    const contentIdx = header.indexOf("content");
    const scheduledForIdx = header.indexOf("scheduled_for");
    const mediaUrlIdx = header.indexOf("media_url");
    if (platformIdx === -1 || contentIdx === -1 || scheduledForIdx === -1) {
      setError("CSV must have platform, content, and scheduled_for columns.");
      return;
    }

    const parsed = rows.slice(1).map((cells) => {
      const platform = (cells[platformIdx] ?? "").trim();
      const content = (cells[contentIdx] ?? "").trim();
      const scheduledFor = (cells[scheduledForIdx] ?? "").trim();
      const mediaUrl = mediaUrlIdx !== -1 ? (cells[mediaUrlIdx] ?? "").trim() : "";

      let error: string | null = null;
      const account = accounts.find((a) => a.platform.toLowerCase() === platform.toLowerCase());
      if (!platform) error = "Missing platform";
      else if (!account) error = `No connected account for "${platform}"`;
      else if (!content) error = "Missing content";
      else if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) error = "Invalid scheduled_for date";

      return { platform, content, scheduledFor, mediaUrl, socialAccountId: account?.id ?? null, error };
    });
    setCsvRows(parsed);
  }

  async function handleBulkImport() {
    const validRows = csvRows.filter((r) => !r.error && r.socialAccountId);
    if (validRows.length === 0) return;
    setBulkImporting(true);
    setError(null);
    try {
      const { succeeded, failed, results } = await api.bulkCreateScheduledPosts(
        validRows.map((r) => ({
          socialAccountId: r.socialAccountId as string,
          content: r.content,
          mediaUrl: r.mediaUrl || undefined,
          scheduledFor: new Date(r.scheduledFor).toISOString(),
        })),
      );
      // Map per-row backend errors back onto the matching visible row so a
      // partial failure (e.g. one row hit the free-tier limit) is visible
      // per-row instead of one opaque toast for the whole batch.
      if (failed > 0) {
        let validIdx = 0;
        setCsvRows((prev) =>
          prev.map((row) => {
            if (row.error || !row.socialAccountId) return row;
            const result = results[validIdx];
            validIdx++;
            return result.status === 201 ? row : { ...row, error: result.body.error ?? "Failed" };
          }),
        );
      } else {
        setCsvRows([]);
      }
      setNotice(`Imported ${succeeded} post${succeeded === 1 ? "" : "s"}${failed > 0 ? `, ${failed} failed` : ""}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkImporting(false);
    }
  }

  async function handleUpgrade(tier: "pro" | "business" | "enterprise" | "agency" | "agency_plus") {
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
        setError("Checkout couldn't start. No checkout URL was returned.");
        return;
      }
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBillingBusy(null);
    }
  }

  // For a customer already on an active paid tier -- real proration on the
  // existing subscription (see changeSubscriptionTier's doc comment on the
  // backend), not a fresh Paddle.js checkout overlay. No card re-entry
  // needed since the existing saved payment method is charged directly, so
  // this just calls the API and polls the same way handleUpgrade does while
  // waiting for the resulting webhook to land.
  async function handleChangeTier(tier: "pro" | "business" | "enterprise" | "agency" | "agency_plus") {
    setBillingBusy(tier);
    setError(null);
    try {
      await api.changeTier(tier);
      // Don't await this -- matches handleUpgrade's own pattern (the
      // checkout.completed event handler fires pollUntilUpgraded without
      // awaiting it too), so billingBusy clears right away and the
      // "Finalizing your upgrade..." banner (finalizingUpgrade) is the one
      // piece of UI carrying the wait, not a disabled button for 15s.
      pendingTierRef.current = tier;
      void pollUntilUpgraded();
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
        // Arm the ref and open the overlay, then return — pollUntilAddonAdded()
        // runs from the eventCallback's real checkout.completed event, not
        // from here. Polling used to start immediately on this line, racing
        // the customer actually entering a card; addonBusy stays true (button
        // shows "Starting checkout...") until that poll clears it.
        pendingStorageAddonRef.current = gbAmount;
        paddle.Checkout.open({ transactionId });
        return;
      }
      if (!checkoutUrl) {
        setError("Checkout couldn't start. No checkout URL was returned.");
        setAddonBusy(null);
        return;
      }
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  async function handleBuyBrandAddon() {
    setBrandAddonBusy("checkout");
    setError(null);
    try {
      const { transactionId, checkoutUrl } = await api.startBrandAddonCheckout();
      if (paddle && transactionId) {
        // Same real-checkout.completed-event pattern as handleBuyStorageAddon
        // — polling starts from the eventCallback, not here, so it doesn't
        // race the customer actually entering a card.
        pendingBrandAddonRef.current = true;
        paddle.Checkout.open({ transactionId });
        return;
      }
      if (!checkoutUrl) {
        setError("Checkout couldn't start. No checkout URL was returned.");
        setBrandAddonBusy(null);
        return;
      }
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBrandAddonBusy(null);
    }
  }

  async function handleCancelBrandAddon(id: string) {
    if (!window.confirm("Cancel this brand add-on? You'll lose the extra brand slot at the end of the billing period.")) {
      return;
    }
    setBrandAddonBusy(id);
    setError(null);
    try {
      await api.cancelBrandAddon(id);
      setBrandCapacity(await api.getBrandAddons());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrandAddonBusy(null);
    }
  }

  async function handleBuySeatAddon() {
    setSeatAddonBusy("checkout");
    setError(null);
    try {
      const { transactionId, checkoutUrl } = await api.startSeatAddonCheckout();
      if (paddle && transactionId) {
        // Same real-checkout.completed-event pattern as handleBuyBrandAddon
        // — polling starts from the eventCallback, not here, so it doesn't
        // race the customer actually entering a card.
        pendingSeatAddonRef.current = true;
        paddle.Checkout.open({ transactionId });
        return;
      }
      if (!checkoutUrl) {
        setError("Checkout couldn't start. No checkout URL was returned.");
        setSeatAddonBusy(null);
        return;
      }
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSeatAddonBusy(null);
    }
  }

  async function handleCancelSeatAddon(id: string) {
    if (!window.confirm("Cancel this seat add-on? You'll lose the extra team seat at the end of the billing period.")) {
      return;
    }
    setSeatAddonBusy(id);
    setError(null);
    try {
      await api.cancelSeatAddon(id);
      setSeatCapacity(await api.getSeatAddons());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSeatAddonBusy(null);
    }
  }

  async function handleSaveBusinessName(e: FormEvent) {
    e.preventDefault();
    setSavingBusinessName(true);
    setError(null);
    try {
      const updated = await api.updateAccount(businessNameInput.trim() || null);
      setAccount(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBusinessName(false);
    }
  }

  /** Saves the default AI-caption/hashtag voice — used whenever the account
   *  being composed for isn't linked to a brand with its own override (see
   *  the Brands manager on the Social Platforms tab for that). */
  async function handleSaveVoiceProfile(e: FormEvent) {
    e.preventDefault();
    setSavingVoiceProfile(true);
    setError(null);
    try {
      const updated = await api.setVoiceProfile(voiceProfileInput.trim() || null);
      setAccount(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingVoiceProfile(false);
    }
  }

  async function handleCreateApiKey(e: FormEvent) {
    e.preventDefault();
    if (!apiKeyName.trim()) return;
    setCreatingKey(true);
    setError(null);
    try {
      const created = await api.createApiKey(apiKeyName.trim(), apiKeyCanShareProof);
      setNewlyCreatedKey(created.key);
      setApiKeyName("");
      setApiKeyCanShareProof(false);
      const keys = await api.listApiKeys();
      setApiKeys(keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingKey(false);
    }
  }

  async function handleRevokeApiKey(id: string) {
    if (!window.confirm("Revoke this API key? Anything using it will immediately stop working.")) return;
    setRevokingKeyId(id);
    setError(null);
    try {
      await api.revokeApiKey(id);
      const keys = await api.listApiKeys();
      setApiKeys(keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingKeyId(null);
    }
  }

  async function handleInviteTeamMember(e: FormEvent) {
    e.preventDefault();
    if (!teamInviteEmail.trim()) return;
    setInvitingTeamMember(true);
    setError(null);
    try {
      await api.inviteTeamMember(teamInviteEmail.trim());
      setTeamInviteEmail("");
      const list = await api.listTeam();
      setTeam(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInvitingTeamMember(false);
    }
  }

  async function handleRemoveTeamMember(id: string, label: string) {
    if (!window.confirm(`Remove ${label} from your team?`)) return;
    setRemovingTeamMemberId(id);
    setError(null);
    try {
      await api.removeTeamMember(id);
      const list = await api.listTeam();
      setTeam(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingTeamMemberId(null);
    }
  }

  async function handleResendTeamInvite(id: string) {
    setResendingTeamInviteId(id);
    setError(null);
    try {
      await api.resendTeamInvite(id);
      const list = await api.listTeam();
      setTeam(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResendingTeamInviteId(null);
    }
  }

  async function handleRevokeGrant(clientId: string, clientName: string) {
    if (!window.confirm(`Disconnect ${clientName}? It will immediately lose access to your LazyRelay account.`)) return;
    setRevokingGrantClientId(clientId);
    setError(null);
    try {
      const { error: err } = await supabase.auth.oauth.revokeGrant({ clientId });
      if (err) throw err;
      const { data, error: listErr } = await supabase.auth.oauth.listGrants();
      if (listErr) throw listErr;
      setOauthGrants(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingGrantClientId(null);
    }
  }

  async function handleToggleFailureAlerts(enabled: boolean) {
    setSavingFailureAlerts(true);
    setError(null);
    try {
      const updated = await api.setEmailFailureAlerts(enabled);
      setAccount(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingFailureAlerts(false);
    }
  }

  async function handleSaveWebhook(e: FormEvent) {
    e.preventDefault();
    setSavingWebhook(true);
    setError(null);
    try {
      const updated = await api.setWebhookUrl(webhookUrlInput.trim() || null);
      setAccount(updated);
      if (updated.webhookSecret) setRevealedWebhookSecret(updated.webhookSecret);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingWebhook(false);
    }
  }

  async function handleClearWebhook() {
    if (!window.confirm("Remove this webhook? LazyRelay will stop sending post-verified events to it.")) return;
    setSavingWebhook(true);
    setError(null);
    try {
      const updated = await api.setWebhookUrl(null);
      setAccount(updated);
      setWebhookUrlInput("");
      setRevealedWebhookSecret(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingWebhook(false);
    }
  }

  async function handleRegenerateWebhookSecret() {
    if (!window.confirm("Generate a new webhook secret? The old one will stop verifying immediately.")) return;
    setRegeneratingWebhookSecret(true);
    setError(null);
    try {
      const { webhookSecret } = await api.regenerateWebhookSecret();
      setRevealedWebhookSecret(webhookSecret);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegeneratingWebhookSecret(false);
    }
  }

  async function handleConnectGoogleCalendar() {
    setGcalConnecting(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.startGoogleCalendarConnect();
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGcalConnecting(false);
    }
  }

  async function handleDisconnectGoogleCalendar() {
    if (!window.confirm("Disconnect Google Calendar? LazyRelay will stop syncing posts to it. Your LazyRelay Posts calendar and its events stay on your Google account either way.")) return;
    setGcalDisconnecting(true);
    setError(null);
    try {
      await api.disconnectGoogleCalendar();
      setGcalStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGcalDisconnecting(false);
    }
  }

  async function handleConnectGoogleSheets() {
    setGsheetConnecting(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.startGoogleSheetsConnect();
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGsheetConnecting(false);
    }
  }

  async function handleDisconnectGoogleSheets() {
    if (!window.confirm("Disconnect Google Sheets? LazyRelay will stop updating the spreadsheet. The spreadsheet itself stays in your Google Drive either way.")) return;
    setGsheetDisconnecting(true);
    setError(null);
    try {
      await api.disconnectGoogleSheets();
      setGsheetStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGsheetDisconnecting(false);
    }
  }

  async function handleStartMfaEnrollment() {
    setMfaEnrolling(true);
    setError(null);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) throw error;
      setMfaEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
      setMfaVerifyCode("");
      setMfaVerified(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMfaEnrolling(false);
    }
  }

  function handleCancelMfaEnrollment() {
    // Deliberately doesn't call unenroll() on the still-unverified factor
    // this created server-side — it's harmless (listFactors()/the gate in
    // App.tsx only ever look at verified factors) and enroll() can simply
    // be called again later, same as abandoning an API key creation form.
    setMfaEnrollment(null);
    setMfaVerifyCode("");
    setMfaVerified(false);
    // Clears the reveal-once codes out of memory once the customer has
    // clicked past them -- they were never retrievable from the server
    // again anyway, this just matches that in the UI state too.
    setMfaRecoveryCodes(null);
  }

  async function handleConfirmMfaEnrollment(e: FormEvent) {
    e.preventDefault();
    if (!mfaEnrollment) return;
    setMfaVerifying(true);
    setError(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: mfaEnrollment.factorId });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaEnrollment.factorId,
        challengeId: challenge.id,
        code: mfaVerifyCode,
      });
      if (verifyError) throw verifyError;
      setMfaFactorId(mfaEnrollment.factorId);
      setMfaVerified(true);
      // Best-effort, in its own try/catch -- MFA itself is already enabled
      // at this point (the verify() above is what matters), so a recovery
      // -code generation hiccup shouldn't read as the whole enrollment
      // having failed. The "Regenerate recovery codes" button below covers
      // the customer if this call happens to fail.
      try {
        const { codes } = await api.generateMfaRecoveryCodes();
        setMfaRecoveryCodes(codes);
      } catch (codesErr) {
        setError(codesErr instanceof Error ? codesErr.message : String(codesErr));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMfaVerifying(false);
    }
  }

  async function handleRemoveMfa() {
    if (!mfaFactorId) return;
    if (!window.confirm("Remove two-factor authentication? You'll only need your password to sign in after this.")) return;
    setMfaUnenrolling(true);
    setError(null);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: mfaFactorId });
      if (error) throw error;
      setMfaFactorId(null);
      // Recovery codes exist to recover this factor -- once it's gone
      // there's nothing left for them to unlock, so clear any still-
      // displayed set. (The backend does the equivalent DB-side cleanup
      // when a code is redeemed instead of removed here in Settings.)
      setMfaRecoveryCodes(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMfaUnenrolling(false);
    }
  }

  async function handleGenerateMfaRecoveryCodes(isRegenerate: boolean) {
    if (
      isRegenerate &&
      !window.confirm("Regenerate recovery codes? Your existing codes will stop working immediately.")
    ) {
      return;
    }
    setMfaGeneratingRecoveryCodes(true);
    setError(null);
    try {
      const { codes } = await api.generateMfaRecoveryCodes();
      setMfaRecoveryCodes(codes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMfaGeneratingRecoveryCodes(false);
    }
  }

  async function handleShareProof(postId: string) {
    if (
      !window.confirm(
        "This creates a public link. Anyone with it can view this post's content, even without a LazyRelay account. Continue?"
      )
    ) {
      return;
    }
    setSharingProofId(postId);
    setError(null);
    try {
      const { url } = await api.getProofLink(postId);
      try {
        await navigator.clipboard.writeText(url);
        setShareProofResult({ postId, url, copied: true });
      } catch {
        // Same real-failure handling as CodeBlock's copy button — clipboard
        // writes can genuinely reject, show the link instead of going silent.
        setShareProofResult({ postId, url, copied: false });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharingProofId(null);
    }
  }

  async function handleAnnounceAdminAction() {
    setAnnouncingAdmin(true);
    setError(null);
    try {
      const result = await api.announceAdminAction();
      setAdminWindowExpiresAt(result.expiresAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnnouncingAdmin(false);
    }
  }

  async function handleReplyToComment(postId: string, commentId: string) {
    const text = replyDrafts[commentId]?.trim();
    if (!text) return;
    setReplyingCommentId(commentId);
    setError(null);
    try {
      await api.replyToMention(postId, commentId, text);
      setReplyDrafts((prev) => {
        const next = { ...prev };
        delete next[commentId];
        return next;
      });
      setReplySentCommentId(commentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplyingCommentId(null);
    }
  }

  async function handleOpenConversation(conversation: DMConversation) {
    setOpenConversation(conversation);
    setDmMessages(null);
    setDmDraft("");
    setDmMessagesLoading(true);
    setError(null);
    try {
      const res = await api.getDMMessages(conversation.socialAccountId, conversation.conversationId);
      setDmMessages(res.messages);
      if (res.errorMessage) setError(res.errorMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDmMessagesLoading(false);
    }
  }

  async function handleSendDM() {
    if (!openConversation || !dmDraft.trim()) return;
    setDmSending(true);
    setError(null);
    try {
      await api.replyToDM(openConversation.socialAccountId, openConversation.participantId, dmDraft.trim());
      const res = await api.getDMMessages(openConversation.socialAccountId, openConversation.conversationId);
      setDmMessages(res.messages);
      setDmDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDmSending(false);
    }
  }

  async function handleCreateAutomation(e: FormEvent) {
    e.preventDefault();
    if (!automationSocialAccountId || !automationMessage.trim()) return;
    setCreatingAutomation(true);
    setError(null);
    try {
      await api.createDMAutomation(automationSocialAccountId, automationKeyword.trim(), automationMessage.trim());
      setAutomationKeyword("");
      setAutomationMessage("");
      const list = await api.listDMAutomations();
      setDmAutomations(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingAutomation(false);
    }
  }

  async function handleDeleteAutomation(id: string) {
    if (!window.confirm("Delete this automation? It will stop sending DMs immediately.")) return;
    setDeletingAutomationId(id);
    setError(null);
    try {
      await api.deleteDMAutomation(id);
      const list = await api.listDMAutomations();
      setDmAutomations(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingAutomationId(null);
    }
  }

  async function handleConfirmCancelSubscription() {
    if (!cancelDataDeletionAck) return;
    setBillingBusy("cancel");
    setError(null);
    try {
      await api.cancelSubscription(cancelFeedback, cancelDataDeletionAck);
      setShowCancelModal(false);
      setCancelFeedback("");
      setCancelDataDeletionAck(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBillingBusy(null);
    }
  }

  // The plan/billing values below were computed after the `if (loading)`
  // early return in the original Dashboard body. They're pure derivations
  // of `subscription` (optional-chained, no side effects), so computing them
  // here unconditionally yields the same values the tabs/shell saw before.

  const tierNames = {
    free: "Free",
    pro: "Starter",
    business: "Pro",
    enterprise: "Business",
    agency: "Agency",
    agency_plus: "Agency Plus",
  } as const;
  const currentTier = subscription?.tier ?? "free";
  const isFreePlan = currentTier === "free";
  // A cancellation is deferred to the end of the paid period (backend
  // migration 0043) — `status` only flips to "cancelled" once that real
  // period-end cancellation actually lands via webhook, so a customer who
  // just clicked cancel is still "active"/"trialing" with cancelAtPeriodEnd
  // true. Kept as two distinct states, not one: showing "cancelling: ends
  // <date>" for an already-fully-lapsed plan reads as a live countdown for
  // something that's already over (found live 2026-08-11, next to
  // "Resubscribe" buttons that only appear once truly lapsed — the two
  // together read as contradictory).
  const isPendingCancellation = !isFreePlan && subscription?.cancelAtPeriodEnd === true;
  const isLapsedCancelled = !isFreePlan && subscription?.status === "cancelled";
  const isFreeOrLapsed = isFreePlan || isLapsedCancelled || isPendingCancellation;
  const periodEndDate = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;

  return {
    signOut,
    session,
    mediaInputRef,
    coverImageInputRef,
    accounts,
    platforms,
    posts,
    setPosts,
    subscription,
    storageUsage,
    mediaFiles,
    mediaBusyId,
    disconnectingAccountId,
    pendingSelection,
    checkedOptionIds,
    setCheckedOptionIds,
    selectionBusy,
    storageAddons,
    addonBusy,
    account,
    businessNameInput,
    setBusinessNameInput,
    savingBusinessName,
    voiceProfileInput,
    setVoiceProfileInput,
    savingVoiceProfile,
    apiKeys,
    apiKeyName,
    setApiKeyName,
    apiKeyCanShareProof,
    setApiKeyCanShareProof,
    creatingKey,
    newlyCreatedKey,
    setNewlyCreatedKey,
    revokingKeyId,
    showRevokedKeys,
    setShowRevokedKeys,
    oauthGrants,
    oauthGrantsLoading,
    team,
    teamInviteEmail,
    setTeamInviteEmail,
    invitingTeamMember,
    removingTeamMemberId,
    resendingTeamInviteId,
    revokingGrantClientId,
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
    sharingProofId,
    shareProofResult,
    loading,
    error,
    setError,
    notice,
    tab,
    setTab,
    runTour,
    setRunTour,
    showGcalPrompt,
    brandFilter,
    setBrandFilter,
    brands,
    newBrandName,
    setNewBrandName,
    brandBusy,
    brandVoiceDrafts,
    setBrandVoiceDrafts,
    brandVoiceBusyId,
    assigningAccountId,
    brandCapacity,
    seatCapacity,
    brandAddonBusy,
    seatAddonBusy,
    moreMenuOpen,
    setMoreMenuOpen,
    moreMenuRef,
    billingBusy,
    showAgencyBilling,
    setShowAgencyBilling,
    pendingTierChange,
    setPendingTierChange,
    showCancelModal,
    setShowCancelModal,
    cancelFeedback,
    setCancelFeedback,
    cancelDataDeletionAck,
    setCancelDataDeletionAck,
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
    mediaAltTextDrafts,
    setMediaAltTextDrafts,
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
    connectingPlatform,
    showPinterestConnectModal,
    setShowPinterestConnectModal,
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
    calendarMonth,
    setCalendarMonth,
    selectedDay,
    setSelectedDay,
    billingSectionRef,
    setScrollToBillingPending,
    handleTourFinish,
    dismissGcalPrompt,
    calendarViewMode,
    setCalendarViewMode,
    calendarWeekStart,
    setCalendarWeekStart,
    isMobile,
    dayPopoverAnchor,
    setDayPopoverAnchor,
    eventPopover,
    eventPopoverPanel,
    setEventPopoverPanel,
    calendarSearch,
    setCalendarSearch,
    createMenuOpen,
    setCreateMenuOpen,
    syncedOnlyFilter,
    setSyncedOnlyFilter,
    openDayPopover,
    openEventPopover,
    closeEventPopover,
    handleReschedulePostTo,
    handleDuplicatePostTo,
    planContent,
    setPlanContent,
    planMediaUrl,
    planMediaUploading,
    planBusy,
    planAccountIds,
    planTime,
    setPlanTime,
    promotingPlanId,
    mentions,
    mentionsLoading,
    mentionsAttentionOnly,
    setMentionsAttentionOnly,
    replyDrafts,
    setReplyDrafts,
    replyingCommentId,
    replySentCommentId,
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
    bioPage,
    bioLoading,
    bioSaving,
    bioSlug,
    setBioSlug,
    bioTitle,
    setBioTitle,
    bioBio,
    setBioBio,
    bioLinkLabel,
    setBioLinkLabel,
    bioLinkUrl,
    setBioLinkUrl,
    bioLinkBusy,
    analytics,
    analyticsLoading,
    analyticsRangeDays,
    setAnalyticsRangeDays,
    insightLoading,
    insightResult,
    finalizingUpgrade,
    handleFinalizeSelection,
    selectedPinterestAccountId,
    handleConnect,
    handleDisconnectAccount,
    handleCreateBrand,
    handleDeleteBrand,
    handleSaveBrandVoice,
    handleAssignBrand,
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
    handleGetInsight,
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
    handleDeleteMedia,
    handleSaveMediaAltText,
    handleMediaDrop,
    handleSaveBioPage,
    handleAddBioLink,
    handleDeleteBioLink,
    handleApprove,
    handleReschedulePost,
    handlePostExistingNow,
    handleTogglePause,
    handleDuplicatePost,
    handlePlanMediaFile,
    togglePlanAccount,
    handleAddPlanItem,
    handlePromotePlanItem,
    handleDelete,
    handleCsvFile,
    handleBulkImport,
    handleUpgrade,
    handleChangeTier,
    handleBuyStorageAddon,
    handleCancelStorageAddon,
    handleBuyBrandAddon,
    handleCancelBrandAddon,
    handleBuySeatAddon,
    handleCancelSeatAddon,
    handleSaveBusinessName,
    handleSaveVoiceProfile,
    handleCreateApiKey,
    handleRevokeApiKey,
    handleInviteTeamMember,
    handleRemoveTeamMember,
    handleResendTeamInvite,
    handleRevokeGrant,
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
    handleShareProof,
    handleAnnounceAdminAction,
    handleReplyToComment,
    handleOpenConversation,
    handleSendDM,
    handleCreateAutomation,
    handleDeleteAutomation,
    handleConfirmCancelSubscription,
    tierNames,
    currentTier,
    isFreePlan,
    isPendingCancellation,
    isLapsedCancelled,
    isFreeOrLapsed,
    periodEndDate,
  };
}
