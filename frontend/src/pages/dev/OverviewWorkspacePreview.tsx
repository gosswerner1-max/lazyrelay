// DEV ONLY page at /dev/overview-workspace. The Overview workspace on made-up accounts and posts (nothing real), with times counted from now so the page
// looks the way it does live. Loaded by App.tsx only behind import.meta.env.DEV, so it is never part of a production build.

import { OverviewWorkspace } from "../../components/dashboard/OverviewWorkspace";
import type { ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: `@${brand.toLowerCase().replace(/\s+/g, "")}`, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "brand-" + brand,
});
const ACCOUNTS: SocialAccount[] = [
  acct("alpha-tiktok", "tiktok", "Alpha Brand"), acct("alpha-mastodon", "mastodon", "Alpha Brand"), acct("alpha-bluesky", "bluesky", "Alpha Brand"),
  acct("beta-facebook", "facebook", "Beta Brand"), { ...acct("beta-discord", "discord", "Beta Brand"), needs_reconnect_at: "2026-10-20T00:00:00Z" },
];

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const post = (id: string, status: ScheduledPost["status"], accountId: string, minutes: number, content: string, extra: Partial<ScheduledPost> = {}): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: at(minutes), content, paused_at: null, post_results: [], ...extra }) as unknown as ScheduledPost;

const POSTS: ScheduledPost[] = [
  post("u1", "pending", "alpha-bluesky", 95, "Schedule once. Publish everywhere. Proof it went live."),
  post("u2", "pending", "alpha-tiktok", 380, "Three ways to batch a week of posts in ten minutes."),
  post("u3", "pending", "beta-facebook", 1500, "Carousels, Stories and Reels: one workflow for all three."),
  post("u4", "pending", "alpha-mastodon", 1900, "Verification fails? Here is what to check first."),
  post("u5", "pending", "alpha-bluesky", 3300, "Stuck on what to post? Start from one idea and reuse it."),
  post("u6", "pending", "beta-facebook", 4800, "A calendar that shows what is live, not just what is queued."),
  post("p1", "pending", "alpha-tiktok", 600, "Paused until the new site is ready.", { paused_at: "2026-10-20T08:15:00Z" }),
  post("f1", "failed", "beta-discord", -300, "Webhook was rejected."),
  post("d1", "draft", "alpha-tiktok", 0, "Draft: pricing explainer."),
  post("g1", "posted", "alpha-bluesky", -45, "Posts on 18 platforms plus WhatsApp, one place.", { post_results: [{ verified_live: true, platform_post_url: "https://bsky.app/profile/x/post/1", error_message: null }] } as Partial<ScheduledPost>),
  post("g2", "posted", "alpha-tiktok", -190, "Why a 200 from the API does not mean your post is live.", { post_results: [{ verified_live: true, platform_post_url: "https://tiktok.com/@x/video/1", error_message: null }] } as Partial<ScheduledPost>),
  post("g3", "posted", "beta-facebook", -560, "Client approvals without the email chains.", { post_results: [{ verified_live: false, platform_post_url: null, error_message: null }] } as Partial<ScheduledPost>),
  post("g4", "posted", "alpha-mastodon", -1500, "Reply from one place: comments from every channel.", { post_results: [{ verified_live: true, platform_post_url: "https://mastodon.social/@x/1", error_message: null }] } as Partial<ScheduledPost>),
];

export function OverviewWorkspacePreview() {
  return (
    <div style={{ background: "#0b0f19", minHeight: "100dvh", padding: 24 }}>
      <p style={{ color: "#94a3b8", margin: "0 0 16px" }}>Dev preview: made-up data only, nothing is loaded or sent.</p>
      <OverviewWorkspace accounts={ACCOUNTS} posts={POSTS} onConnect={() => undefined} />
    </div>
  );
}
