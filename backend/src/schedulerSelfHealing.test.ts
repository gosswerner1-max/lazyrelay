// The scheduler with SELF_HEALING_MODE off, shadow and on. Off must behave exactly as before, shadow must change nothing the old
// logic does (it only records), and on follows the approved policy. supabase is an in-memory fake, nothing real is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The mock keeps one stable handle: load() points it at the fake database of the freshly imported modules.
const ctl = vi.hoisted(() => ({ shadowInsert: "ok" as "ok" | "error" | "throw", make: null as null | ((table: string) => unknown) }));

vi.mock("./supabase.js", () => {
  return {
    supabase: {
      from: (t: string) => {
        if (t === "self_healing_shadow_events" && ctl.shadowInsert !== "ok") {
          return { insert: () => (ctl.shadowInsert === "throw" ? Promise.reject(new Error("boom")) : Promise.resolve({ error: { code: "XX000", message: "boom" } })) };
        }
        return ctl.make!(t);
      },
      rpc: async () => ({ data: "token", error: null }),
    },
  };
});
const notifyOps = vi.fn(async (_m: string) => {});
vi.mock("./notify.js", () => ({ notifyOps: (m: string) => notifyOps(m) }));
const sendFailureAlert = vi.fn();
const sendReconnectNeededEmail = vi.fn();
vi.mock("./email.js", () => ({
  sendFailureAlert: (...a: unknown[]) => sendFailureAlert(...a),
  sendAccountPausedAlert: vi.fn(),
  sendPinterestPausedAlert: vi.fn(),
  sendReconnectNeededEmail: (...a: unknown[]) => sendReconnectNeededEmail(...a),
}));
const dispatchWebhookEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: (e: Record<string, unknown>) => dispatchWebhookEvent(e) }));

type Row = Record<string, unknown>;
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const TOO_LATE = "This post was not sent because it was more than 2 hours past its time. Reschedule it if you still want it out.";

async function load() {
  vi.resetModules();
  const f = await import("./testFakeSupabase.js");
  ctl.make = f.makeBuilder;
  const s = await import("./scheduler.js");
  return { tables: f.tables as Record<string, Row[]>, run: s.runSchedulerCycle };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Spec { platform: string; postId: string; saId?: string; account?: Row; post?: Row }
function seed(tables: Record<string, Row[]>, specs: Spec[]) {
  const sa = (s: Spec) => s.saId ?? `sa_${s.platform}`;
  tables.social_accounts = [];
  for (const s of specs) {
    if (tables.social_accounts.some((a) => a.id === sa(s))) continue;
    tables.social_accounts.push({ id: sa(s), account_id: "acc1", platform: s.platform, display_name: "Acct", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null, ...s.account });
  }
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.scheduled_posts = specs.map((s) => ({ id: s.postId, account_id: "acc1", social_account_id: sa(s), content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString(), ...s.post }));
  tables.post_results = [];
}

const fail = (msg: string) => ({ success: false, platformPostId: null, errorMessage: msg });
const adapterOf = (platform: string, post: () => unknown, verify?: () => unknown, extra: Row = {}) => ({
  platform,
  post: vi.fn(async () => post()),
  verifyPublished: vi.fn(async () => (verify ? verify() : { verifiedLive: true, platformPostUrl: "https://x/p", errorMessage: null })),
  ...extra,
});
type Adapter = ReturnType<typeof adapterOf>;
const registryOf = (...adapters: Adapter[]) => ({ get: (p: string) => adapters.find((a) => a.platform === p) }) as never;

const snap = (tables: Record<string, Row[]>) => ({
  posts: tables.scheduled_posts.map((p) => ({ id: p.id, status: p.status, retry_count: p.retry_count, scheduled_for: p.scheduled_for })),
  results: tables.post_results.map((r) => ({ post: r.scheduled_post_id, error_message: r.error_message, raw: r.raw_error_message, verified: r.verified_live })),
  social: tables.social_accounts.map((a) => ({ id: a.id, needs: a.needs_reconnect_at, notified: a.reconnect_notified_at, byok: a.byok_status })),
});

function setMode(mode: string | undefined) {
  if (mode === undefined) delete process.env.SELF_HEALING_MODE;
  else process.env.SELF_HEALING_MODE = mode;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const m of [notifyOps, sendFailureAlert, sendReconnectNeededEmail, dispatchWebhookEvent]) m.mockClear();
  ctl.shadowInsert = "ok";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setMode(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------
// Parity: the same scripted failures under off and under shadow
// ---------------------------------------------------------------------------------------------------------------------------

async function parityScenario(mode: string | undefined, shadowInsert: "ok" | "error" | "throw" = "ok") {
  setMode(mode);
  ctl.shadowInsert = shadowInsert;
  for (const m of [notifyOps, sendFailureAlert, sendReconnectNeededEmail, dispatchWebhookEvent]) m.mockClear();
  vi.setSystemTime(NOW);
  const { tables, run } = await load();
  seed(tables, [
    { platform: "plat_t", postId: "pt" },
    { platform: "pinterest", postId: "pp" },
    { platform: "bluesky", postId: "pb" },
    { platform: "plat_v", postId: "pv" },
    { platform: "plat_ok", postId: "po" },
    { platform: "x", postId: "px", account: { credential_mode: "byok", byok_status: "valid" } },
  ]);
  const reset = Math.floor((NOW + 10 * MIN) / 1000);
  const adapters = [
    adapterOf("plat_t", () => fail("Service unavailable")),
    adapterOf("pinterest", () => fail("Sorry! We blocked this link because it may lead to spam.")),
    adapterOf("bluesky", () => fail("Token has expired")),
    adapterOf("plat_v", () => ({ success: true, platformPostId: "plat-1", errorMessage: null }), () => ({ verifiedLive: false, platformPostUrl: null, errorMessage: "The requested resource does not exist" })),
    adapterOf("plat_ok", () => ({ success: true, platformPostId: "plat-2", errorMessage: null })),
    adapterOf("x", () => fail(`x_api_error status=429 title=Too Many Requests reset=${reset}`)),
  ];
  const frames = [];
  for (let i = 0; i < 7; i++) {
    await run(registryOf(...adapters));
    await flush();
    frames.push(snap(tables));
    vi.setSystemTime(Date.now() + 10 * MIN);
  }
  return {
    frames,
    adapterCalls: adapters.map((a) => a.post.mock.calls),
    verifyCalls: adapters.map((a) => a.verifyPublished.mock.calls.length),
    notify: notifyOps.mock.calls,
    alerts: sendFailureAlert.mock.calls,
    reconnect: sendReconnectNeededEmail.mock.calls,
    hooks: dispatchWebhookEvent.mock.calls.map((c) => c[0]),
    shadowRows: (tables.self_healing_shadow_events ?? []).length,
  };
}

describe("shadow mode changes nothing the old logic does", () => {
  it("with the mode unset the scenario runs as before (control: the scripted failures really exercise every path)", async () => {
    const off = await parityScenario(undefined);
    const final = off.frames[off.frames.length - 1];
    expect(final.posts.find((p) => p.id === "pt")?.status).toBe("failed");
    expect(final.posts.find((p) => p.id === "pp")?.status).toBe("failed");
    expect(final.posts.find((p) => p.id === "pb")?.status).toBe("failed");
    expect(final.posts.find((p) => p.id === "po")?.status).toBe("posted");
    expect(off.reconnect.length).toBe(1);
    expect(off.shadowRows).toBe(0);
  });

  it("off and shadow give identical post state, timers, notifications, webhook events and adapter calls", async () => {
    const off = await parityScenario("off");
    const shadow = await parityScenario("shadow");
    expect(shadow.shadowRows).toBeGreaterThan(0);
    expect({ ...shadow, shadowRows: 0 }).toEqual({ ...off, shadowRows: 0 });
  });

  it("an unrecognised mode value is off", async () => {
    const off = await parityScenario("off");
    const odd = await parityScenario("ON ");
    expect(odd.shadowRows).toBe(0);
    expect(odd).toEqual(off);
  });

  it("a shadow insert that returns an error changes nothing and is logged with the fixed tag", async () => {
    const off = await parityScenario("off");
    const warn = vi.spyOn(console, "warn");
    const bad = await parityScenario("shadow", "error");
    expect(bad).toEqual(off);
    expect(warn).toHaveBeenCalledWith("[self-healing-shadow] insert failed", "XX000");
  });

  it("a shadow insert that throws changes nothing", async () => {
    const off = await parityScenario("off");
    const warn = vi.spyOn(console, "warn");
    const bad = await parityScenario("shadow", "throw");
    expect(bad).toEqual(off);
    expect(warn).toHaveBeenCalledWith("[self-healing-shadow] insert failed", "threw");
  });
});

describe("shadow rows", () => {
  it("record the old and new decision for a failed attempt, with no content or error text", async () => {
    setMode("shadow");
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_t", postId: "pt", post: { retry_count: 1 } }]);
    await run(registryOf(adapterOf("plat_t", () => fail("Service unavailable, secret detail"))));
    await flush();
    expect(tables.self_healing_shadow_events).toHaveLength(1);
    const row = tables.self_healing_shadow_events[0];
    expect(row).toMatchObject({ mode: "shadow", source: "post", post_id: "pt", social_account_id: "sa_plat_t", platform: "plat_t", error_class: "transient", legacy_action: "retry", legacy_delay_ms: 4 * MIN, new_action: "retry", diverged: true, would_alert: false });
    expect(JSON.stringify(row)).not.toMatch(/hello|secret|Service unavailable/);
  });

  it("record a post the new policy would have failed as too_late, while the old logic still publishes it", async () => {
    setMode("shadow");
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_ok", postId: "po", post: { scheduled_for: new Date(NOW - 3 * 60 * MIN).toISOString() } }]);
    const adapter = adapterOf("plat_ok", () => ({ success: true, platformPostId: "plat-2", errorMessage: null }));
    await run(registryOf(adapter));
    await flush();
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.self_healing_shadow_events).toHaveLength(1);
    expect(tables.self_healing_shadow_events[0]).toMatchObject({ legacy_action: "attempt", new_action: "fail", new_reason_code: "too_late", diverged: true, lateness_ms: 3 * 60 * MIN });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// On
// ---------------------------------------------------------------------------------------------------------------------------

describe("on: retry schedule", () => {
  it("retries at 2, 5, 15 and 30 minutes, then the fifth failure is terminal retries_exhausted", async () => {
    setMode("on");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_t", postId: "pt" }]);
    const adapter = adapterOf("plat_t", () => fail("Service unavailable"));
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      await run(registryOf(adapter));
      expect(tables.scheduled_posts[0].status).toBe("pending");
      expect(tables.scheduled_posts[0].retry_count).toBe(i + 1);
      gaps.push((new Date(tables.scheduled_posts[0].scheduled_for as string).getTime() - Date.now()) / MIN);
      vi.setSystemTime(new Date(tables.scheduled_posts[0].scheduled_for as string));
    }
    expect(gaps).toEqual([2, 5, 15, 30]);
    await run(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(tables.scheduled_posts[0].retry_count).toBe(4);
    expect(adapter.post).toHaveBeenCalledTimes(5);
    expect(notifyOps).toHaveBeenCalledTimes(2); // the breaker tripping on the fifth failure, and the permanent failure
    expect(String(notifyOps.mock.calls.map((c) => c[0]).join(" "))).toMatch(/permanently failed after 5 attempts/);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "post.failed", data: expect.objectContaining({ reasonKind: "retries_exhausted" }) }));
  });

  it("applies a jitter factor from the random source", async () => {
    setMode("on");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_t", postId: "pt" }]);
    await run(registryOf(adapterOf("plat_t", () => fail("Service unavailable"))));
    expect(new Date(tables.scheduled_posts[0].scheduled_for as string).getTime() - NOW).toBe(Math.round(2 * MIN * 0.8));
  });

  it("honours the platform's own wait exactly and counts it toward the 4", async () => {
    setMode("on");
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { tables, run } = await load();
    seed(tables, [{ platform: "x", postId: "px", account: { credential_mode: "byok", byok_status: "valid" } }]);
    const reset = Math.floor((NOW + 10 * MIN) / 1000);
    await run(registryOf(adapterOf("x", () => fail(`x_api_error status=429 title=Too Many Requests reset=${reset}`))));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.scheduled_posts[0].retry_count).toBe(1);
    expect(new Date(tables.scheduled_posts[0].scheduled_for as string).getTime()).toBe(reset * 1000);
  });

  it("fatal errors fail at once with the existing plain reason", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [{ platform: "pinterest", postId: "pp" }]);
    const adapter = adapterOf("pinterest", () => fail("Sorry! We blocked this link because it may lead to spam."));
    await run(registryOf(adapter));
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "failed", retry_count: 0 });
    expect(String(tables.post_results[0].error_message)).toMatch(/^Pinterest blocked the link/);
    expect(adapter.post).toHaveBeenCalledTimes(1);
  });

  it("a post the platform may already hold is re-verified, never published twice", async () => {
    setMode("on");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_v", postId: "pv" }]);
    const adapter = adapterOf("plat_v", () => ({ success: true, platformPostId: "plat-1", errorMessage: null }), () => ({ verifiedLive: false, platformPostUrl: null, errorMessage: "The requested resource does not exist" }));
    await run(registryOf(adapter));
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "pending", retry_count: 1 });
    vi.setSystemTime(new Date(tables.scheduled_posts[0].scheduled_for as string));
    await run(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(adapter.verifyPublished).toHaveBeenCalledTimes(2);
  });
});

describe("on: a post is never published more than 2 hours late", () => {
  it("fails at claim time with the plain sentence, without calling the platform", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_ok", postId: "po", post: { scheduled_for: new Date(NOW - 3 * 60 * MIN).toISOString() } }]);
    const adapter = adapterOf("plat_ok", () => ({ success: true, platformPostId: "plat-2", errorMessage: null }));
    await run(registryOf(adapter));
    expect(adapter.post).not.toHaveBeenCalled();
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(tables.post_results[0]).toMatchObject({ error_message: TOO_LATE, raw_error_message: "too_late", verified_live: false });
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "post.failed", data: expect.objectContaining({ reason: TOO_LATE, reasonKind: "too_late" }) }));
  });

  it("a post exactly 2 hours late still goes out", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_ok", postId: "po", post: { scheduled_for: new Date(NOW - 2 * 60 * MIN).toISOString() } }]);
    const adapter = adapterOf("plat_ok", () => ({ success: true, platformPostId: "plat-2", errorMessage: null }));
    await run(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
  });

  it("a retry that would run past the 2 hour mark fails as too_late instead", async () => {
    setMode("on");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_t", postId: "pt", post: { retry_count: 3, scheduled_for: new Date(NOW - 100 * MIN).toISOString() } }]);
    const adapter = adapterOf("plat_t", () => fail("Service unavailable"));
    await run(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(tables.post_results).toHaveLength(2);
    expect(tables.post_results[1]).toMatchObject({ error_message: TOO_LATE, raw_error_message: "too_late" });
  });

  it("a late post the platform already accepted is re-verified, not failed as too late and not published again", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_ok", postId: "po", post: { scheduled_for: new Date(NOW - 3 * 60 * MIN).toISOString() } }]);
    tables.post_results = [{ id: "r1", scheduled_post_id: "po", platform_post_id: "plat-9", verified_live: false, created_at: new Date().toISOString() }];
    const adapter = adapterOf("plat_ok", () => ({ success: true, platformPostId: "plat-2", errorMessage: null }));
    await run(registryOf(adapter));
    expect(adapter.post).not.toHaveBeenCalled();
    expect(adapter.verifyPublished).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
  });

  it("is not applied when the mode is off", async () => {
    setMode(undefined);
    const { tables, run } = await load();
    seed(tables, [{ platform: "plat_ok", postId: "po", post: { scheduled_for: new Date(NOW - 3 * 60 * MIN).toISOString() } }]);
    const adapter = adapterOf("plat_ok", () => ({ success: true, platformPostId: "plat-2", errorMessage: null }));
    await run(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
  });
});

describe("on: a dead login is never retried blindly", () => {
  it("with no refresh path the post fails at once and the connection is flagged and the customer told once", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [{ platform: "bluesky", postId: "pb" }]);
    const adapter = adapterOf("bluesky", () => fail("Token has expired"));
    await run(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
  });

  it("tries one token refresh first when the platform has a refresh path, then holds the connection", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [{ platform: "tiktok", postId: "pk", account: { refresh_token_vault_id: "rv1" } }]);
    const refresh = vi.fn(async () => ({ accessToken: "fresh", refreshToken: null, expiresAt: null }));
    const adapter = adapterOf("tiktok", () => fail("Token has expired"), undefined, { refresh });
    await run(registryOf(adapter));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "pending", retry_count: 1 });
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull();
    vi.setSystemTime(new Date(tables.scheduled_posts[0].scheduled_for as string));
    await run(registryOf(adapter));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(adapter.post).toHaveBeenCalledTimes(2);
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
  });

  it("holds the connection when the refresh itself fails", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [{ platform: "tiktok", postId: "pk", account: { refresh_token_vault_id: "rv1" } }]);
    const refresh = vi.fn(async () => { throw new Error("invalid_grant"); });
    const adapter = adapterOf("tiktok", () => fail("Token has expired"), undefined, { refresh });
    await run(registryOf(adapter));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(adapter.post).toHaveBeenCalledTimes(1);
  });

  it("posts of a connection that needs reconnecting are left alone, other connections go out", async () => {
    setMode("on");
    const { tables, run } = await load();
    seed(tables, [
      { platform: "plat_c", postId: "pa", saId: "saA", account: { needs_reconnect_at: new Date(NOW - MIN).toISOString() } },
      { platform: "plat_c", postId: "pb", saId: "saB" },
    ]);
    const adapter = adapterOf("plat_c", () => ({ success: true, platformPostId: "plat-3", errorMessage: null }));
    await run(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts.find((p) => p.id === "pa")?.status).toBe("pending");
    expect(tables.scheduled_posts.find((p) => p.id === "pb")?.status).toBe("posted");
  });

  it("off and shadow keep claiming them exactly as before", async () => {
    for (const mode of [undefined, "shadow"]) {
      setMode(mode);
      const { tables, run } = await load();
      seed(tables, [{ platform: "plat_c", postId: "pa", saId: "saA", account: { needs_reconnect_at: new Date(NOW - MIN).toISOString() } }]);
      const adapter = adapterOf("plat_c", () => ({ success: true, platformPostId: "plat-3", errorMessage: null }));
      await run(registryOf(adapter));
      expect(adapter.post).toHaveBeenCalledTimes(1);
    }
  });
});

describe("circuit breaker half-open probe", () => {
  async function trippedWorld(mode: string) {
    setMode(mode);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { tables, run } = await load();
    seed(tables, ["p1", "p2", "p3", "p4", "p5"].map((postId) => ({ platform: "plat_b", postId, saId: `sa_${postId}` })));
    let healthy = false;
    const adapter = adapterOf("plat_b", () => (healthy ? { success: true, platformPostId: "plat-b", errorMessage: null } : fail("Service unavailable")));
    await run(registryOf(adapter)); // 5 failures in a row: the shared breaker trips
    const calls = () => adapter.post.mock.calls.length;
    const addDue = (ids: string[]) => {
      for (const id of ids) {
        tables.social_accounts.push({ id: `sa_${id}`, account_id: "acc1", platform: "plat_b", display_name: "Acct", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null });
        tables.scheduled_posts.push({ id, account_id: "acc1", social_account_id: `sa_${id}`, content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString() });
      }
    };
    return { tables, run, adapter, calls, addDue, heal: () => { healthy = true; } };
  }

  it("on: exactly one probe after the cooldown, a failed probe doubles the cooldown, a good probe closes it", async () => {
    const w = await trippedWorld("on");
    expect(w.calls()).toBe(5);

    vi.setSystemTime(NOW + MIN); // still inside the 5 minute cooldown
    w.addDue(["q1"]);
    await w.run(registryOf(w.adapter));
    expect(w.calls()).toBe(5);

    vi.setSystemTime(NOW + 5 * MIN); // cooldown over: the retries of p1..p5 and q1 are all due, only one goes
    await w.run(registryOf(w.adapter));
    expect(w.calls()).toBe(6);

    vi.setSystemTime(NOW + 14 * MIN); // the failed probe re-opened it for 10 minutes (until minute 15)
    await w.run(registryOf(w.adapter));
    expect(w.calls()).toBe(6);

    vi.setSystemTime(NOW + 15 * MIN); // second probe, and the platform has recovered
    w.heal();
    await w.run(registryOf(w.adapter));
    expect(w.calls()).toBe(7);

    vi.setSystemTime(NOW + 16 * MIN); // closed: everything due goes out again
    await w.run(registryOf(w.adapter));
    expect(w.calls()).toBeGreaterThan(8);
  });

  it("off: the old behaviour, every due post goes through once the cooldown ends", async () => {
    const w = await trippedWorld("off");
    vi.setSystemTime(NOW + 5 * MIN);
    await w.run(registryOf(w.adapter));
    expect(w.calls()).toBeGreaterThan(6);
  });

  it("shadow: the old behaviour still decides, the probe the new one would have enforced is only recorded", async () => {
    const w = await trippedWorld("shadow");
    vi.setSystemTime(NOW + 5 * MIN);
    await w.run(registryOf(w.adapter));
    await flush();
    expect(w.calls()).toBeGreaterThan(6);
    const denied = (w.tables.self_healing_shadow_events ?? []).filter((r) => r.source === "breaker" && r.new_action === "deny_probe");
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]).toMatchObject({ legacy_action: "admit", platform: "plat_b", diverged: true });
  });
});
