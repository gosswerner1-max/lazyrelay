// Recurring generation while WhatsApp sending is not built: an active slot that still has a WhatsApp target (made before the
// guard, or written straight to the database) generates posts for its other targets and none for WhatsApp. supabase is an
// in-memory fake; nothing real is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

let genCounter = 0;
vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => {
        const b: any = f.makeBuilder(t);
        if (t === "scheduled_posts") {
          // The shared fake's upsert handles one row; the generator upserts a batch.
          b.upsert = (rows: Array<Record<string, unknown>>) => {
            const inserted = rows.map((r) => ({ id: `gen${++genCounter}`, status: "pending", ...r }));
            (tables.scheduled_posts ??= []).push(...inserted);
            const q: any = { select: () => q, then: (res: (v: unknown) => unknown) => Promise.resolve({ data: inserted.map((r) => ({ id: r.id })), error: null }).then(res) };
            return q;
          };
        }
        return b;
      },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});
vi.mock("./googleCalendar/outboundSync.js", () => ({ syncPostToCalendar: async () => {} }));
vi.mock("./googleSheets/outboundSync.js", () => ({ syncAccountSheet: async () => {} }));

const { generateDuePosts } = await import("./recurringScheduler.js");

const slot = (targets: string[]) => ({
  id: "rs1",
  account_id: "acc1",
  status: "active",
  content: "Weekly",
  media_url: null,
  cover_image_url: null,
  board_id: null,
  destination_link: null,
  first_comment: null,
  first_comment_delay_minutes: null,
  tags: [],
  media_urls: [],
  self_reply_text: null,
  self_reply_at_likes: null,
  options: null,
  tiktok_privacy_level: null,
  tiktok_disable_comment: true,
  tiktok_disable_duet: true,
  tiktok_disable_stitch: true,
  tiktok_brand_organic: false,
  tiktok_brand_content: false,
  days_of_week: [1, 2, 3, 4, 5, 6, 7],
  time_of_day: "23:59:00",
  timezone: "UTC",
  starts_on: "2020-01-01",
  ends_on: null,
  recurring_schedule_targets: targets.map((social_account_id) => ({ social_account_id })),
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  tables.subscriptions = [{ account_id: "acc1", tier: "business", status: "active" }];
  tables.social_accounts = [
    { id: "wa", account_id: "acc1", platform: "whatsapp", paused_at: null },
    { id: "tg", account_id: "acc1", platform: "telegram", paused_at: null },
    { id: "ms", account_id: "acc1", platform: "mastodon", paused_at: null },
  ];
  tables.scheduled_posts = [];
});

describe("recurring generation", () => {
  it("generates posts for the other targets of a slot and none for its WhatsApp target", async () => {
    tables.recurring_schedules = [slot(["tg", "wa", "ms"])];
    await generateDuePosts();
    const rows = tables.scheduled_posts;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.social_account_id === "wa")).toHaveLength(0);
    const perAccount = (id: string) => rows.filter((r) => r.social_account_id === id).length;
    expect(perAccount("tg")).toBeGreaterThan(0);
    expect(perAccount("tg")).toBe(perAccount("ms"));
  });

  it("a slot whose only target is WhatsApp generates nothing at all", async () => {
    tables.recurring_schedules = [slot(["wa"])];
    await generateDuePosts();
    expect(tables.scheduled_posts).toHaveLength(0);
  });

  it("a slot without WhatsApp is generated exactly as before", async () => {
    tables.recurring_schedules = [slot(["tg"])];
    await generateDuePosts();
    expect(tables.scheduled_posts.length).toBeGreaterThanOrEqual(6);
    expect(tables.scheduled_posts.every((r) => r.social_account_id === "tg" && r.recurring_schedule_id === "rs1")).toBe(true);
  });
});
