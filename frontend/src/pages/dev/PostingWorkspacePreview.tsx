// DEV ONLY page at /dev/posting-workspace. The Posting workspace on made-up accounts, brands and posts (nothing real), with handlers that only say
// what they would have done. Loaded by App.tsx only behind import.meta.env.DEV, so it is never part of a production build.

import { useState } from "react";
import { PostingWorkspace, type DraftRequest, type ScheduleRequest } from "../../components/dashboard/PostingWorkspace";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: `@${brand.toLowerCase().replace(/\s+/g, "")}`, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "brand-" + brand, ...extra,
});
const ACCOUNTS: SocialAccount[] = [
  ...["bluesky", "devto", "discord", "facebook", "hashnode", "instagram", "lemmy", "mastodon", "pinterest", "slack", "telegram", "tiktok", "tumblr", "whatsapp", "wordpress", "x", "youtube"].map((p) => acct("alpha-" + p, p, "Alpha Brand")),
  ...["facebook", "instagram", "mastodon", "pinterest", "threads", "tiktok", "tumblr"].map((p) => acct("beta-" + p, p, "Beta Brand")),
  ...["facebook", "instagram", "pinterest", "tiktok"].map((p) => acct("gamma-" + p, p, "Gamma Brand")),
  acct("gamma-linkedin", "linkedin", "Gamma Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
];
const BRANDS = ["Alpha Brand", "Beta Brand", "Gamma Brand"].map((name) => ({ id: "brand-" + name, name, voice_profile: null, created_at: "2026-01-01T00:00:00Z" })) as Brand[];
const post = (id: string, status: ScheduledPost["status"], accountId: string | null, when: string | null, paused: string | null): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: when, paused_at: paused, content: "Sample" }) as unknown as ScheduledPost;
const POSTS: ScheduledPost[] = [
  post("d1", "pending", "alpha-tiktok", "2026-10-22T08:00:00Z", "2026-10-20T00:00:00Z"),
  post("d2", "pending", "alpha-facebook", "2026-10-22T09:00:00Z", "2026-10-20T00:00:00Z"),
  post("d3", "pending", "beta-facebook", "2026-10-22T10:00:00Z", null),
  post("d4", "posted", "alpha-tiktok", "2026-10-10T08:00:00Z", null),
  post("d5", "posted", "gamma-tiktok", "2026-10-12T08:00:00Z", null),
  post("d6", "draft", null, null, null),
];

export function PostingWorkspacePreview() {
  const [last, setLast] = useState("Dev preview: nothing is sent from this page.");
  return (
    <div style={{ background: "#0b0f19", minHeight: "100dvh", padding: 24 }}>
      <p style={{ color: "#94a3b8", margin: "0 0 16px" }}>{last}</p>
      <PostingWorkspace
        accounts={ACCOUNTS}
        brands={BRANDS}
        posts={POSTS}
        onSaveDraft={async (d: DraftRequest) => setLast(`Would save a draft (${d.content.length} characters) for ${d.plannedAccountIds.length} account(s).`)}
        onSchedule={async (r: ScheduleRequest) => setLast(`Would schedule ${r.content.length} characters on ${r.accountIds.length} account(s) for ${r.scheduledFor}.`)}
      />
    </div>
  );
}
