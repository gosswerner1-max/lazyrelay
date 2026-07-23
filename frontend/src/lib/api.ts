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
  status: "pending" | "posting" | "posted" | "failed";
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

export const api = {
  listSocialAccounts: (): Promise<SocialAccount[]> => authedFetch("/social-accounts"),
  startConnect: (): Promise<{ authorizeUrl: string }> => authedFetch("/social-accounts/connect"),

  listScheduledPosts: (): Promise<ScheduledPost[]> => authedFetch("/scheduled-posts"),
  createScheduledPost: (input: {
    socialAccountId: string;
    content: string;
    mediaUrl?: string;
    scheduledFor: string;
  }): Promise<ScheduledPost> => authedFetch("/scheduled-posts", { method: "POST", body: JSON.stringify(input) }),
  deleteScheduledPost: (id: string): Promise<null> => authedFetch(`/scheduled-posts/${id}`, { method: "DELETE" }),

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
  cancelSubscription: (): Promise<{ cancelled: boolean }> =>
    authedFetch("/subscription/cancel", { method: "POST" }),

  listStorageAddons: (): Promise<StorageAddon[]> => authedFetch("/storage-addons"),
  startStorageAddonCheckout: (
    gbAmount: 5 | 20 | 50
  ): Promise<{ transactionId: string; checkoutUrl: string | null }> =>
    authedFetch("/storage-addons/checkout", { method: "POST", body: JSON.stringify({ gbAmount }) }),
  cancelStorageAddon: (id: string): Promise<{ cancelled: boolean }> =>
    authedFetch(`/storage-addons/${id}/cancel`, { method: "POST" }),
};
