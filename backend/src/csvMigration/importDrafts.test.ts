// Confirm-step tests: drafts only, one batch, idempotent, capped. Uses the in-memory fake database, never a real one.
// Fixtures follow the STATED layouts, they are NOT real exports.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables, makeBuilder } from "../testFakeSupabase.js";

vi.mock("../supabase.js", () => ({ supabase: {} }));

const { analyzeCsv } = await import("./analyze.js");
const { importDrafts } = await import("./importDrafts.js");
const { MAX_DRAFTS_PER_REQUEST } = await import("./limits.js");

const NOW = new Date("2029-06-15T10:00:00.000Z");
const analysis = (s: string) => analyzeCsv(Buffer.from(s, "utf8"), { now: NOW });

function countingDb() {
  const inserts: unknown[][] = [];
  return {
    inserts,
    db: {
      from: (t: string) => {
        const b = makeBuilder(t) as Record<string, any>;
        const insert = b.insert;
        b.insert = (p: any) => (inserts.push(Array.isArray(p) ? p : [p]), insert(p));
        return b;
      },
    } as any,
  };
}

// STATED Buffer layout, not a real export.
const FILE = "Text,Link,Posting Time\nFirst,https://example.com/1,2030-05-17 14:30\nSecond,,2020-01-01 10:00\nThird,,\n";

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("importDrafts", () => {
  it("creates unscheduled drafts in one batch, owned by the caller's account", async () => {
    const { db, inserts } = countingDb();
    const r = await importDrafts(db, "acc1", analysis(FILE));
    expect(r.created).toBe(3);
    expect(r.draftIds).toHaveLength(3);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toHaveLength(3);
    for (const row of tables.scheduled_posts) {
      expect(row).toMatchObject({ account_id: "acc1", status: "draft", social_account_id: null, scheduled_for: null });
    }
    expect(tables.scheduled_posts[0]).toMatchObject({ content: "First\n\nhttps://example.com/1", planned_date: "2030-05-17" });
    expect(tables.scheduled_posts[1].planned_date).toBeNull();
  });

  it("never approves, schedules or publishes: only the draft status is ever written", async () => {
    await importDrafts(countingDb().db, "acc1", analysis(FILE));
    expect(new Set(tables.scheduled_posts.map((r) => r.status))).toEqual(new Set(["draft"]));
    expect(tables.scheduled_posts.every((r) => r.scheduled_for === null && r.social_account_id === null)).toBe(true);
  });

  it("tags each draft with the source tag and a row tag that follow the tag rules", async () => {
    await importDrafts(countingDb().db, "acc1", analysis(FILE));
    for (const row of tables.scheduled_posts) {
      const tags = row.tags as string[];
      expect(tags[0]).toBe("import:buffer");
      expect(tags[1]).toMatch(/^ih-[0-9a-f]{16}$/);
      expect(tags.every((t) => t.length <= 30 && t === t.toLowerCase())).toBe(true);
    }
  });

  it("is idempotent: confirming the same file again creates nothing and says why", async () => {
    const a = analysis(FILE);
    await importDrafts(countingDb().db, "acc1", a);
    const { db, inserts } = countingDb();
    const again = await importDrafts(db, "acc1", a);
    expect(again.created).toBe(0);
    expect(again.draftIds).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(["already_imported", "already_imported", "already_imported"]);
    expect(inserts).toHaveLength(0);
    expect(tables.scheduled_posts).toHaveLength(3);
  });

  it("does not let another account's imports block this one", async () => {
    const a = analysis(FILE);
    await importDrafts(countingDb().db, "acc1", a);
    const r = await importDrafts(countingDb().db, "acc2", a);
    expect(r.created).toBe(3);
  });

  it("reports rows the analysis already skipped alongside the new ones", async () => {
    const r = await importDrafts(countingDb().db, "acc1", analysis("Text,Link\nA,\n,\nA,\n"));
    expect(r.created).toBe(1);
    expect(r.skipped).toEqual([
      { row: 3, reason: "empty_text" },
      { row: 4, reason: "duplicate" },
    ]);
  });

  it("caps one request and lets a second confirm finish the rest", async () => {
    const total = MAX_DRAFTS_PER_REQUEST + 50;
    const a = analysis("Text\n" + Array.from({ length: total }, (_, i) => `Post ${i}`).join("\n") + "\n");
    const first = await importDrafts(countingDb().db, "acc1", a);
    expect(first.created).toBe(MAX_DRAFTS_PER_REQUEST);
    expect(first.remaining).toBe(50);
    const second = await importDrafts(countingDb().db, "acc1", a);
    expect(second.created).toBe(50);
    expect(second.remaining).toBe(0);
    expect(tables.scheduled_posts).toHaveLength(total);
  });

  it("lets a database failure surface instead of hiding it", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ overlaps: async () => ({ data: null, error: { message: "boom" } }) }) }) }) } as any;
    await expect(importDrafts(db, "acc1", analysis(FILE))).rejects.toThrow(/boom/);
  });
});
