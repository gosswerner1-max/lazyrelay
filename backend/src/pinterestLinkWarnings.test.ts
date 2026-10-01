// The scheduling-time Pinterest heads-up (pinterestLinkWarnings.ts): a pin that
// links to a host Pinterest recently blocked (for any account, last 30 days) gets
// a warning in the response, and nothing else changes. supabase is an in-memory
// fake, nothing real is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";
import { PINTEREST_BLOCKED_LINK_MESSAGE } from "./postErrors.js";

// Lets a test make every read of one table fail, to prove the lookup fails open.
let failReadsOn: string | null = null;
vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => {
        const b = f.makeBuilder(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t !== failReadsOn) return b;
        const realSelect = b.select;
        b.select = (...a: unknown[]) => {
          const chain = realSelect(...a) as Record<string, unknown>;
          chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
          return chain;
        };
        return b;
      },
    },
  };
});
vi.mock("./googleCalendar/outboundSync.js", () => ({ syncPostToCalendar: vi.fn(async () => {}) }));
vi.mock("./googleSheets/outboundSync.js", () => ({ syncAccountSheet: vi.fn(async () => {}) }));
vi.mock("./pinterestWarmup.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./pinterestWarmup.js")>();
  return { ...real, resolvePostLimitAt: async (_id: string, platform: string, at: Date) => real.effectiveLimitAt(platform, { connectedAt: null, confirmed: true }, at) };
});

const { checkPinterestLinkWarnings, extractLinkHosts, pinterestLinkWarningMessage } = await import("./pinterestLinkWarnings.js");
const { scheduleOnePost } = await import("./postCreation.js");

const DAY = 24 * 60 * 60 * 1000;
const RAW = "Sorry! We blocked this link because it may lead to spam.";
let n = 0;

/** Some OTHER customer's pin that Pinterest rejected for its link. */
function blockedPin(content: string, over: { agoMs?: number; platform?: string; destinationLink?: string | null; raw?: boolean } = {}) {
  n += 1;
  const at = new Date(Date.now() - (over.agoMs ?? DAY)).toISOString();
  const saId = `sa-other-${n}`;
  tables.social_accounts.push({ id: saId, account_id: `someone-else-${n}`, platform: over.platform ?? "pinterest" });
  tables.scheduled_posts.push({ id: `bp${n}`, account_id: `someone-else-${n}`, social_account_id: saId, content, destination_link: over.destinationLink ?? null, status: "failed" });
  tables.post_results.push({
    id: `br${n}`,
    scheduled_post_id: `bp${n}`,
    account_id: `someone-else-${n}`,
    error_message: over.raw ? RAW : PINTEREST_BLOCKED_LINK_MESSAGE,
    raw_error_message: over.raw ? null : RAW,
    created_at: at,
  });
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  failReadsOn = null;
  tables.social_accounts = [{ id: "mine", account_id: "me", platform: "pinterest" }];
  tables.scheduled_posts = [];
  tables.post_results = [];
  tables.subscriptions = [{ account_id: "me", tier: "pro", status: "active" }];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("extractLinkHosts", () => {
  it("returns the lowercase hosts of http and https links, without www and without duplicates", () => {
    expect(extractLinkHosts("See https://www.Example.com/a?b=1 and http://shop.example.org, also https://example.com/x. Not a link: example.net")).toEqual(["example.com", "shop.example.org"]);
    expect(extractLinkHosts(null)).toEqual([]);
    expect(extractLinkHosts("ftp://files.example.com and plain words")).toEqual([]);
  });
});

describe("checkPinterestLinkWarnings", () => {
  it("warns about a link host that another account's pin was blocked for, in the agreed words", async () => {
    blockedPin("New post https://blocked-site.com/page");
    const warnings = await checkPinterestLinkWarnings({ platform: "pinterest", content: "Read this: https://blocked-site.com/other" });
    expect(warnings).toEqual([{ code: "pinterest_link_recently_blocked", host: "blocked-site.com", message: pinterestLinkWarningMessage("blocked-site.com") }]);
    expect(warnings[0].message).toBe(
      "Pinterest recently blocked links to blocked-site.com on some pins. Your pin may fail. You can still schedule it. If it fails, ask Pinterest to review the website address in Pinterest's Help Center.",
    );
    expect(warnings[0].message).not.toMatch(/[–—]/);
  });

  it("matches the Pinterest destination link field, www and subdomains, and rows that only hold the raw text", async () => {
    blockedPin("no link in the caption", { destinationLink: "https://www.blocked-site.com/landing", raw: true });
    expect((await checkPinterestLinkWarnings({ platform: "pinterest", content: "x", destinationLink: "https://blocked-site.com/a" })).map((w) => w.host)).toEqual(["blocked-site.com"]);
    expect((await checkPinterestLinkWarnings({ platform: "pinterest", content: "https://blog.blocked-site.com/a" })).map((w) => w.host)).toEqual(["blocked-site.com"]);
  });

  it("gives no warning for a clean host, no links, or another platform", async () => {
    blockedPin("https://blocked-site.com/page");
    expect(await checkPinterestLinkWarnings({ platform: "pinterest", content: "https://fine-site.com/page" })).toEqual([]);
    expect(await checkPinterestLinkWarnings({ platform: "pinterest", content: "https://not-blocked-site.com" })).toEqual([]); // a different host that merely ends the same way
    expect(await checkPinterestLinkWarnings({ platform: "pinterest", content: "no links here" })).toEqual([]);
    expect(await checkPinterestLinkWarnings({ platform: "bluesky", content: "https://blocked-site.com/page" })).toEqual([]);
  });

  it("ignores failures older than 30 days and blocked-link text from other platforms", async () => {
    blockedPin("https://old-site.com", { agoMs: 31 * DAY });
    blockedPin("https://mastodon-site.com", { platform: "mastodon", raw: true });
    expect(await checkPinterestLinkWarnings({ platform: "pinterest", content: "https://old-site.com https://mastodon-site.com" })).toEqual([]);
  });

  it("never reports a host the customer did not link to, and returns no account ids or content", async () => {
    blockedPin("secret campaign https://blocked-site.com/private-page https://another-blocked.com");
    const warnings = await checkPinterestLinkWarnings({ platform: "pinterest", content: "https://blocked-site.com" });
    expect(warnings).toHaveLength(1);
    expect(Object.keys(warnings[0]).sort()).toEqual(["code", "host", "message"]);
    expect(JSON.stringify(warnings)).not.toMatch(/secret campaign|private-page|another-blocked|someone-else|sa-other/);
  });

  it("fails open: a lookup error means no warning, never an exception", async () => {
    blockedPin("https://blocked-site.com/page");
    failReadsOn = "post_results";
    expect(await checkPinterestLinkWarnings({ platform: "pinterest", content: "https://blocked-site.com" })).toEqual([]);
    failReadsOn = "scheduled_posts";
    expect(await checkPinterestLinkWarnings({ platform: "pinterest", content: "https://blocked-site.com" })).toEqual([]);
  });
});

describe("scheduling a Pinterest pin", () => {
  const input = (content: string) => ({ socialAccountId: "mine", content, scheduledFor: new Date(Date.now() + DAY).toISOString() });

  it("still creates the post, and the response carries the warning", async () => {
    blockedPin("https://blocked-site.com/page");
    const result = await scheduleOnePost("me", input("Shop https://blocked-site.com/new"));
    expect(result.status).toBe(201);
    expect(result.body.content).toBe("Shop https://blocked-site.com/new"); // never changed
    expect(result.body.status).toBe("pending");
    expect(result.body.warnings).toEqual([expect.objectContaining({ code: "pinterest_link_recently_blocked", host: "blocked-site.com" })]);
    expect(tables.scheduled_posts.filter((p) => p.account_id === "me")).toHaveLength(1);
  });

  it("has no warnings field for a clean link", async () => {
    blockedPin("https://blocked-site.com/page");
    const result = await scheduleOnePost("me", input("Shop https://fine-site.com/new"));
    expect(result.status).toBe(201);
    expect(result.body).not.toHaveProperty("warnings");
  });

  it("still creates the post when the lookup fails", async () => {
    blockedPin("https://blocked-site.com/page");
    failReadsOn = "post_results";
    const result = await scheduleOnePost("me", input("Shop https://blocked-site.com/new"));
    expect(result.status).toBe(201);
    expect(result.body).not.toHaveProperty("warnings");
  });
});
