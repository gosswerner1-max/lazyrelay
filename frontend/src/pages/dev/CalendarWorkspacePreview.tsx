// DEV ONLY page at /dev/calendar-workspace. The Calendar workspace on made-up posts and clicks (nothing real); the Google button only says what it would
// have done. Loaded by App.tsx only behind import.meta.env.DEV, so it is never part of a production build.

import { useState } from "react";
import { CalendarWorkspace, type LinkClickRow } from "../../components/dashboard/CalendarWorkspace";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: `@${brand.toLowerCase()}`, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "brand-" + brand,
});
const ACCOUNTS = [acct("a1", "tiktok", "Alpha"), acct("a2", "facebook", "Alpha"), acct("b1", "facebook", "Beta"), acct("b2", "mastodon", "Beta")];
const BRANDS = [{ id: "brand-Alpha", name: "Alpha" }, { id: "brand-Beta", name: "Beta" }] as unknown as Brand[];

// Posts spread around "now" so the weekly grid and the month matrix always have something to show.
function sample(): ScheduledPost[] {
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const at = (dayOffset: number, hour: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0).toISOString();
  const mk = (id: string, status: ScheduledPost["status"], acc: string, when: string, extra: Record<string, unknown> = {}) =>
    ({ id, status, social_account_id: acc, scheduled_for: when, planned_date: null, paused_at: null, google_event_id: null, content: `Sample post ${id}`, post_results: [], ...extra }) as unknown as ScheduledPost;
  const list = [
    mk("s1", "posted", "a1", at(-1, 9), { google_event_id: "g1" }),
    mk("s2", "pending", "a2", at(0, 12), { google_event_id: "g2" }),
    mk("s3", "pending", "b1", at(1, 10), { paused_at: "2026-01-01T00:00:00Z" }),
    mk("s4", "failed", "b2", at(2, 15)),
  ];
  for (let i = 0; i < 7; i++) list.push(mk("m" + i, "pending", "a1", at(3, 8 + i), { google_event_id: "gm" + i }));
  return list;
}
const POSTS = sample();
const CLICKS: LinkClickRow[] = [{ code: "demo0001", destinationUrl: "https://example.com/launch", platform: "tiktok", brand: "Alpha", scheduledPostId: "s1", createdAt: "2026-01-01T00:00:00Z", clicks: 12, lastClick: new Date().toISOString() }];

export function CalendarWorkspacePreview() {
  const [last, setLast] = useState("Dev preview: nothing is sent from this page.");
  return (
    <div style={{ background: "#0b0f19", minHeight: "100dvh", padding: 24 }}>
      <p style={{ color: "#94a3b8", margin: "0 0 16px" }}>{last}</p>
      <CalendarWorkspace posts={POSTS} accounts={ACCOUNTS} brands={BRANDS} google={{ state: "disconnected" }} linkClicks={CLICKS} onConnectGoogle={() => setLast("Would start the Google Calendar connection.")} />
    </div>
  );
}
