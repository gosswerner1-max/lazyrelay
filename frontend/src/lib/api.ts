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

  cancelSubscription: (): Promise<{ cancelled: boolean }> =>
    authedFetch("/subscription/cancel", { method: "POST" }),
};
