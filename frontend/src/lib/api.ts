import { supabase } from "./supabase";

const API_URL = import.meta.env.VITE_API_URL;

async function authedFetch(path: string, options: RequestInit = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// Support-widget guided actions, Phase 2 (2026-08-11) — a structured
// suggestion from the AI, never executed automatically. The widget renders
// a real confirm button for whichever of these comes back; only the
// customer's own click calls the matching authenticated endpoint below
// (startConnect / disconnectSocialAccount / cancelSubscription).
export type SupportAction =
  | { type: "reconnect"; platform: string }
  | { type: "disconnect"; platform: string; accountId: string }
  | { type: "cancel_subscription" }
  | null;

export interface SocialAccount {
  id: string;
  platform: string;
  platform_account_id: string;
  display_name: string | null;
  connected_at: string;
  brand_label: string | null;
}

export interface ScheduledPost {
  id: string;
  social_account_id: string;
  content: string;
  media_url: string | null;
  scheduled_for: string;
  status: "pending" | "posting" | "posted" | "failed" | "needs_approval";
  post_results: Array<{ verified_live: boolean; platform_post_url: string | null; error_message: string | null }>;
}

// Internal tier codes are stable across the Starter/Pro/Business rename
// (2026-07-23) — "pro" displays as "Starter", "business" displays as "Pro",
// "enterprise" is the genuinely new top tier, displaying as "Business".
export interface Subscription {
  tier: "free" | "pro" | "business" | "enterprise";
  status: "trialing" | "active" | "past_due" | "cancelled" | null;
  currentPeriodEnd: string | null;
  // True while a cancellation is scheduled for the end of the current paid
  // period — status stays active/trialing (real paid access continues)
  // until the real cancellation webhook lands, see backend migration 0043.
  cancelAtPeriodEnd: boolean;
}

export interface StorageUsage {
  tier: "free" | "pro" | "business" | "enterprise";
  usedBytes: number;
  quotaBytes: number;
  addonBytes: number;
}

export interface MediaFile {
  id: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface StorageAddon {
  id: string;
  gb_amount: number;
  status: "trialing" | "active" | "past_due" | "cancelled";
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface PlatformInfo {
  platform: string;
  configured: boolean;
  comingSoon: boolean;
}

export interface Account {
  email: string;
  businessName: string | null;
  emailFailureAlertsEnabled: boolean;
  webhookUrl: string | null;
  webhookConfigured: boolean;
  webhookSecret?: string;
}

export interface RecurringSchedule {
  id: string;
  content: string;
  media_url: string | null;
  social_account_ids: string[];
  days_of_week: number[]; // ISO weekday, 1=Mon..7=Sun
  time_of_day: string; // "HH:mm:ss"
  timezone: string;
  status: "active" | "paused";
  starts_on: string;
  ends_on: string | null;
  created_at: string;
}

export interface RecurringScheduleInput {
  content: string;
  mediaUrl?: string | null;
  coverImageUrl?: string | null;
  socialAccountIds: string[];
  daysOfWeek: number[];
  timeOfDay: string; // "HH:mm"
  timezone: string;
  startsOn?: string;
  endsOn?: string | null;
}

export interface AnalyticsSummary {
  rangeDays: number;
  totalPosts: number;
  byStatus: Record<string, number>;
  byPlatform: Record<string, { total: number; posted: number; failed: number; verifiedLive: number }>;
  dailyCounts: Record<string, number>;
  verifiedLiveRate: number | null;
  // Real engagement analytics (2026-08-07) — only present for platforms
  // with real read support (Facebook, Instagram, Mastodon, Bluesky, X,
  // YouTube). A platform missing from this map isn't a bug — it means
  // LazyRelay has no metrics-read access for it yet, same "honestly
  // absent, never a silent zero" pattern as the Mentions tab.
  engagement: Record<string, { likes: number; comments: number; shares: number; views: number; postsWithData: number }>;
}

export interface BioLink {
  id: string;
  label: string;
  url: string;
  position: number;
}

export interface BioPage {
  id: string;
  slug: string;
  title: string;
  bio: string;
  avatar_url: string | null;
  links: BioLink[];
}

export interface PublicBioPage {
  title: string;
  bio: string;
  avatarUrl: string | null;
  links: Array<{ id: string; label: string; url: string }>;
}

export interface Triage {
  needsAttention: boolean;
  category: "angry_customer" | "sales_question" | "question" | "routine";
  reason: string;
}

export interface MentionComment {
  id: string;
  author: string;
  text: string;
  url: string | null;
  createdAt: string | null;
  triage?: Triage | null;
}

export interface MentionPost {
  postId: string;
  socialAccountId: string;
  platform: string;
  content: string;
  scheduledFor: string;
  platformPostUrl: string | null;
  supported: boolean;
  canReply?: boolean;
  comments: MentionComment[];
  errorMessage?: string | null;
}

export interface DMConversation {
  socialAccountId: string;
  platform: string;
  accountDisplayName: string | null;
  conversationId: string;
  participantId: string;
  participantName: string;
  snippet: string | null;
  updatedAt: string | null;
  triage?: Triage | null;
}

export interface DMMessage {
  id: string;
  fromId: string;
  fromName: string;
  text: string;
  createdAt: string | null;
  isOwn: boolean;
}

export interface DMAutomation {
  id: string;
  social_account_id: string;
  scheduled_post_id: string | null;
  keyword: string | null;
  dm_message: string;
  active: boolean;
  created_at: string;
  social_accounts?: { platform: string; display_name: string | null } | null;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  can_share_proof: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface PublicVerification {
  businessName: string | null;
  platform: string | null;
  accountName: string | null;
  content: string;
  scheduledFor: string;
  verifiedAt: string | null;
  platformPostUrl: string | null;
}

export const api = {
  listSocialAccounts: (): Promise<SocialAccount[]> => authedFetch("/social-accounts"),
  disconnectSocialAccount: (id: string): Promise<null> => authedFetch(`/social-accounts/${id}`, { method: "DELETE" }),
  setBrandLabel: (id: string, brandLabel: string | null): Promise<SocialAccount> =>
    authedFetch(`/social-accounts/${id}`, { method: "PATCH", body: JSON.stringify({ brandLabel }) }),
  getPlatforms: (): Promise<PlatformInfo[]> => authedFetch("/platforms"),
  startConnect: (platform: string): Promise<{ authorizeUrl: string }> =>
    authedFetch(`/social-accounts/connect?platform=${encodeURIComponent(platform)}`),

  // Real Page/account picker for platforms where one OAuth login can map to
  // several destinations (Facebook: multiple Pages; Instagram: whichever
  // Page has a Business Account linked) — see backend/src/platforms/connect.ts.
  getPendingSelection: (token: string): Promise<{ platform: string; options: { id: string; name: string }[] }> =>
    authedFetch(`/social-accounts/pending-selection/${encodeURIComponent(token)}`),
  finalizeSelection: (token: string, selectedIds: string[]): Promise<{ connected: boolean; socialAccountIds: string[] }> =>
    authedFetch("/social-accounts/finalize-selection", { method: "POST", body: JSON.stringify({ token, selectedIds }) }),

  // For platforms without real OAuth (Bluesky, Telegram, Discord) — the
  // connect-form page collects a credential, JSON-encodes it as `code`, and
  // resubmits here directly. Not routed through authedFetch: this call has
  // to work even if the browser's Supabase session expired mid-flow, since
  // identity comes entirely from the one-time `state` token minted when the
  // connect flow started, same as a real OAuth callback.
  //
  // `format=json` is required here, not optional — without it the backend
  // redirects (the behavior real OAuth platforms need, since they navigate
  // the browser here directly), fetch() follows that redirect onto the
  // frontend's own origin, and that origin's plain static hosting sends no
  // CORS headers — so the browser throws "Failed to fetch" even though the
  // connect already succeeded server-side (confirmed live 2026-08-06 on
  // Bluesky/Telegram/Discord).
  completeManualConnect: async (code: string, state: string): Promise<{ connected: boolean; socialAccountId: string }> => {
    const res = await fetch(
      `${API_URL}/social-accounts/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&format=json`,
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Connect failed: ${res.status}`);
    return body;
  },

  listScheduledPosts: (): Promise<ScheduledPost[]> => authedFetch("/scheduled-posts"),
  // Real pagination for History — `before` is the oldest post's
  // scheduled_for currently loaded on screen, not a page number, so it
  // stays correct even if new posts fire in between "Load more" clicks.
  loadMoreHistory: (before: string, limit = 50): Promise<ScheduledPost[]> =>
    authedFetch(`/scheduled-posts/history?before=${encodeURIComponent(before)}&limit=${limit}`),
  createScheduledPost: (input: {
    socialAccountId: string;
    content: string;
    mediaUrl?: string;
    coverImageUrl?: string;
    boardId?: string;
    firstComment?: string;
    scheduledFor: string;
    requiresApproval?: boolean;
  }): Promise<ScheduledPost> => authedFetch("/scheduled-posts", { method: "POST", body: JSON.stringify(input) }),
  deleteScheduledPost: (id: string): Promise<null> => authedFetch(`/scheduled-posts/${id}`, { method: "DELETE" }),
  approveScheduledPost: (id: string): Promise<ScheduledPost> =>
    authedFetch(`/scheduled-posts/${id}/approve`, { method: "PATCH" }),

  // Real Pinterest board list for a connected account — empty array for any
  // other platform (see GET /social-accounts/:id/boards). Drives the board
  // picker shown in the compose form only when a Pinterest account is
  // selected, rather than always posting to whichever board the API
  // returns first.
  getBoards: (socialAccountId: string): Promise<{ id: string; name: string }[]> =>
    authedFetch(`/social-accounts/${socialAccountId}/boards`),

  bulkCreateScheduledPosts: (
    posts: Array<{ socialAccountId: string; content: string; mediaUrl?: string; coverImageUrl?: string; scheduledFor: string }>,
  ): Promise<{ succeeded: number; failed: number; results: Array<{ row: number; status: number; body: { error?: string } }> }> =>
    authedFetch("/scheduled-posts/bulk", { method: "POST", body: JSON.stringify({ posts }) }),

  getAnalyticsSummary: (days = 30, brand?: string): Promise<AnalyticsSummary> =>
    authedFetch(`/analytics/summary?days=${days}${brand ? `&brand=${encodeURIComponent(brand)}` : ""}`),
  getAnalyticsInsight: (
    days: number,
    brand?: string,
  ): Promise<{ insight: string } | { insufficientData: true; postsWithData: number; needed: number }> =>
    authedFetch("/analytics/insight", { method: "POST", body: JSON.stringify({ days, brand }) }),

  getMentions: (): Promise<{ posts: MentionPost[] }> => authedFetch("/mentions"),

  replyToMention: (postId: string, commentId: string, text: string): Promise<{ success: boolean }> =>
    authedFetch("/mentions/reply", { method: "POST", body: JSON.stringify({ postId, commentId, text }) }),

  getDMs: (): Promise<{ conversations: DMConversation[] }> => authedFetch("/dms"),

  getDMMessages: (socialAccountId: string, conversationId: string): Promise<{ messages: DMMessage[]; errorMessage: string | null }> =>
    authedFetch(`/dms/messages?socialAccountId=${encodeURIComponent(socialAccountId)}&conversationId=${encodeURIComponent(conversationId)}`),

  replyToDM: (socialAccountId: string, recipientId: string, text: string): Promise<{ success: boolean }> =>
    authedFetch("/dms/reply", { method: "POST", body: JSON.stringify({ socialAccountId, recipientId, text }) }),

  listDMAutomations: (): Promise<DMAutomation[]> => authedFetch("/dm-automations"),

  createDMAutomation: (socialAccountId: string, keyword: string, dmMessage: string): Promise<DMAutomation> =>
    authedFetch("/dm-automations", {
      method: "POST",
      body: JSON.stringify({ socialAccountId, keyword: keyword || null, dmMessage }),
    }),

  deleteDMAutomation: (id: string): Promise<void> => authedFetch(`/dm-automations/${id}`, { method: "DELETE" }),

  generateCaption: (topic: string, platform?: string, tone?: string): Promise<{ caption: string }> =>
    authedFetch("/ai/caption", { method: "POST", body: JSON.stringify({ topic, platform, tone }) }),

  suggestHashtags: (content: string, platform?: string): Promise<{ hashtags: string[] }> =>
    authedFetch("/ai/hashtags", { method: "POST", body: JSON.stringify({ content, platform }) }),

  getContentIdeas: (): Promise<{ ideas: string[] }> => authedFetch("/ai/content-ideas", { method: "POST" }),

  // Not authedFetch — the support widget has to work for signed-out
  // marketing-site visitors too, so a missing session never throws here
  // (unlike authedFetch). When a real session DOES exist (dashboard,
  // logged in), attach it anyway so the backend can answer account-aware
  // questions (Phase 1, 2026-08-11) — the backend treats a missing/invalid
  // token as anonymous either way, so this is purely additive.
  sendSupportChatMessage: async (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<{ reply: string; escalated: "hello" | "support" | "accounts" | null; action: SupportAction }> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch(`${API_URL}/support/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
    return body;
  },

  getBioPage: (): Promise<BioPage | null> => authedFetch("/bio-page"),
  saveBioPage: (input: { slug: string; title: string; bio: string; avatarUrl?: string | null }): Promise<BioPage> =>
    authedFetch("/bio-page", { method: "PUT", body: JSON.stringify(input) }),
  addBioLink: (input: { label: string; url: string }): Promise<BioLink> =>
    authedFetch("/bio-page/links", { method: "POST", body: JSON.stringify(input) }),
  updateBioLink: (id: string, input: Partial<{ label: string; url: string; position: number }>): Promise<BioLink> =>
    authedFetch(`/bio-page/links/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteBioLink: (id: string): Promise<null> => authedFetch(`/bio-page/links/${id}`, { method: "DELETE" }),

  // Public, unauthenticated — the actual page a customer's followers land
  // on. Not routed through authedFetch, which requires a live session.
  getPublicBioPage: async (slug: string): Promise<PublicBioPage> => {
    const res = await fetch(`${API_URL}/public/bio/${encodeURIComponent(slug)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Page not found`);
    return body;
  },

  listRecurringSchedules: (): Promise<RecurringSchedule[]> => authedFetch("/recurring-schedules"),
  createRecurringSchedule: (input: RecurringScheduleInput): Promise<RecurringSchedule> =>
    authedFetch("/recurring-schedules", { method: "POST", body: JSON.stringify(input) }),
  updateRecurringSchedule: (
    id: string,
    input: Partial<RecurringScheduleInput> & { status?: "active" | "paused" },
  ): Promise<RecurringSchedule> =>
    authedFetch(`/recurring-schedules/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteRecurringSchedule: (id: string, cancelUpcoming = false): Promise<null> =>
    authedFetch(`/recurring-schedules/${id}${cancelUpcoming ? "?cancelUpcoming=true" : ""}`, { method: "DELETE" }),

  // Not routed through authedFetch — that helper always sets a JSON
  // Content-Type, which breaks multipart uploads (the browser needs to set
  // its own Content-Type with the multipart boundary for FormData).
  uploadMedia: async (file: File): Promise<{ url: string }> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Not signed in");
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_URL}/media/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Upload failed: ${res.status}`);
    }
    return res.json();
  },

  getStorageUsage: (): Promise<StorageUsage> => authedFetch("/media/usage"),
  listMedia: (): Promise<MediaFile[]> => authedFetch("/media"),
  deleteMedia: (id: string): Promise<null> => authedFetch(`/media/${id}`, { method: "DELETE" }),

  getSubscription: (): Promise<Subscription> => authedFetch("/subscription"),
  startCheckout: (
    tier: "pro" | "business" | "enterprise"
  ): Promise<{ transactionId: string; checkoutUrl: string | null }> =>
    authedFetch("/subscription/checkout", { method: "POST", body: JSON.stringify({ tier }) }),
  cancelSubscription: (feedback?: string): Promise<{ cancelled: boolean }> =>
    authedFetch("/subscription/cancel", { method: "POST", body: JSON.stringify({ feedback }) }),

  getAccount: (): Promise<Account> => authedFetch("/account"),
  updateAccount: (businessName: string | null): Promise<Account> =>
    authedFetch("/account", { method: "PATCH", body: JSON.stringify({ businessName }) }),
  setEmailFailureAlerts: (enabled: boolean): Promise<Account> =>
    authedFetch("/account", { method: "PATCH", body: JSON.stringify({ emailFailureAlertsEnabled: enabled }) }),
  setWebhookUrl: (webhookUrl: string | null): Promise<Account> =>
    authedFetch("/account", { method: "PATCH", body: JSON.stringify({ webhookUrl }) }),
  regenerateWebhookSecret: (): Promise<{ webhookSecret: string }> =>
    authedFetch("/account/webhook/regenerate-secret", { method: "POST" }),

  listApiKeys: (): Promise<ApiKey[]> => authedFetch("/api-keys"),
  createApiKey: (name: string, canShareProof: boolean): Promise<ApiKey & { key: string }> =>
    authedFetch("/api-keys", { method: "POST", body: JSON.stringify({ name, canShareProof }) }),
  revokeApiKey: (id: string): Promise<null> => authedFetch(`/api-keys/${id}`, { method: "DELETE" }),

  // Generates the public Proof-of-Publish share link for a post. The
  // dashboard shows a confirm dialog before calling this (see Dashboard.tsx).
  getProofLink: (scheduledPostId: string): Promise<{ url: string }> =>
    authedFetch(`/scheduled-posts/${scheduledPostId}/proof-link`),

  // Public, unauthenticated — same pattern as getPublicBioPage.
  getPublicVerification: async (id: string): Promise<PublicVerification> => {
    const res = await fetch(`${API_URL}/public/verify/${encodeURIComponent(id)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Nothing verified at this link.");
    return body;
  },

  // Opens a 10-minute window for the NEXT admin-key request to go through.
  // Only works signed in as yourself — never with an API key. See
  // migration 0037_admin_key_guard.sql.
  announceAdminAction: (taskLabel?: string): Promise<{ expiresAt: string; windowMinutes: number }> =>
    authedFetch("/admin/announce", { method: "POST", body: JSON.stringify({ taskLabel: taskLabel ?? null }) }),

  listStorageAddons: (): Promise<StorageAddon[]> => authedFetch("/storage-addons"),
  startStorageAddonCheckout: (
    gbAmount: 5 | 20 | 50
  ): Promise<{ transactionId: string; checkoutUrl: string | null }> =>
    authedFetch("/storage-addons/checkout", { method: "POST", body: JSON.stringify({ gbAmount }) }),
  cancelStorageAddon: (id: string): Promise<{ cancelled: boolean }> =>
    authedFetch(`/storage-addons/${id}/cancel`, { method: "POST" }),
};
