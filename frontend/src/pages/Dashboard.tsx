import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { useAuth } from "../context/AuthContext";
import { api, type SocialAccount, type ScheduledPost, type Subscription, type StorageUsage, type MediaFile, type StorageAddon, type PlatformInfo, type Account, type ApiKey, type RecurringSchedule, type AnalyticsSummary, type BioPage, type MentionPost } from "../lib/api";
import { RelaySignal } from "../components/RelaySignal";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import { bestTimeFor } from "../lib/bestTimes";
import { Spinner } from "../components/Spinner";
import { OverviewPanel } from "../components/Charts";

const TABS = ["Overview", "Posts", "Calendar", "Analytics", "Mentions", "Bio Page", "Accounts", "Storage", "Account", "API Keys", "Billing"] as const;
type Tab = (typeof TABS)[number];
const MAIN_TABS: Tab[] = ["Overview", "Posts", "Calendar", "Accounts"];
const MORE_TABS: Tab[] = ["Analytics", "Mentions", "Bio Page", "Storage", "Account", "API Keys", "Billing"];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  prefillContent: string | null;
  prefillMediaUrl: string | null;
} {
  const params = new URLSearchParams(window.location.search);
  const connectError = params.get("connectError");
  const connected = params.get("connected") !== null;
  // Set by the browser extension's context-menu actions (see
  // browser-extension/background.js) — opens lazyrelay.com with one of
  // these params so the customer lands straight in the compose form
  // instead of having to copy/paste the URL themselves.
  const prefillContent = params.get("prefillContent");
  const prefillMediaUrl = params.get("prefillMediaUrl");
  if (connectError || connected || prefillContent || prefillMediaUrl) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return { connectError, connected, prefillContent, prefillMediaUrl };
}
const connectParams = readAndClearConnectParams();

export function Dashboard() {
  const { signOut } = useAuth();
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const coverImageInputRef = useRef<HTMLInputElement>(null);
  // refresh() re-fetches the account on every call (including after
  // unrelated actions like scheduling a post) — only seed the business-name
  // input from the server once, so it never clobbers text the user is
  // actively typing into the Settings field.
  const businessNameSeeded = useRef(false);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [mediaBusyId, setMediaBusyId] = useState<string | null>(null);
  const [disconnectingAccountId, setDisconnectingAccountId] = useState<string | null>(null);
  const [storageAddons, setStorageAddons] = useState<StorageAddon[]>([]);
  const [addonBusy, setAddonBusy] = useState<5 | 20 | 50 | string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [businessNameInput, setBusinessNameInput] = useState("");
  const [savingBusinessName, setSavingBusinessName] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeyName, setApiKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [billingBusy, setBillingBusy] = useState<"pro" | "business" | "enterprise" | "cancel" | null>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelFeedback, setCancelFeedback] = useState("");

  const [content, setContent] = useState("");
  const [aiTopic, setAiTopic] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [hashtagGenerating, setHashtagGenerating] = useState(false);
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
  const [mediaDragActive, setMediaDragActive] = useState(false);
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(null);
  const [coverImageUploading, setCoverImageUploading] = useState(false);
  const [pinterestBoards, setPinterestBoards] = useState<{ id: string; name: string }[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
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
  const [mentions, setMentions] = useState<MentionPost[] | null>(null);
  const [mentionsLoading, setMentionsLoading] = useState(false);
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
  const [finalizingUpgrade, setFinalizingUpgrade] = useState(false);
  const pendingTierRef = useRef<"pro" | "business" | "enterprise" | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [accs, pts, sub, usage, media, addons, plats, acct, keys, recurring] = await Promise.all([
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
      ]);
      setAccounts(accs);
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
      setApiKeys(keys);
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
      (p) => (p.status === "pending" || p.status === "posting") && new Date(p.scheduled_for) <= new Date()
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
    api
      .getAnalyticsSummary(days)
      .then(setAnalytics)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setAnalyticsLoading(false));
  }, [tab, analyticsRangeDays]);

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
    }
    if (connectParams.prefillContent || connectParams.prefillMediaUrl) {
      setTab("Posts");
      if (connectParams.prefillContent) setContent(connectParams.prefillContent);
      if (connectParams.prefillMediaUrl) setMediaUrl(connectParams.prefillMediaUrl);
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

  function toggleSelectedAccount(id: string) {
    setSelectedAccountIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
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
      // One scheduled_posts row per selected account — same content/media/time
      // fanned out to every platform the customer checked, via the existing
      // single-post endpoint rather than a new batch one.
      for (const socialAccountId of selectedAccountIds) {
        await api.createScheduledPost({
          socialAccountId,
          content,
          mediaUrl: mediaUrl ?? undefined,
          coverImageUrl: coverImageUrl ?? undefined,
          // Only meaningful when this account is on Pinterest — every other
          // adapter's post() ignores it, same as coverImageUrl above.
          boardId: accounts.find((a) => a.id === socialAccountId)?.platform === "pinterest"
            ? (selectedBoardId ?? undefined)
            : undefined,
          scheduledFor: scheduledForIso,
          requiresApproval: requiresApprovalOverride,
        });
      }
      setContent("");
      setScheduleDate("");
      setScheduleTime("");
      setMediaUrl(null);
      setCoverImageUrl(null);
      setRequiresApproval(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
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

  async function handleCoverImageFile(file: File) {
    setError(null);
    setCoverImageUploading(true);
    try {
      const { url } = await api.uploadMedia(file);
      setCoverImageUrl(url);
      const [usage, media] = await Promise.all([api.getStorageUsage(), api.listMedia()]);
      setStorageUsage(usage);
      setMediaFiles(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCoverImageUploading(false);
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
      const created = await api.createApiKey(apiKeyName.trim());
      setNewlyCreatedKey(created.key);
      setApiKeyName("");
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
            <button className="plan-banner-cta" onClick={() => setTab("Billing")}>
              {isCancelling ? "Resubscribe" : "Upgrade"}
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
        <button className="link" onClick={signOut}>
          Sign out
        </button>
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
        {analyticsLoading && <Spinner />}
        {!analyticsLoading && analytics && analytics.totalPosts === 0 && (
          <p className="empty">No posts scheduled in this range yet — analytics fill in once posts go out.</p>
        )}
        {!analyticsLoading && analytics && analytics.totalPosts > 0 && (
          <>
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
              YouTube — every other platform shows "—", not a zero, since LazyRelay has no read access there yet.
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
          </>
        )}
      </section>
      )}

      {tab === "Mentions" && (
      <section>
        <h2>Mentions &amp; comments</h2>
        <p className="muted">
          Comments on your recent posts, pulled directly from each platform. Only Mastodon, Bluesky, and YouTube
          support this today — every other platform's comments still live on the platform itself, not here yet.
        </p>
        {mentionsLoading && <Spinner />}
        {!mentionsLoading && mentions && mentions.length === 0 && <p className="empty">No recent posted content yet.</p>}
        {!mentionsLoading && mentions && mentions.length > 0 && (() => {
          // Same date-grouped pattern as the Posts tab's History list
          // (2026-08-07, Werner: "must do the same here") — a flat list
          // gets unmanageable the same way once there are more than a
          // handful of posts.
          const groups = new Map<string, MentionPost[]>();
          for (const post of mentions) {
            const key = localDateKey(post.scheduledFor);
            (groups.get(key) ?? groups.set(key, []).get(key)!).push(post);
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
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            );
          });
        })()}
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
              A public page for your Instagram/TikTok bio link — customers land here and see the links you choose.
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
                  <p className="empty">No links yet — add one below.</p>
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

      {tab === "Overview" && <OverviewPanel analytics={analytics} loading={analyticsLoading} />}

      {tab === "Accounts" && (
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
                        : p.platform === "youtube"
                          ? "Google is still reviewing our app, so you'll see an \"unverified app\" warning first — that's expected, see the note below"
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
        {platforms.some((p) => p.platform === "youtube" && p.configured && !p.comingSoon) && (
          <p className="platform-grid-note">
            Connecting YouTube? Google is still reviewing our app, so you'll see a "Google hasn't verified this app" warning first.
            That's expected — click <strong>Advanced</strong>, then <strong>Go to LazyRelay (unsafe)</strong>, to finish connecting.
          </p>
        )}
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
              {selectedAccountIds.length > 0 && (
                <div className="best-time-hints">
                  {[...new Set(selectedAccountIds.map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean))].map(
                    (platform) => {
                      const guidance = bestTimeFor(platform as string);
                      return (
                        <p key={platform} className="best-time-hint">
                          <PlatformIcon platform={platform as string} size={12} /> Best general time for {platform}:{" "}
                          <strong>{guidance.windows}</strong> — {guidance.note}
                        </p>
                      );
                    },
                  )}
                  <p className="best-time-disclaimer">General industry benchmark, not personalized to your account's own audience yet.</p>
                </div>
              )}
            </label>
            {selectedPinterestAccountId && (
              <label>
                Pinterest board
                {boardsLoading ? (
                  <p className="muted">Loading your boards...</p>
                ) : pinterestBoards.length === 0 ? (
                  <p className="muted">
                    No boards found yet — LazyRelay will create a default board the first time you post.
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
            {mediaUrl?.match(/\.(mp4|mov)$/i) &&
              selectedAccountIds.some((id) => accounts.find((a) => a.id === id)?.platform === "pinterest") && (
                <label>
                  Cover image (required for Pinterest video Pins)
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
                      <span>Uploading...</span>
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
                      <span>Click to choose a cover image for your Pinterest video Pin</span>
                    )}
                  </div>
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
            <div className="schedule-form-actions">
              <button type="submit" disabled={submitting}>
                {submitting ? "Scheduling..." : "Schedule"}
              </button>
              <button type="button" className="post-now-btn" disabled={submitting} onClick={handlePostNow}>
                {submitting ? "Posting..." : "Post Now"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section>
        <h2>Bulk import (CSV)</h2>
        <p className="muted">
          Columns: <code>platform</code>, <code>content</code>, <code>scheduled_for</code> (ISO date/time), <code>media_url</code>{" "}
          (optional). <code>platform</code> is matched against your connected accounts — if you have more than one account on the
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
          Set up a weekly content cadence once — LazyRelay keeps posting it to your chosen platforms every week until you pause or delete it.
        </p>
        {accounts.length === 0 ? (
          <p className="empty">Connect an account first.</p>
        ) : (
          <form onSubmit={submitRecurringSchedule} className="schedule-form">
            <label>
              Post to
              <div className="account-checkbox-list">
                {accounts.map((a) => (
                  <label key={a.id} className="account-checkbox">
                    <input
                      type="checkbox"
                      checked={rsSelectedAccountIds.includes(a.id)}
                      onChange={() => toggleRsAccount(a.id)}
                    />
                    <PlatformIcon platform={a.platform} size={14} />
                    {a.display_name ?? a.platform_account_id}
                  </label>
                ))}
              </div>
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
        const upcoming = posts.filter((p) => p.status === "pending" || p.status === "posting" || p.status === "needs_approval");
        const history = posts
          .filter((p) => p.status !== "pending" && p.status !== "posting" && p.status !== "needs_approval")
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
        for (const p of posts) {
          const key = localDateKey(p.scheduled_for);
          (postsByDay[key] ??= []).push(p);
        }

        const cells: { day: number | null; key: string | null }[] = [];
        for (let i = 0; i < leadingBlanks; i++) cells.push({ day: null, key: null });
        for (let d = 1; d <= daysInMonth; d++) {
          cells.push({ day: d, key: `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
        }

        const dayPosts = selectedDay ? (postsByDay[selectedDay] ?? []) : [];

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
                    {c.key && postsByDay[c.key] && (
                      <span className="calendar-cell-dots">
                        {postsByDay[c.key].slice(0, 4).map((p) => (
                          <span key={p.id} className={`calendar-dot calendar-dot-${p.status}`} />
                        ))}
                        {postsByDay[c.key].length > 4 && <span className="calendar-cell-more">+{postsByDay[c.key].length - 4}</span>}
                      </span>
                    )}
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
                            <span>{new Date(p.scheduled_for).toLocaleTimeString()}</span>
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
              </div>
            )}
          </section>
        );
      })()}

      {tab === "Storage" && (
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

      {tab === "Account" && (
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

      {tab === "API Keys" && (
      <section>
        <h2>API keys</h2>
        <p className="section-note">
          Let your own AI agent post and schedule directly through LazyRelay's API, without a browser or a human
          login.
        </p>
        <p className="security-notice">
          <span aria-hidden="true">⚠️</span>
          <span>
            Treat every key like a password. Anyone who has it can post, schedule, and manage this account exactly
            as you can — never share a key or commit one to code. Revoke it immediately if you think it's leaked.
          </span>
        </p>
        {newlyCreatedKey && (
          <div className="api-key-reveal">
            <p><strong>Copy this key now</strong> — it won't be shown again.</p>
            <code>{newlyCreatedKey}</code>
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
          <button type="submit" disabled={creatingKey || !apiKeyName.trim()}>
            {creatingKey ? "Creating..." : "Create key"}
          </button>
        </form>
        {apiKeys.length === 0 ? (
          <p className="empty">No API keys yet.</p>
        ) : (
          <ul className="media-list">
            {apiKeys.map((k) => (
              <li key={k.id}>
                <span className="media-list-meta">
                  <strong>{k.name}</strong> — {k.key_prefix}...
                  {k.revoked_at ? (
                    <span className="status-badge status-cancelled">revoked</span>
                  ) : (
                    <span className="status-badge status-active">
                      {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : "never used"}
                    </span>
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

      {tab === "Storage" && currentTier !== "free" && (
      <section>
        <h2>Buy more storage</h2>
        <p className="section-note">Add extra space on top of your plan's included storage — cancel any add-on separately, any time.</p>
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

      {tab === "Billing" && (
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
                      $29.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">20 accounts, unlimited posts, AI-agent access</p>
                    <button className="cta" onClick={() => handleUpgrade("pro")} disabled={billingBusy !== null}>
                      {billingBusy === "pro" ? "Starting checkout..." : isCancelling ? "Resubscribe to Starter" : "Upgrade to Starter"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Pro — 10GB storage</h3>
                    <p className="pricing-price">
                      $59.99<span className="pricing-period">/mo</span>
                    </p>
                    <p className="pricing-note">40 accounts, unlimited posts, AI-agent access, priority support</p>
                    <button className="cta" onClick={() => handleUpgrade("business")} disabled={billingBusy !== null}>
                      {billingBusy === "business" ? "Starting checkout..." : isCancelling ? "Resubscribe to Pro" : "Upgrade to Pro"}
                    </button>
                  </div>
                  <div className="pricing-card">
                    <h3>Business — 20GB storage</h3>
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
