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

export interface SocialAccount {
  id: string;
  platform: string;
  platform_account_id: string;
  display_name: string | null;
  connected_at: string;
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
}

export interface PlatformInfo {
  platform: string;
  configured: boolean;
  comingSoon: boolean;
}

export interface Account {
  email: string;
  businessName: string | null;
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

export interface MentionComment {
  id: string;
  author: string;
  text: string;
  url: string | null;
  createdAt: string | null;
}

export interface MentionPost {
  postId: string;
  platform: string;
  content: string;
  platformPostUrl: string | null;
  supported: boolean;
  comments: MentionComment[];
  errorMessage?: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export const api = {
  listSocialAccounts: (): Promise<SocialAccount[]> => authedFetch("/social-accounts"),
  getPlatforms: (): Promise<PlatformInfo[]> => authedFetch("/platforms"),
  startConnect: (platform: string): Promise<{ authorizeUrl: string }> =>
    authedFetch(`/social-accounts/connect?platform=${encodeURIComponent(platform)}`),

  // For platforms without real OAuth (Bluesky, Telegram, Discord) — the
  // connect-form page collects a credential, JSON-encodes it as `code`, and
  // resubmits here directly. Not routed through authedFetch: this call has
  // to work even if the browser's Supabase session expired mid-flow, since
  // identity comes entirely from the one-time `state` token minted when the
  // connect flow started, same as a real OAuth callback.
  completeManualConnect: async (code: string, state: string): Promise<{ connected: boolean; socialAccountId: string }> => {
    const res = await fetch(
      `${API_URL}/social-accounts/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Connect failed: ${res.status}`);
    return body;
  },

  listScheduledPosts: (): Promise<ScheduledPost[]> => authedFetch("/scheduled-posts"),
  createScheduledPost: (input: {
    socialAccountId: string;
    content: string;
    mediaUrl?: string;
    coverImageUrl?: string;
    boardId?: string;
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

  getAnalyticsSummary: (days = 30): Promise<AnalyticsSummary> => authedFetch(`/analytics/summary?days=${days}`),

  getMentions: (): Promise<{ posts: MentionPost[] }> => authedFetch("/mentions"),

  generateCaption: (topic: string, platform?: string, tone?: string): Promise<{ caption: string }> =>
    authedFetch("/ai/caption", { method: "POST", body: JSON.stringify({ topic, platform, tone }) }),

  suggestHashtags: (content: string, platform?: string): Promise<{ hashtags: string[] }> =>
    authedFetch("/ai/hashtags", { method: "POST", body: JSON.stringify({ content, platform }) }),

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

  listApiKeys: (): Promise<ApiKey[]> => authedFetch("/api-keys"),
  createApiKey: (name: string): Promise<ApiKey & { key: string }> =>
    authedFetch("/api-keys", { method: "POST", body: JSON.stringify({ name }) }),
  revokeApiKey: (id: string): Promise<null> => authedFetch(`/api-keys/${id}`, { method: "DELETE" }),

  listStorageAddons: (): Promise<StorageAddon[]> => authedFetch("/storage-addons"),
  startStorageAddonCheckout: (
    gbAmount: 5 | 20 | 50
  ): Promise<{ transactionId: string; checkoutUrl: string | null }> =>
    authedFetch("/storage-addons/checkout", { method: "POST", body: JSON.stringify({ gbAmount }) }),
  cancelStorageAddon: (id: string): Promise<{ cancelled: boolean }> =>
    authedFetch(`/storage-addons/${id}/cancel`, { method: "POST" }),
};
