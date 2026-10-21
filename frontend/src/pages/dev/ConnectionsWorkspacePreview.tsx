// DEV ONLY page at /dev/connections-workspace. The Connections workspace on made-up accounts, brands and posts (nothing real); the hand-over only says
// what it would have done. Loaded by App.tsx only behind import.meta.env.DEV, so it is never part of a production build.

import { useState } from "react";
import { ConnectionsWorkspace } from "../../components/dashboard/ConnectionsWorkspace";
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
const post = (id: string, accountId: string, paused: string | null): ScheduledPost =>
  ({ id, status: "pending", social_account_id: accountId, scheduled_for: "2026-10-22T08:00:00Z", paused_at: paused, content: "Sample" }) as unknown as ScheduledPost;
const POSTS: ScheduledPost[] = [post("d1", "alpha-tiktok", "2026-10-20T00:00:00Z"), post("d2", "alpha-facebook", "2026-10-20T00:00:00Z"), post("d3", "beta-facebook", null)];

export function ConnectionsWorkspacePreview() {
  const [last, setLast] = useState("Dev preview: nothing is connected or sent from this page.");
  return (
    <div style={{ background: "#0b0f19", minHeight: "100dvh", padding: 24 }}>
      <p style={{ color: "#94a3b8", margin: "0 0 16px" }}>{last}</p>
      <ConnectionsWorkspace
        accounts={ACCOUNTS}
        brands={BRANDS}
        posts={POSTS}
        gcalStatus={{ last_synced_at: "2026-10-20T10:00:00Z" }}
        gsheetStatus={null}
        onOpenSocialPlatforms={() => setLast("Would open the Social Platforms tab.")}
      />
    </div>
  );
}
