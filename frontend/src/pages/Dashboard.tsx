import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import type { OAuthGrant } from "@supabase/supabase-js";
import { describeScopes } from "../lib/oauthScopes";
import { api, type SocialAccount, type Brand, type BrandCapacity, type ScheduledPost, type Subscription, type StorageUsage, type MediaFile, type StorageAddon, type PlatformInfo, type Account, type ApiKey, type RecurringSchedule, type AnalyticsSummary, type BioPage, type MentionPost, type DMConversation, type DMMessage, type DMAutomation, type Triage, type TeamMember, type SeatCapacity } from "../lib/api";
import { API_BASE_URL, API_ENDPOINTS, MCP_CONFIG_EXAMPLE, HOSTED_MCP_URL, HOSTED_MCP_REMOTE_CONFIG_EXAMPLE, MCP_TOOLS } from "../lib/apiDocsContent";
import { CodeBlock } from "../components/CodeBlock";
import { RelaySignal } from "../components/RelaySignal";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import { AccountPicker, AccountGroupList } from "../components/AccountPicker";
import { MediaStorageList } from "../components/MediaStorageList";
import { NotificationBell } from "../components/NotificationBell";
import { formatBytes } from "../lib/format";
import { bestTimeFor } from "../lib/bestTimes";
import { Spinner } from "../components/Spinner";
import { OverviewPanel } from "../components/Charts";
import { CircuitBackground } from "../components/CircuitBackground";
import { SupportWidget } from "../components/SupportWidget";
import { PostErrorDetail } from "../components/PostErrorDetail";

// Settings (2026-08-17, Werner) consolidates the three former separate tabs
// "Storage"/"Account"/"Billing" into one -- all three sections still exist
// unchanged, they just all render together under tab === "Settings" now
// instead of three separate dropdown entries. Settings and API Keys both
// promoted to the always-visible top bar, leaving only the four
// content/engagement tabs behind "More".
const TABS = ["Overview", "Posts", "Calendar", "Analytics", "Mentions", "DMs", "Bio Page", "Social Platforms", "Settings", "API Keys"] as const;
type Tab = (typeof TABS)[number];
const MAIN_TABS: Tab[] = ["Overview", "Posts", "Calendar", "Social Platforms", "API Keys", "Settings"];
const MORE_TABS: Tab[] = ["Analytics", "Mentions", "DMs", "Bio Page"];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Multi-brand filtering (2026-08-08) — matches the backend's
// UNBRANDED_FILTER_VALUE sentinel in routes.ts, used wherever a customer
// filters Overview/Posts/Calendar/Mentions/DMs/Analytics down to accounts
// that have no brand label set yet.
const UNBRANDED_FILTER_VALUE = "__unbranded__";

// Display-only mirror of the backend's BRAND_LIMITS (brandLimits.ts), which is
// the real enforcer. Used to show "N/cap" and pre-disable the create control;
// the server still rejects an over-cap create regardless of this.
const BRAND_LIMITS_DISPLAY: Record<string, number> = { free: 1, pro: 2, business: 4, enterprise: 7 };
function brandCapFor(tier: string | undefined): number {
  return BRAND_LIMITS_DISPLAY[tier ?? "free"] ?? 1;
}

function localDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TRIAGE_CATEGORY_LABELS: Record<string, string> = {
  angry_customer: "Angry customer",
  sales_question: "Sales question",
  question: "Question",
};

function TriageBadge({ triage }: { triage?: Triage | null }) {
  if (!triage?.needsAttention) return null;
  return (
    <span className="triage-badge" title={triage.reason}>
      {TRIAGE_CATEGORY_LABELS[triage.category] ?? "Needs attention"}
    </span>
  );
}

// Multi-brand filtering (2026-08-08) — one shared dropdown, rendered in
// every view a brand filter applies to (Overview, Posts, Calendar,
// Analytics, Mentions, DMs), all bound to the same brandFilter state so
// switching tabs doesn't lose the customer's current filter. Hidden
// entirely when there's nothing to filter by (0-1 connected accounts, or
// every account shares one unlabeled bucket) rather than showing a
// single-option dropdown that does nothing.
function BrandFilterSelect({ accounts, value, onChange }: { accounts: SocialAccount[]; value: string; onChange: (v: string) => void }) {
  const labels = [...new Set(accounts.map((a) => a.brand_label?.trim()).filter((l): l is string => !!l))].sort();
  const hasUnbranded = accounts.some((a) => !a.brand_label?.trim());
  if (labels.length === 0) return null;
  return (
    <select className="brand-filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All brands</option>
      {labels.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
      {hasUnbranded && <option value={UNBRANDED_FILTER_VALUE}>Unbranded</option>}
    </select>
  );
}

function accountMatchesBrand(account: SocialAccount | undefined, brandFilter: string): boolean {
  if (!brandFilter) return true;
  if (!account) return false;
  const label = account.brand_label?.trim();
  if (brandFilter === UNBRANDED_FILTER_VALUE) return !label;
  return label === brandFilter;
}

// Minimal RFC4180-ish CSV parser — handles quoted fields, escaped ""
// quotes, and commas/newlines inside quotes. No external dependency for
// something this small; a customer's exported CSV (Sheets/Excel) is the
// realistic input shape this needs to survive, not arbitrary CSV exotica.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

// Read once at module scope (not inside the component) — React 18
// StrictMode double-mounts components in dev, and a component-scoped
// effect that reads-then-strips the URL loses the value on the second
// mount, since the window was already mutated by the first. Module
// evaluation only happens once per page load regardless of StrictMode.
function readAndClearConnectParams(): {
  connectError: string | null;
  connected: boolean;
  selectAccount: string | null;
  prefillContent: string | null;
  prefillMediaUrl: string | null;
} {
  const params = new URLSearchParams(window.location.search);
  const connectError = params.get("connectError");
  const connected = params.get("connected") !== null;
  // Set when a connect has more than one real Page/account to choose from
  // (Facebook: multiple Pages; Instagram: whichever Page has a Business
  // Account linked) — see backend/src/platforms/connect.ts. Holds the
  // one-time selection token used to fetch and finalize the choice.
  const selectAccount = params.get("selectAccount");
  // Set by the browser extension's context-menu actions (see
  // browser-extension/background.js) — opens lazyrelay.com with one of
  // these params so the customer lands straight in the compose form
  // instead of having to copy/paste the URL themselves.
  const prefillContent = params.get("prefillContent");
  const prefillMediaUrl = params.get("prefillMediaUrl");
  if (connectError || connected || selectAccount || prefillContent || prefillMediaUrl) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return { connectError, connected, selectAccount, prefillContent, prefillMediaUrl };
}
const connectParams = readAndClearConnectParams();

export function Dashboard() {
  const { signOut, session } = useAuth();
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const coverImageInputRef = useRef<HTMLInputElement>(null);
  // refresh() re-fetches the account on every call (including after
  // unrelated actions like scheduling a post) — only seed the business-name
  // input from the server once, so it never clobbers text the user is
  // actively typing into the Settings field.
  const businessNameSeeded = useRef(false);
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
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeyCanShareProof, setApiKeyCanShareProof] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
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
  const [sharingProofId, setSharingProofId] = useState<string | null>(null);
  const [shareProofResult, setShareProofResult] = useState<{ postId: string; url: string; copied: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [brandFilter, setBrandFilter] = useState("");
  const [brands, setBrands] = useState<Brand[]>([]);
  const [newBrandName, setNewBrandName] = useState("");
  const [brandBusy, setBrandBusy] = useState(false);
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
  const [billingBusy, setBillingBusy] = useState<"pro" | "business" | "enterprise" | "cancel" | null>(null);
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
  // Pinterest's own "Destination Link" -- where a click on the Pin takes
  // someone, distinct from the image/video itself. Found completely missing
  // in a 2026-08-19 security review: the compose form never had a field for
  // it at all, so every Pin's destination link was silently blank.
  const [destinationLink, setDestinationLink] = useState<string | null>(null);
  const [firstComment, setFirstComment] = useState<string | null>(null);
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
  // The Calendar tab's own "add a plan for this day" mini-form — deliberately
  // separate from the big Posts-tab compose state (content/mediaUrl etc.),
  // since a planned idea isn't the same thing as a post being composed.
  const [planContent, setPlanContent] = useState("");
  const [planMediaUrl, setPlanMediaUrl] = useState<string | null>(null);
  const [planMediaUploading, setPlanMediaUploading] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
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
  const pendingTierRef = useRef<"pro" | "business" | "enterprise" | null>(null);
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
      const { caption } = await api.generateCaption(aiTopic.trim(), firstAccount?.platform);
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
      const { hashtags } = await api.suggestHashtags(content.trim(), firstAccount?.platform);
      if (hashtags.length > 0) {
        setContent((prev) => `${prev.trim()}\n\n${hashtags.join(" ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setHashtagGenerating(false);
    }
  }

  async function submitPost(scheduledForIso: string, requiresApprovalOverride = requiresApproval) {
    if (selectedAccountIds.length === 0) {
      setError("Select at least one connected account to post to.");
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

  /** Saves a note/idea for a specific calendar day — a draft anchored to
   *  that day (migration 0059), not yet a real scheduled post. "Add to
   *  scheduler" (below) is what turns it into one. */
  async function handleAddPlanItem(day: string) {
    if (!planContent.trim()) {
      setError("Write something before adding it to the planner.");
      return;
    }
    setPlanBusy(true);
    setError(null);
    try {
      await api.saveDraft({ content: planContent, mediaUrl: planMediaUrl ?? undefined, plannedDate: day });
      setPlanContent("");
      setPlanMediaUrl(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  /** "Add to scheduler" for a planned item — loads it into the Posts tab's
   *  normal compose form (same path a customer already uses to finish any
   *  draft) and switches there, so picking the account and exact time still
   *  goes through the one, already-tested promotion flow rather than a
   *  second one built just for the Calendar. */
  function handlePromotePlanItem(p: ScheduledPost) {
    handleEditDraft(p);
    setTab("Posts");
  }

  async function handleDelete(id: string, isHistory: boolean) {
    if (isHistory && !window.confirm("Delete this post from history? This can't be undone.")) return;
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

  if (loading) {
    return (
      <div className="loading">
        <Spinner />
      </div>
    );
  }

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

  return (
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
            <button className="plan-banner-cta" onClick={() => setTab("Settings")}>
              {isPendingCancellation || isLapsedCancelled ? "Resubscribe" : "Upgrade"}
            </button>
          )}
        </div>
      </div>
      <div className="dashboard">
      <header>
        <div className="wordmark">
          <BrandMark size={30} />
          <span>{account?.businessName ? `Welcome, ${account.businessName}` : "LazyRelay"}</span>
        </div>
        <div className="header-actions">
          <NotificationBell onOpenTab={setTab} />
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
              {MORE_TABS.map((t) => (
                <button
                  key={t}
                  className={t === tab ? "tab-active" : ""}
                  onClick={() => {
                    setTab(t);
                    setMoreMenuOpen(false);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      </nav>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {tab === "Analytics" && (
      <section>
        <h2>Analytics</h2>
        <div className="analytics-range">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              className={d === analyticsRangeDays ? "tab-active" : ""}
              onClick={() => setAnalyticsRangeDays(d)}
            >
              Last {d} days
            </button>
          ))}
        </div>
        <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
        {analyticsLoading && <Spinner />}
        {!analyticsLoading && analytics && analytics.totalPosts === 0 && (
          <p className="empty">No posts scheduled in this range yet. Analytics fill in once posts go out.</p>
        )}
        {!analyticsLoading && analytics && analytics.totalPosts > 0 && (
          <>
            <div className="analytics-insight-row">
              <button type="button" className="btn-outline" disabled={insightLoading} onClick={handleGetInsight}>
                {insightLoading ? "Thinking..." : "Get AI insight: why this worked"}
              </button>
            </div>
            {insightResult && "insufficientData" in insightResult && (
              <p className="section-note">
                Not enough engagement data yet for a real insight ({insightResult.postsWithData} post
                {insightResult.postsWithData === 1 ? "" : "s"} with data, need at least {insightResult.needed}).
                Check back once more posts have had time to collect engagement numbers.
              </p>
            )}
            {insightResult && "insight" in insightResult && <p className="analytics-insight-card">{insightResult.insight}</p>}
            <div className="analytics-summary-cards">
              <div className="analytics-card">
                <span className="analytics-card-value">{analytics.totalPosts}</span>
                <span className="analytics-card-label">Total posts</span>
              </div>
              <div className="analytics-card">
                <span className="analytics-card-value">{analytics.byStatus.posted ?? 0}</span>
                <span className="analytics-card-label">Posted</span>
              </div>
              <div className="analytics-card">
                <span className="analytics-card-value">{analytics.byStatus.failed ?? 0}</span>
                <span className="analytics-card-label">Failed</span>
              </div>
              <div className="analytics-card">
                <span className="analytics-card-value">
                  {analytics.verifiedLiveRate === null ? "—" : `${Math.round(analytics.verifiedLiveRate * 100)}%`}
                </span>
                <span className="analytics-card-label">Verified live</span>
              </div>
            </div>

            <h3>By platform</h3>
            <p className="muted">
              Likes/comments/shares/views are only readable today on Facebook, Instagram, Mastodon, Bluesky, X, and
              YouTube. Every other platform shows "—", not a zero, since LazyRelay has no read access there yet.
            </p>
            <div className="table-scroll">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Total</th>
                  <th>Posted</th>
                  <th>Failed</th>
                  <th>Verified live</th>
                  <th>Likes</th>
                  <th>Comments</th>
                  <th>Shares</th>
                  <th>Views</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(analytics.byPlatform)
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([platform, stats]) => {
                    const eng = analytics.engagement[platform];
                    // The backend sums each post's most-mature checkpoint,
                    // collapsing "this platform never returns shares" and
                    // "these posts genuinely got 0 shares" into the same
                    // number — a real gap in the aggregate response, not
                    // something to guess at from the number itself. Each
                    // adapter's actual field support is known exactly
                    // (written today, see backend/src/platforms/*.ts), so
                    // that's used directly instead of inferring from data.
                    const supportsShares = ["facebook", "mastodon", "bluesky", "x"].includes(platform);
                    const supportsViews = ["x", "youtube"].includes(platform);
                    return (
                      <tr key={platform}>
                        <td>
                          <span className="platform-badge">
                            <PlatformIcon platform={platform} size={13} />
                            {platform}
                          </span>
                        </td>
                        <td>{stats.total}</td>
                        <td>{stats.posted}</td>
                        <td>{stats.failed}</td>
                        <td>{stats.verifiedLive}</td>
                        <td>{eng ? eng.likes : "—"}</td>
                        <td>{eng ? eng.comments : "—"}</td>
                        <td>{eng && supportsShares ? eng.shares : "—"}</td>
                        <td>{eng && supportsViews ? eng.views : "—"}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            </div>

            <h3>Daily volume</h3>
            <div className="analytics-bars">
              {Object.entries(analytics.dailyCounts)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([day, count]) => {
                  const max = Math.max(...Object.values(analytics.dailyCounts), 1);
                  return (
                    <div key={day} className="analytics-bar-col" title={`${day}: ${count} post${count === 1 ? "" : "s"}`}>
                      <span className="analytics-bar-value">{count}</span>
                      <div className="analytics-bar" style={{ height: `${(count / max) * 100}%` }} />
                      <span className="analytics-bar-label">{day.slice(5)}</span>
                    </div>
                  );
                })}
            </div>

            <h3>Audience growth</h3>
            {(!analytics.audienceGrowth || Object.keys(analytics.audienceGrowth).length === 0) ? (
              <p className="muted">
                No follower-count history yet — this fills in daily once your Mastodon, Bluesky, or YouTube
                accounts have been connected a day or more. Other platforms don't support this yet.
              </p>
            ) : (
              <>
                <p className="muted">
                  Follower count over time. Only readable today on Mastodon, Bluesky, and YouTube — every other
                  platform is absent from this table, not shown as zero, since LazyRelay has no read access
                  there yet.
                </p>
                <div className="table-scroll">
                  <table className="analytics-table">
                    <thead>
                      <tr>
                        <th>Platform</th>
                        <th>Current followers</th>
                        <th>Change over range</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(analytics.audienceGrowth)
                        .sort((a, b) => {
                          const aLatest = a[1].trend[a[1].trend.length - 1]?.followerCount ?? 0;
                          const bLatest = b[1].trend[b[1].trend.length - 1]?.followerCount ?? 0;
                          return bLatest - aLatest;
                        })
                        .map(([platform, growth]) => {
                          const latest = growth.trend[growth.trend.length - 1]?.followerCount;
                          return (
                            <tr key={platform}>
                              <td>
                                <span className="platform-badge">
                                  <PlatformIcon platform={platform} size={13} />
                                  {platform}
                                </span>
                              </td>
                              <td>{latest ?? "—"}</td>
                              <td>
                                {growth.netChange === null
                                  ? "—"
                                  : growth.netChange > 0
                                    ? `+${growth.netChange}`
                                    : growth.netChange}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
      )}

      {tab === "Mentions" && (
      <section>
        <h2>Mentions &amp; comments</h2>
        <p className="muted">
          Comments on your recent posts, pulled directly from each platform. Facebook, Instagram, Mastodon,
          Bluesky, and YouTube support this today, with reply-from-here on Facebook, Instagram, Mastodon, and
          Bluesky. Every other platform's comments still live on the platform itself, not here yet.
        </p>
        {mentionsLoading && <Spinner />}
        {!mentionsLoading && mentions && mentions.length === 0 && <p className="empty">No recent posted content yet.</p>}
        {!mentionsLoading && mentions && mentions.length > 0 && (() => {
          const attentionCount = mentions.reduce((sum, p) => sum + p.comments.filter((c) => c.triage?.needsAttention).length, 0);
          const brandFilteredMentions = mentions.filter((p) => accountMatchesBrand(accounts.find((a) => a.id === p.socialAccountId), brandFilter));
          const visiblePosts = mentionsAttentionOnly
            ? brandFilteredMentions.map((p) => ({ ...p, comments: p.comments.filter((c) => c.triage?.needsAttention) })).filter((p) => p.comments.length > 0)
            : brandFilteredMentions;

          // Same date-grouped pattern as the Posts tab's History list
          // (2026-08-07, Werner: "must do the same here") — a flat list
          // gets unmanageable the same way once there are more than a
          // handful of posts.
          const groups = new Map<string, MentionPost[]>();
          for (const post of visiblePosts) {
            const key = localDateKey(post.scheduledFor);
            (groups.get(key) ?? groups.set(key, []).get(key)!).push(post);
          }
          const sortedKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));
          return (
          <>
            <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
            <label className="triage-filter">
              <input type="checkbox" checked={mentionsAttentionOnly} onChange={(e) => setMentionsAttentionOnly(e.target.checked)} />
              {attentionCount > 0 ? `Show only the ${attentionCount} that need attention` : "Show only comments that need attention"}
            </label>
            {visiblePosts.length === 0 && <p className="empty">Nothing to show for this filter right now.</p>}
            {sortedKeys.map((key, i) => {
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
                  {label}
                  <span className="post-date-group-count">
                    {posts.length} post{posts.length === 1 ? "" : "s"}
                  </span>
                </summary>
                <ul className="mentions-list">
                  {posts.map((post) => (
                    <li key={post.postId} className="mentions-post">
                      <div className="post-platform">
                        <PlatformIcon platform={post.platform} size={14} />
                        {post.platform}
                        {post.platformPostUrl && (
                          <a href={post.platformPostUrl} target="_blank" rel="noopener noreferrer" className="mentions-view-link">
                            View post
                          </a>
                        )}
                      </div>
                      <div className="post-content">{post.content}</div>
                      {!post.supported && <p className="mentions-unsupported">Comments aren't available for this platform yet.</p>}
                      {post.supported && post.errorMessage && <p className="mentions-unsupported">{post.errorMessage}</p>}
                      {post.supported && post.comments.length === 0 && !post.errorMessage && (
                        <p className="mentions-empty">No comments yet.</p>
                      )}
                      {post.comments.length > 0 && (
                        <ul className="mentions-comment-list">
                          {post.comments.map((c) => (
                            <li key={c.id}>
                              <span className="mentions-comment-author">{c.author}</span>
                              <span className="mentions-comment-text">{c.text}</span>
                              <TriageBadge triage={c.triage} />
                              {post.canReply && (
                                replySentCommentId === c.id ? (
                                  <span className="mentions-reply-sent">Reply sent</span>
                                ) : (
                                  <form
                                    className="mentions-reply-form"
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      handleReplyToComment(post.postId, c.id);
                                    }}
                                  >
                                    <input
                                      type="text"
                                      placeholder="Write a reply..."
                                      value={replyDrafts[c.id] ?? ""}
                                      onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                      maxLength={2000}
                                    />
                                    <button type="submit" disabled={replyingCommentId === c.id || !replyDrafts[c.id]?.trim()}>
                                      {replyingCommentId === c.id ? "Sending..." : "Reply"}
                                    </button>
                                  </form>
                                )
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            );
            })}
          </>
          );
        })()}
      </section>
      )}

      {tab === "DMs" && (
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

      {tab === "DMs" && (
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

      {tab === "Bio Page" && (
      <section>
        <h2>Link-in-bio page</h2>
        {bioLoading ? (
          <Spinner />
        ) : (
          <>
            <p className="muted">
              A public page for your Instagram/TikTok bio link. Customers land here and see the links you choose.
            </p>
            <form onSubmit={handleSaveBioPage} className="schedule-form">
              <label>
                Page URL
                <input
                  type="text"
                  value={bioSlug}
                  onChange={(e) => setBioSlug(e.target.value.toLowerCase())}
                  placeholder="your-name"
                  pattern="[a-z0-9-]{3,40}"
                  required
                />
              </label>
              {bioSlug && (
                <p className="bio-page-editor-preview">
                  lazyrelay.com/bio/{bioSlug}
                </p>
              )}
              <label>
                Title
                <input type="text" value={bioTitle} onChange={(e) => setBioTitle(e.target.value)} maxLength={100} />
              </label>
              <label>
                Bio
                <textarea value={bioBio} onChange={(e) => setBioBio(e.target.value)} maxLength={500} />
              </label>
              <div className="schedule-form-actions">
                <button type="submit" disabled={bioSaving}>
                  {bioSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>

            {bioPage && (
              <>
                <h3>Links</h3>
                {bioPage.links.length === 0 ? (
                  <p className="empty">No links yet. Add one below.</p>
                ) : (
                  <ul className="bio-link-list">
                    {bioPage.links.map((link) => (
                      <li key={link.id}>
                        <span className="bio-link-label">{link.label}</span>
                        <span className="bio-link-url">{link.url}</span>
                        <button className="btn-outline" onClick={() => handleDeleteBioLink(link.id)}>
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <form onSubmit={handleAddBioLink} className="bio-link-add-form">
                  <input
                    type="text"
                    placeholder="Label (e.g. Shop now)"
                    value={bioLinkLabel}
                    onChange={(e) => setBioLinkLabel(e.target.value)}
                  />
                  <input
                    type="url"
                    placeholder="https://..."
                    value={bioLinkUrl}
                    onChange={(e) => setBioLinkUrl(e.target.value)}
                  />
                  <button type="submit" className="btn-outline" disabled={bioLinkBusy}>
                    {bioLinkBusy ? "Adding..." : "Add link"}
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </section>
      )}

      {tab === "Overview" && (
        <>
          <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
          <OverviewPanel analytics={analytics} loading={analyticsLoading} />
        </>
      )}

      {tab === "Social Platforms" && (
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
                    {brands.map((b) => (
                      <li key={b.id}>
                        {b.name}
                        <button
                          type="button"
                          className="btn-outline"
                          disabled={brandBusy}
                          onClick={() => handleDeleteBrand(b.id)}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
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
                        ? "Connected: click to connect another account"
                        : undefined
                }
                onClick={() => handleConnect(p.platform)}
              >
                <PlatformIcon platform={p.platform} size={20} comingSoon={disabled} />
                <span className="platform-tile-name">{p.platform === "google-business" ? "Google Business" : p.platform}</span>
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

      {tab === "Posts" && (
      <>
      <section>
        <h2>Schedule a one-time post</h2>
        {accounts.length === 0 ? (
          <p className="empty">Connect an account first.</p>
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
            <label>
              Date
              <input
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                required
              />
            </label>
            <label>
              Time ({scheduleTimezone})
              <input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                required
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
              <button type="submit" disabled={submitting}>
                {submitting ? "Scheduling..." : "Schedule"}
              </button>
              <button type="button" className="post-now-btn" disabled={submitting} onClick={handlePostNow}>
                {submitting ? "Posting..." : "Post Now"}
              </button>
              <button type="button" className="btn-outline" disabled={draftBusy || submitting} onClick={handleSaveDraft}>
                {draftBusy ? "Saving..." : editingDraftId ? "Update draft" : "Save as draft"}
              </button>
            </div>
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
          <p className="empty">Connect an account first.</p>
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
              <div className="account-checkbox-list">
                {[
                  { label: "Mon", value: 1 },
                  { label: "Tue", value: 2 },
                  { label: "Wed", value: 3 },
                  { label: "Thu", value: 4 },
                  { label: "Fri", value: 5 },
                  { label: "Sat", value: 6 },
                  { label: "Sun", value: 7 },
                ].map((d) => (
                  <label key={d.value} className="account-checkbox">
                    <input type="checkbox" checked={rsDaysOfWeek.includes(d.value)} onChange={() => toggleRsDay(d.value)} />
                    {d.label}
                  </label>
                ))}
              </div>
            </label>
            <label>
              Time ({rsTimezone})
              <input type="time" value={rsTimeOfDay} onChange={(e) => setRsTimeOfDay(e.target.value)} required />
            </label>
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
        const upcoming = brandFiltered.filter((p) => p.status === "pending" || p.status === "posting" || p.status === "needs_approval");
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
                <ul className="post-list">{upcoming.map(renderPost)}</ul>
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
                            {label}
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
      )}

      {tab === "Calendar" && (() => {
        const year = calendarMonth.getFullYear();
        const month = calendarMonth.getMonth();
        const firstOfMonth = new Date(year, month, 1);
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const leadingBlanks = firstOfMonth.getDay();
        const todayKey = localDateKey(new Date().toISOString());

        // Only sees whatever's currently loaded in `posts` — bounded to
        // Upcoming plus the most recent History page (see
        // GET /scheduled-posts) unless the customer has clicked "Load
        // more" on the History tab. A month further back than that won't
        // show its older posted/failed posts here; acceptable for now
        // since Calendar is mainly used for near-term planning, not a
        // full historical archive.
        const postsByDay: Record<string, ScheduledPost[]> = {};
        // A draft anchored to a day via planned_date (migration 0059,
        // 2026-08-20) — a content idea for that day, not yet a real post.
        // Kept in its own map (not merged into postsByDay) so the
        // day-detail view can show "Scheduled" and "Planned" as clearly
        // separate sections rather than one ambiguous list.
        const plansByDay: Record<string, ScheduledPost[]> = {};
        for (const p of posts) {
          if (p.status === "draft") {
            // An undated draft (no planned_date) is managed from the Posts
            // tab's Upcoming list only, same as before this feature.
            if (!p.planned_date) continue;
            (plansByDay[p.planned_date] ??= []).push(p);
            continue;
          }
          if (!p.scheduled_for) continue;
          if (!accountMatchesBrand(accounts.find((a) => a.id === p.social_account_id), brandFilter)) continue;
          const key = localDateKey(p.scheduled_for);
          (postsByDay[key] ??= []).push(p);
        }

        const cells: { day: number | null; key: string | null }[] = [];
        for (let i = 0; i < leadingBlanks; i++) cells.push({ day: null, key: null });
        for (let d = 1; d <= daysInMonth; d++) {
          cells.push({ day: d, key: `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
        }

        const dayPosts = selectedDay ? (postsByDay[selectedDay] ?? []) : [];
        const dayPlans = selectedDay ? (plansByDay[selectedDay] ?? []) : [];

        // Short label for a day cell's event chip — a real scheduled post
        // shows its time + platform (the two things that actually
        // distinguish same-day posts from each other); a planned idea has
        // neither yet, so it shows a content snippet instead.
        function eventChipLabel(p: ScheduledPost): string {
          if (p.status === "draft") {
            return p.content.length > 18 ? `${p.content.slice(0, 18)}…` : p.content;
          }
          const account = accounts.find((a) => a.id === p.social_account_id);
          const time = p.scheduled_for ? new Date(p.scheduled_for).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
          return [time, account?.platform].filter(Boolean).join(" ");
        }

        return (
          <section>
            <div className="calendar-header">
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  setCalendarMonth(new Date(year, month - 1, 1));
                  setSelectedDay(null);
                }}
              >
                &larr; Prev
              </button>
              <h2>{firstOfMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  setCalendarMonth(new Date(year, month + 1, 1));
                  setSelectedDay(null);
                }}
              >
                Next &rarr;
              </button>
            </div>
            <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />

            <div className="calendar-grid">
              {WEEKDAY_LABELS.map((w) => (
                <div key={w} className="calendar-weekday">
                  {w}
                </div>
              ))}
              {cells.map((c, i) =>
                c.day === null ? (
                  <div key={`blank-${i}`} className="calendar-cell calendar-cell-blank" />
                ) : (
                  <button
                    key={c.key}
                    type="button"
                    className={`calendar-cell${c.key === todayKey ? " calendar-cell-today" : ""}${c.key === selectedDay ? " calendar-cell-selected" : ""}`}
                    onClick={() => setSelectedDay(c.key === selectedDay ? null : c.key)}
                  >
                    <span className="calendar-cell-day">{c.day}</span>
                    {c.key &&
                      (() => {
                        const dayItems = [...(postsByDay[c.key] ?? []), ...(plansByDay[c.key] ?? [])];
                        if (dayItems.length === 0) return null;
                        const shown = dayItems.slice(0, 3);
                        return (
                          <span className="calendar-cell-events">
                            {shown.map((p) => (
                              <span key={p.id} className={`calendar-event-chip calendar-event-chip-${p.status}`}>
                                {eventChipLabel(p)}
                              </span>
                            ))}
                            {dayItems.length > shown.length && (
                              <span className="calendar-cell-more">+{dayItems.length - shown.length} more</span>
                            )}
                          </span>
                        );
                      })()}
                  </button>
                ),
              )}
            </div>

            {selectedDay && (
              <div className="calendar-day-detail">
                <h3>{new Date(`${selectedDay}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h3>
                {dayPosts.length === 0 ? (
                  <p className="empty">Nothing scheduled this day.</p>
                ) : (
                  <ul className="post-list">
                    {dayPosts.map((p) => {
                      const account = accounts.find((a) => a.id === p.social_account_id);
                      const result = p.post_results?.[0];
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
                            {/* Guaranteed non-null: postsByDay (built above) already
                                skips any post with status='draft' or a null
                                scheduled_for, so every item reaching this render
                                genuinely has one — TS just can't see that guarantee
                                across the two separate loops. */}
                            {p.scheduled_for && <span>{new Date(p.scheduled_for).toLocaleTimeString()}</span>}
                            {result && (
                              result.verified_live ? (
                                <span className="verified">
                                  <RelaySignal size={14} pulsing /> Confirmed live
                                </span>
                              ) : (
                                <PostErrorDetail errorMessage={result.error_message} platform={account?.platform} />
                              )
                            )}
                            {p.status === "needs_approval" && (
                              <button className="btn-outline" disabled={approvingId === p.id} onClick={() => handleApprove(p.id)}>
                                {approvingId === p.id ? "Approving..." : "Approve"}
                              </button>
                            )}
                            {p.status !== "posting" && (
                              <button className="btn-outline" onClick={() => handleDelete(p.id, p.status !== "pending" && p.status !== "needs_approval")}>
                                {p.status === "pending" || p.status === "needs_approval" ? "Cancel" : "Delete"}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <h4 className="calendar-plans-heading">Planned</h4>
                {dayPlans.length === 0 ? (
                  <p className="empty">No planned ideas yet.</p>
                ) : (
                  <ul className="post-list">
                    {dayPlans.map((p) => (
                      <li key={p.id} className="post-status-draft">
                        {p.media_url && <img className="media-list-thumb" src={p.media_url} alt="" />}
                        <div className="post-content">{p.content}</div>
                        <div className="post-meta">
                          <label className="account-checkbox">
                            <input type="checkbox" onChange={() => handlePromotePlanItem(p)} />
                            Add to scheduler
                          </label>
                          <button className="btn-outline" onClick={() => handleDelete(p.id, false)}>
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="calendar-plan-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleAddPlanItem(selectedDay);
                  }}
                >
                  <textarea
                    placeholder="Add a note or content idea for this day..."
                    value={planContent}
                    onChange={(e) => setPlanContent(e.target.value)}
                  />
                  <div className="calendar-plan-form-actions">
                    <label className="btn-outline calendar-plan-file-label">
                      {planMediaUploading ? "Uploading..." : planMediaUrl ? "File attached" : "Attach a file"}
                      <input
                        type="file"
                        hidden
                        disabled={planMediaUploading}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handlePlanMediaFile(file);
                        }}
                      />
                    </label>
                    <button type="submit" disabled={planBusy || planMediaUploading || !planContent.trim()}>
                      {planBusy ? "Adding..." : "Add to planner"}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </section>
        );
      })()}

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
                    <img className="media-list-thumb" src={m.url} alt="" />
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

      {tab === "Settings" && (
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
      </section>
      )}

      {tab === "Settings" && (
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

      {tab === "Settings" && (
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
            <CodeBlock code={revealedWebhookSecret} />
            <button type="button" className="btn-outline" onClick={() => setRevealedWebhookSecret(null)}>
              Done
            </button>
          </div>
        )}
      </section>
      )}

      {tab === "Settings" && (() => {
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
        <h2>Team</h2>
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

      {tab === "Settings" && (
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

      {tab === "API Keys" && (
      <section>
        <h2>API keys</h2>
        <p className="section-note">
          Let your own AI agent post and schedule directly through LazyRelay's API, without a browser or a human
          login. Full reference below.
        </p>
        <a href="/docs" target="_blank" rel="noopener noreferrer" className="btn-outline api-docs-open-button">
          Open API &amp; MCP docs as its own page (to share with a developer)
        </a>
        <p className="security-notice">
          <span aria-hidden="true">⚠️</span>
          <span>
            Treat every key like a password. Anyone who has it can post, schedule, and manage this account exactly
            as you can. Never share a key or commit one to code. Revoke it immediately if you think it's leaked.
          </span>
        </p>
        {newlyCreatedKey && (
          <div className="api-key-reveal">
            <p><strong>Copy this key now</strong>, it won't be shown again.</p>
            <CodeBlock code={newlyCreatedKey} />
            <button type="button" className="btn-outline" onClick={() => setNewlyCreatedKey(null)}>
              Done
            </button>
          </div>
        )}
        <form onSubmit={handleCreateApiKey} className="api-key-form">
          <input
            type="text"
            value={apiKeyName}
            onChange={(e) => setApiKeyName(e.target.value)}
            placeholder="Key name (e.g. Posting agent)"
            maxLength={60}
          />
          <label className="api-key-share-proof-toggle">
            <input
              type="checkbox"
              checked={apiKeyCanShareProof}
              onChange={(e) => setApiKeyCanShareProof(e.target.checked)}
            />
            Allow this key to generate public proof-sharing links
          </label>
          <div className="api-key-form-submit-row">
            <button type="submit" className="btn-primary" disabled={creatingKey || !apiKeyName.trim()}>
              {creatingKey ? "Creating..." : "Create key"}
            </button>
          </div>
        </form>
        {apiKeys.length === 0 ? (
          <p className="empty">No API keys yet.</p>
        ) : (
          <ul className="media-list">
            {apiKeys.map((k) => (
              <li key={k.id}>
                <span className="media-list-meta">
                  <strong>{k.name}</strong>: {k.key_prefix}...
                  {k.revoked_at ? (
                    <span className="status-badge status-cancelled">revoked</span>
                  ) : (
                    <span className="status-badge status-active">
                      {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : "never used"}
                    </span>
                  )}
                  {k.can_share_proof && !k.revoked_at && (
                    <span className="status-badge status-active">can share proof links</span>
                  )}
                </span>
                {!k.revoked_at && (
                  <button
                    className="btn-outline"
                    onClick={() => handleRevokeApiKey(k.id)}
                    disabled={revokingKeyId !== null}
                  >
                    {revokingKeyId === k.id ? "Revoking..." : "Revoke"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {tab === "API Keys" && (
      <section>
        <h2>Connected apps</h2>
        <p className="section-note">
          Apps you've signed in and given access to via the hosted MCP server, like Claude connecting through{" "}
          <code>{HOSTED_MCP_URL}</code>. Unlike an API key above, these don't use a key you generate, they use your
          LazyRelay login directly.
        </p>
        {oauthGrantsLoading ? (
          <p className="empty">Loading…</p>
        ) : oauthGrants.length === 0 ? (
          <p className="empty">No connected apps yet.</p>
        ) : (
          <ul className="media-list">
            {oauthGrants.map((g) => (
              <li key={g.client.id}>
                <span className="media-list-meta">
                  <strong>{g.client.name}</strong>: connected {new Date(g.granted_at).toLocaleDateString()}
                  <span style={{ display: "block", fontSize: 12, color: "var(--wire)" }}>
                    Can: {describeScopes(g.scopes).join(", ")}
                  </span>
                </span>
                <button
                  className="btn-outline"
                  onClick={() => handleRevokeGrant(g.client.id, g.client.name)}
                  disabled={revokingGrantClientId !== null}
                >
                  {revokingGrantClientId === g.client.id ? "Disconnecting..." : "Disconnect"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {tab === "API Keys" && (
      <section>
        <h2>API reference</h2>
        <p className="section-note">
          Send your key as a bearer token on every request:
        </p>
        <CodeBlock code="Authorization: Bearer lzr_live_your_key_here" />
        <p className="section-note">Base URL:</p>
        <CodeBlock code={API_BASE_URL} />
        <div className="api-endpoint-list">
          {API_ENDPOINTS.map((e) => (
            <div className="api-endpoint" key={`${e.method} ${e.path}`}>
              <div className="api-endpoint-header">
                <span className={`api-method api-method-${e.method.toLowerCase()}`}>{e.method}</span>
                <code>{e.path}</code>
              </div>
              <p>{e.summary}</p>
              {e.body && <CodeBlock code={e.body} />}
            </div>
          ))}
        </div>
        <h3 className="api-mcp-heading">Using this from an AI agent: the MCP server</h3>
        <p className="section-note">
          Connect Claude Desktop, Claude Code, Cursor, or anything else that speaks MCP directly to your account.
          It wraps every endpoint above as a real tool the agent can call. Runs locally on your own machine using
          the key above; there's nothing to host.
        </p>
        <CodeBlock code={MCP_CONFIG_EXAMPLE} />

        <h3 className="api-mcp-heading">No install: the hosted MCP server</h3>
        <p className="section-note">
          Prefer not to install anything, or connecting from claude.ai rather than a desktop app? Same 6 tools,
          same account, but you sign in with this LazyRelay account the first time you connect instead of using
          an API key.
        </p>
        <CodeBlock code={HOSTED_MCP_URL} />
        <p className="section-note">
          In Claude: <strong>Settings → Connectors → Add connector → Remote</strong>, then paste the URL above.
          For MCP clients that use a config file instead:
        </p>
        <CodeBlock code={HOSTED_MCP_REMOTE_CONFIG_EXAMPLE} />
        <p className="section-note">
          To stop a connected app from accessing your account, remove it from wherever you connected it (for
          example, your AI tool's connector settings).
        </p>
        <div className="api-endpoint-list">
          {MCP_TOOLS.map((t) => (
            <div className="api-endpoint" key={t.name}>
              <div className="api-endpoint-header">
                <code>{t.name}</code>
              </div>
              <p>{t.summary}</p>
            </div>
          ))}
        </div>
      </section>
      )}

      {tab === "Settings" && currentTier !== "free" && (
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

      {tab === "Settings" && (
      <section>
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

              {canUpgrade ? (
                <div className="pricing-grid billing-upgrade-grid">
                  <div className="pricing-card">
                    <h3>Starter: 5GB storage</h3>
                    <p className="pricing-price">
                      $29.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">20 accounts, unlimited posts, AI-agent access</p>
                    <button className="cta" onClick={() => handleUpgrade("pro")} disabled={billingBusy !== null}>
                      {billingBusy === "pro" ? "Starting checkout..." : isCancelling ? "Resubscribe to Starter" : "Upgrade to Starter"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Pro: 10GB storage</h3>
                    <p className="pricing-price">
                      $59.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">40 accounts, unlimited posts, AI-agent access, priority support</p>
                    <button className="cta" onClick={() => handleUpgrade("business")} disabled={billingBusy !== null}>
                      {billingBusy === "business" ? "Starting checkout..." : isCancelling ? "Resubscribe to Pro" : "Upgrade to Pro"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Business: 20GB storage</h3>
                    <p className="pricing-price">
                      $99.99<span className="pricing-period">/mo</span>
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
      <SupportWidget />
    </>
  );
}
