// DEV ONLY page at /dev/brands-workspace. The Brands workspace on made-up accounts, brands and posts (nothing real), with a save handler that only says
// what it would have done. Loaded by App.tsx only behind import.meta.env.DEV, so it is never part of a production build.

import { useState } from "react";
import { BrandsWorkspace } from "../../components/dashboard/BrandsWorkspace";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: `@${brand.toLowerCase().replace(/\s+/g, "")}`, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "brand-" + brand, ...extra,
});
const ACCOUNTS: SocialAccount[] = [
  ...["bluesky", "facebook", "instagram", "mastodon", "pinterest", "tiktok", "x", "youtube"].map((p) => acct("alpha-" + p, p, "Alpha Brand")),
  ...["facebook", "instagram", "tiktok"].map((p) => acct("beta-" + p, p, "Beta Brand")),
  acct("gamma-facebook", "facebook", "Gamma Brand"),
  acct("gamma-linkedin", "linkedin", "Gamma Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
];
const VOICES: Record<string, string | null> = { "Alpha Brand": "Warm, plain and short. No jargon.", "Beta Brand": null, "Gamma Brand": null };
const BRANDS = ["Alpha Brand", "Beta Brand", "Gamma Brand"].map((name) => ({ id: "brand-" + name, name, voice_profile: VOICES[name], created_at: "2026-01-01T00:00:00Z" })) as Brand[];

const DAY_MS = 24 * 60 * 60 * 1000;
const post = (id: string, status: ScheduledPost["status"], accountId: string | null, when: Date | null, paused: string | null): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: when ? when.toISOString() : null, paused_at: paused, content: "Sample" }) as unknown as ScheduledPost;
function samplePosts(now: Date): ScheduledPost[] {
  const out: ScheduledPost[] = [];
  for (let i = 0; i < 30; i += 1) {
    const when = new Date(now.getTime() - (i * DAY_MS + 3 * 60 * 60 * 1000));
    if (i % 2 === 0) out.push(post(`pa${i}`, "posted", "alpha-tiktok", when, null));
    if (i % 3 === 0) out.push(post(`pb${i}`, "posted", "alpha-facebook", when, null));
    if (i % 5 === 0) out.push(post(`pc${i}`, "posted", "beta-instagram", when, null));
  }
  out.push(post("q1", "pending", "alpha-tiktok", new Date(now.getTime() + DAY_MS), now.toISOString()));
  out.push(post("q2", "pending", "alpha-facebook", new Date(now.getTime() + 2 * DAY_MS), now.toISOString()));
  out.push(post("q3", "pending", "beta-facebook", new Date(now.getTime() + 2 * DAY_MS), null));
  return out;
}

export function BrandsWorkspacePreview() {
  const [last, setLast] = useState("Dev preview: nothing is sent from this page.");
  const [now] = useState(() => new Date());
  const [posts] = useState(() => samplePosts(now));
  return (
    <div style={{ background: "#0b0f19", minHeight: "100dvh", padding: 24 }}>
      <p style={{ color: "#94a3b8", margin: "0 0 16px" }}>{last}</p>
      <BrandsWorkspace
        accounts={ACCOUNTS}
        brands={BRANDS}
        posts={posts}
        brandCapacity={{ addons: [], baseLimit: 3, addonSlots: 0, totalLimit: 3 }}
        now={now}
        onSaveVoice={async (_id, name, voice) => setLast(`Would save the voice for ${name} (${voice ? voice.length + " characters" : "cleared"}).`)}
        onOpenSocialPlatforms={() => setLast("Would open the Social Platforms tab.")}
      />
    </div>
  );
}
