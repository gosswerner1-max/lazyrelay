// DEV ONLY page at /dev/failures-workspace. The Failures workspace on made-up accounts and posts (nothing real); "Open in Posts" only says what it would
// have done. Loaded by App.tsx only behind import.meta.env.DEV, so it is never part of a production build.

import { useState } from "react";
import { FailuresWorkspace } from "../../components/dashboard/FailuresWorkspace";
import type { ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: `@${brand.toLowerCase().replace(/\s+/g, "")}`, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "brand-" + brand,
});
const ACCOUNTS: SocialAccount[] = [
  acct("alpha-tiktok", "tiktok", "Alpha Brand"), acct("alpha-mastodon", "mastodon", "Alpha Brand"), acct("alpha-pinterest", "pinterest", "Alpha Brand"),
  acct("beta-facebook", "facebook", "Beta Brand"), acct("beta-discord", "discord", "Beta Brand"),
];
const post = (id: string, status: ScheduledPost["status"], accountId: string, when: string, errors: Array<string | null>): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: when, content: "Sample", post_results: errors.map((e) => ({ verified_live: e === null, platform_post_url: null, error_message: e })) }) as unknown as ScheduledPost;
const POSTS: ScheduledPost[] = [
  post("f1", "failed", "alpha-tiktok", "2026-10-21T08:00:00Z", ["Token has expired"]),
  post("f2", "failed", "alpha-tiktok", "2026-10-20T08:00:00Z", ["token has expired"]),
  post("f3", "failed", "alpha-pinterest", "2026-10-19T08:00:00Z", ["Sorry! We blocked this link because it may lead to spam."]),
  post("f4", "failed", "beta-facebook", "2026-10-18T08:00:00Z", ["Something odd happened"]),
  post("r1", "posted", "alpha-mastodon", "2026-10-17T08:00:00Z", ["Rate limit reached", null]),
  post("r2", "posted", "beta-discord", "2026-10-16T08:00:00Z", ["Rate limit reached", "Rate limit reached", null]),
  post("ok1", "posted", "alpha-tiktok", "2026-10-15T08:00:00Z", [null]),
  post("ok2", "posted", "beta-facebook", "2026-10-14T08:00:00Z", [null]),
];

export function FailuresWorkspacePreview() {
  const [last, setLast] = useState("Dev preview: nothing is sent from this page.");
  return (
    <div style={{ background: "#0b0f19", minHeight: "100dvh", padding: 24 }}>
      <p style={{ color: "#94a3b8", margin: "0 0 16px" }}>{last}</p>
      <FailuresWorkspace accounts={ACCOUNTS} posts={POSTS} onOpenFailed={() => setLast("Would open the Failed tab.")} />
    </div>
  );
}
