// The wallet gate through the REAL scheduler: hold before the adapter sends, commit only after verifyPublished says live, release on
// every other outcome. supabase is an in-memory fake and so is the wallet (rpc). Nothing real is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

const PRICE = 1_000_000;
interface Hold { id: string; account: string; key: string; status: "held" | "committed" | "released" | "expired" }
const wallet = { balance: new Map<string, number>(), holds: [] as Hold[], calls: [] as string[], paused: [] as string[], charges: [] as string[], n: 0 };
const spendable = (acc: string) => (wallet.balance.get(acc) ?? 0) - wallet.holds.filter((h) => h.account === acc && h.status === "held").length * PRICE;
const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function walletRpc(fn: string, a: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
  wallet.calls.push(fn);
  const acc = a.p_account_id as string;
  if (fn === "wallet_paused_account_ids") return { data: wallet.paused, error: null };
  if (fn === "wallet_hold") {
    const existing = wallet.holds.find((h) => h.account === acc && h.key === a.p_key);
    if (existing) return { data: { ok: true, replay: true, hold_id: existing.id, held_micro: PRICE, status: existing.status }, error: null };
    if (spendable(acc) < PRICE) return { data: { ok: false, reason: "insufficient_credits", balance_micro: spendable(acc), required_micro: PRICE }, error: null };
    const h: Hold = { id: uuidOf(++wallet.n), account: acc, key: a.p_key as string, status: "held" };
    wallet.holds.push(h);
    (tables.wallet_holds ??= []).push({ id: h.id, account_id: acc, idempotency_key: h.key, status: "held" }); // what findHold reads
    return { data: { ok: true, replay: false, hold_id: h.id, held_micro: PRICE }, error: null };
  }
  if (fn === "wallet_commit" || fn === "wallet_release") {
    const h = wallet.holds.find((x) => x.id === a.p_hold_id)!;
    if (fn === "wallet_commit") {
      if (h.status === "committed") return { data: { ok: true, replay: true, committed_micro: PRICE, balance_micro: wallet.balance.get(h.account) ?? 0 }, error: null };
      if (h.status !== "held") return { data: { ok: false, reason: "hold_not_held", status: h.status }, error: null };
      h.status = "committed";
      wallet.balance.set(h.account, (wallet.balance.get(h.account) ?? 0) - PRICE);
      return { data: { ok: true, replay: false, committed_micro: PRICE, balance_micro: wallet.balance.get(h.account) }, error: null };
    }
    if (h.status === "released") return { data: { ok: true, replay: true }, error: null };
    if (h.status !== "held") return { data: { ok: false, reason: "hold_not_held", status: h.status }, error: null };
    h.status = "released";
    return { data: { ok: true, replay: false }, error: null };
  }
  if (fn === "wallet_charge") {
    wallet.charges.push(a.p_key as string);
    wallet.balance.set(acc, (wallet.balance.get(acc) ?? 0) - PRICE);
    return { data: { ok: true, replay: false, charged_micro: PRICE, balance_micro: wallet.balance.get(acc) }, error: null };
  }
  return { data: "token", error: null }; // read_social_token
}

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => walletRpc(fn, args) } };
});
vi.mock("./notify.js", () => ({ notifyOps: async () => {} }));
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendReconnectNeededEmail: vi.fn() }));
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: async () => {} }));

const { runSchedulerCycle, recoverStuckPosts } = await import("./scheduler.js");
const { INSUFFICIENT_CREDITS_REASON } = await import("./wallet/publishGate.js");

const SCHEDULED_FOR = new Date(Date.now() - 60_000).toISOString();
let n = 0;
let sweepClock = Date.now();
const nextSweepNow = () => (sweepClock += 3 * 3_600_000);
const newAccount = () => uuidOf(900 + ++n);

function seed(acc: string, posts: Array<Record<string, unknown>>, credits: number | null) {
  tables.social_accounts = [{ id: "sa1", account_id: acc, platform: "gateplat", display_name: "A", platform_account_id: "pa1", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null }];
  tables.accounts = [{ id: acc, email: "a@b.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.post_results = [];
  tables.wallet_legacy_accounts = [];
  tables.scheduled_posts = posts.map((p, i) => ({ id: `gp${n}-${i}`, account_id: acc, social_account_id: "sa1", content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: SCHEDULED_FOR, updated_at: new Date().toISOString(), ...p }));
  if (credits !== null) wallet.balance.set(acc, credits * PRICE);
}
const live = { verifiedLive: true, platformPostUrl: "https://x/p", errorMessage: null };
const adapterOf = (verification: unknown = live, postResult: unknown = { success: true, platformPostId: "plat-1", errorMessage: null }) => ({
  platform: "gateplat",
  post: vi.fn(async (_r: Record<string, unknown>) => postResult),
  verifyPublished: vi.fn(async () => verification),
});
const registryOf = (a: { platform: string }) => ({ get: (p: string) => (p === a.platform ? a : undefined) }) as never;
const heldNow = (acc: string) => wallet.holds.filter((h) => h.account === acc && h.status === "held").length;
const committed = (acc: string) => wallet.holds.filter((h) => h.account === acc && h.status === "committed").length;
let logs: string[];

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  wallet.balance.clear();
  wallet.holds.length = 0;
  tables.wallet_holds = [];
  wallet.calls.length = 0;
  wallet.paused.length = 0;
  wallet.charges.length = 0;
  logs = [];
  vi.stubEnv("WALLET_ENABLED", "true");
  vi.stubEnv("WALLET_MODE", "on");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("wallet on, a normal account", () => {
  it("success: one hold before the send, committed once after it is verified live", async () => {
    const acc = newAccount();
    seed(acc, [{}], 5);
    const a = adapterOf();
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(wallet.holds).toHaveLength(1);
    expect(wallet.holds[0].key).toBe(`post:${tables.scheduled_posts[0].id}:a1`);
    expect(committed(acc)).toBe(1);
    expect(wallet.balance.get(acc)).toBe(4 * PRICE);
    // the hold was taken BEFORE the adapter was called
    expect(wallet.calls.indexOf("wallet_hold")).toBeLessThan(wallet.calls.indexOf("wallet_commit"));
  });

  it("the post is sent only after the hold exists (order check)", async () => {
    const acc = newAccount();
    seed(acc, [{}], 5);
    const a = adapterOf();
    a.post.mockImplementation(async () => {
      expect(heldNow(acc)).toBe(1);
      return { success: true, platformPostId: "plat-1", errorMessage: null };
    });
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
  });

  it("the adapter reports a failure: the hold is released and nothing is charged", async () => {
    const acc = newAccount();
    seed(acc, [{}], 5);
    const a = adapterOf(live, { success: false, platformPostId: null, errorMessage: "temporary network glitch" });
    await runSchedulerCycle(registryOf(a));
    expect(wallet.holds.map((h) => h.status)).toEqual(["released"]);
    expect(wallet.balance.get(acc)).toBe(5 * PRICE);
    expect(tables.scheduled_posts[0].status).not.toBe("posted");
  });

  it("verification says it is not live: the hold is released, nothing is charged", async () => {
    const acc = newAccount();
    seed(acc, [{}], 5);
    const a = adapterOf({ verifiedLive: false, platformPostUrl: null, errorMessage: "could not confirm" });
    await runSchedulerCycle(registryOf(a));
    expect(wallet.holds.map((h) => h.status)).toEqual(["released"]);
    expect(wallet.balance.get(acc)).toBe(5 * PRICE);
  });

  it("the adapter throws: the hold is released", async () => {
    const acc = newAccount();
    seed(acc, [{}], 5);
    const a = adapterOf();
    a.post.mockRejectedValue(new Error("socket hang up"));
    await runSchedulerCycle(registryOf(a));
    expect(wallet.holds.map((h) => h.status)).toEqual(["released"]);
  });

  it("a draft-only platform result (saved as a draft, not live) is not charged: the hold is released", async () => {
    const acc = newAccount();
    seed(acc, [{}], 5);
    const a = adapterOf({ verifiedLive: false, savedAsDraft: true, platformPostUrl: "https://blog/draft", errorMessage: null });
    await runSchedulerCycle(registryOf(a));
    expect(tables.scheduled_posts[0].status).toBe("posted"); // finished job, as today
    expect(wallet.holds.map((h) => h.status)).toEqual(["released"]); // but it never went live, so it costs nothing
    expect(wallet.balance.get(acc)).toBe(5 * PRICE);
  });

  it("empty wallet: the post is not sent, stays pending (not failed), keeps its retry count and shows a reason; a top up lets it go", async () => {
    const acc = newAccount();
    seed(acc, [{}], 0);
    const a = adapterOf();
    await runSchedulerCycle(registryOf(a));
    const row = tables.scheduled_posts[0];
    expect(a.post).not.toHaveBeenCalled();
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(0);
    expect(String(row.wallet_hold_reason)).toMatch(/credits/i);
    expect(wallet.holds).toHaveLength(0);

    await runSchedulerCycle(registryOf(a)); // still empty on a later tick: still waiting
    expect(a.post).not.toHaveBeenCalled();
    expect(row.status).toBe("pending");

    wallet.balance.set(acc, 3 * PRICE); // top up
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("posted");
    expect(row.wallet_hold_reason ?? null).toBeNull();
    expect(wallet.balance.get(acc)).toBe(2 * PRICE);
  });

  it("drained wallet on the claim path: the pause list skips the account, yet its due post still shows the reason; a top up clears it", async () => {
    const acc = newAccount();
    const other = newAccount();
    seed(acc, [{}], 0);
    tables.scheduled_posts.push({ id: "other-1", account_id: other, social_account_id: "sa1", content: "x", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: SCHEDULED_FOR, updated_at: new Date().toISOString() });
    const row = tables.scheduled_posts[0];
    const a = adapterOf();
    wallet.balance.set(other, 5 * PRICE);
    wallet.paused.push(acc); // the wallet row exists with a balance below the cheapest action
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1); // only the other account's post went out
    expect(row.status).toBe("pending");
    expect(String(row.wallet_hold_reason)).toBe(INSUFFICIENT_CREDITS_REASON);
    expect(tables.scheduled_posts[1].wallet_hold_reason).toBeUndefined(); // another account is untouched
    wallet.paused.length = 0; // top up
    wallet.balance.set(acc, 3 * PRICE);
    await runSchedulerCycle(registryOf(a));
    expect(row.status).toBe("posted");
    expect(row.wallet_hold_reason ?? null).toBeNull();
  });

  it("a fan-out group (one charge_group_id, two posts) is charged one credit in total", async () => {
    const acc = newAccount();
    const group = uuidOf(777);
    seed(acc, [{ charge_group_id: group }, { charge_group_id: group }], 5);
    const a = adapterOf();
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(2);
    expect(tables.scheduled_posts.every((p) => p.status === "posted")).toBe(true);
    expect(wallet.balance.get(acc)).toBe(4 * PRICE);
    expect(wallet.holds.every((h) => h.key === `post:${group}:a1`)).toBe(true);
  });

  it("a crash between the send and the verify does not charge twice: the retry re-verifies and commits the SAME hold", async () => {
    const acc = newAccount();
    seed(acc, [{ id: "crashed", status: "posting", updated_at: new Date(Date.now() - 30 * 60_000).toISOString() }], 5);
    tables.post_results = [{ id: "pr1", scheduled_post_id: "crashed", account_id: acc, platform_post_id: "plat-9", verified_live: false }];
    // what the crashed run left behind: a held credit under the attempt-1 key
    await walletRpc("wallet_hold", { p_account_id: acc, p_action: "post_publish", p_key: "post:crashed:a1" });
    expect(heldNow(acc)).toBe(1);

    expect(await recoverStuckPosts(nextSweepNow())).toBe(1); // back to pending to re-verify
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(heldNow(acc)).toBe(1); // the hold is NOT released: the post may be live

    const a = adapterOf();
    await runSchedulerCycle(registryOf(a));
    expect(a.post).not.toHaveBeenCalled(); // re-verify only, no second copy
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(wallet.holds).toHaveLength(1);
    expect(committed(acc)).toBe(1);
    expect(wallet.balance.get(acc)).toBe(4 * PRICE);
    expect(wallet.charges).toEqual([]); // no late charge either
  });

  it("a post stuck with no platform id is marked failed and its hold is released", async () => {
    const acc = newAccount();
    seed(acc, [{ id: "stuck", status: "posting", updated_at: new Date(Date.now() - 30 * 60_000).toISOString() }], 5);
    await walletRpc("wallet_hold", { p_account_id: acc, p_action: "post_publish", p_key: "post:stuck:a1" });
    expect(await recoverStuckPosts(nextSweepNow())).toBe(1);
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(wallet.holds.map((h) => h.status)).toEqual(["released"]);
    expect(wallet.balance.get(acc)).toBe(5 * PRICE);
  });
});

describe("wallet on, a legacy account", () => {
  it("is never held or charged and the post goes out", async () => {
    const acc = newAccount();
    seed(acc, [{}], 0);
    tables.wallet_legacy_accounts = [{ account_id: acc }];
    const a = adapterOf();
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(wallet.calls).not.toContain("wallet_hold");
    expect(wallet.calls).not.toContain("wallet_charge");
  });
});

describe("shadow mode (the switch on, mode not on)", () => {
  it("never blocks or alters a post, touches no wallet function but logs what it would charge", async () => {
    vi.stubEnv("WALLET_MODE", "shadow");
    const acc = newAccount();
    seed(acc, [{}], 0); // empty wallet: in "on" this post would wait
    wallet.paused.push(acc); // shadow must ignore the pause list
    const a = adapterOf();
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.scheduled_posts[0].wallet_hold_reason).toBeUndefined();
    expect(wallet.calls.filter((c) => c !== "wallet_paused_account_ids" && c !== "read_social_token")).toEqual([]);
    expect(logs.join("\n")).toMatch(/\[wallet-shadow\].*would charge 1 credit/);
  });
});

describe("wallet off (the default)", () => {
  it("behaves exactly as before: no wallet call, no column written", async () => {
    vi.stubEnv("WALLET_ENABLED", "false");
    const acc = newAccount();
    seed(acc, [{}], 0);
    const a = adapterOf();
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(wallet.calls.filter((c) => c.startsWith("wallet_"))).toEqual([]);
    expect(tables.scheduled_posts[0].wallet_hold_reason).toBeUndefined();
  });
});
