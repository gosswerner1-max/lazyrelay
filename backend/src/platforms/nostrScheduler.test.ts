// The real NostrAdapter driven by the real scheduler (supabase is an in-memory stub, the relays and the NIP-46 signer
// are fakes). Proves the Proof-of-Publish contract for Nostr: a note a relay accepted but that cannot be read back is
// "unconfirmed", the retry re-reads it and NEVER asks the signer or any relay for a second note.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

const held = vi.hoisted(() => ({ token: "" }));
vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: held.token, error: null }) } };
});
vi.mock("../notify.js", () => ({ notifyOps: vi.fn(async () => {}) }));
vi.mock("../email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendPinterestPausedAlert: vi.fn(), sendReconnectNeededEmail: vi.fn() }));
vi.mock("../webhook.js", () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));
vi.mock("../urlSafety.js", () => ({ isSafeMediaUrl: async () => ({ safe: true, addresses: ["93.184.216.34"] }) }));

const { runSchedulerCycle } = await import("../scheduler.js");
const { NostrAdapter } = await import("./nostr.js");
const { FakeNetwork, FakeSigner } = await import("./nostrTestKit.js");

const MIN = 60_000;
const SIGNER_RELAY = "wss://signer-relay.example.org";
const WRITE_A = "wss://write-a.example.org";
const WRITE_B = "wss://write-b.example.org";
const registryOf = (adapter: unknown) => ({ get: (p: string) => (p === "nostr" ? adapter : undefined) }) as never;

async function build() {
  const net = new FakeNetwork();
  const signer = new FakeSigner(net);
  const relays = Object.fromEntries([SIGNER_RELAY, WRITE_A, WRITE_B, "wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"].map((u) => [u, net.add(u)]));
  const list = signer.signAsUser({ kind: 10002, content: "", created_at: Math.floor(Date.now() / 1000) - 500, tags: [["r", WRITE_A], ["r", WRITE_B]] });
  relays["wss://relay.damus.io"].events.set(list.id, list);
  const adapter = new NostrAdapter("https://app.example.org/connect/nostr", { connector: net.connector, timeouts: { connectApprovalMs: 600, signMs: 400, publishMs: 400, readMs: 400 } });
  const connected = await adapter.exchangeCode(JSON.stringify({ bunkerUrl: signer.bunkerUrl([SIGNER_RELAY]) }));
  held.token = connected.accessToken;
  return { net, signer, relays, adapter, connected };
}

function seed(platformAccountId: string) {
  tables.social_accounts = [
    { id: "sa1", account_id: "acc1", platform: "nostr", display_name: "npub1abcd...wxyz", platform_account_id: platformAccountId, paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null },
  ];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", social_account_id: "sa1", platform_account_id: platformAccountId, content: "Launch day on Nostr", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString() },
  ];
  tables.post_results = [];
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const signCalls = (w: Awaited<ReturnType<typeof build>>) => w.signer.calls.filter((c) => c.method === "sign_event").length;
const notesAt = (w: Awaited<ReturnType<typeof build>>, url: string) => w.relays[url].receivedEvents(1).length;

describe("Nostr through the scheduler", () => {
  it("signs, publishes, reads the note back by id, and stores the nevent link as the proof", async () => {
    const w = await build();
    seed(w.connected.platformAccountId);
    await runSchedulerCycle(registryOf(w.adapter));

    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.post_results).toHaveLength(1);
    const row = tables.post_results[0];
    expect(row.platform_post_id).toMatch(/^[0-9a-f]{64}$/);
    expect(row.verified_live).toBe(true);
    expect(String(row.platform_post_url)).toMatch(/^https:\/\/njump\.me\/nevent1/);
    expect(w.relays[WRITE_A].events.has(row.platform_post_id as string)).toBe(true);
    expect(w.net.openConnections()).toBe(0);
  });

  it("a note that cannot be read back is unconfirmed, and the retry re-checks it WITHOUT signing or sending a second note", async () => {
    const w = await build();
    seed(w.connected.platformAccountId);
    // The relays say OK but do not show the note back yet.
    for (const url of [WRITE_A, WRITE_B]) w.relays[url].hideStored = true;
    await runSchedulerCycle(registryOf(w.adapter));

    expect(signCalls(w)).toBe(1);
    expect(tables.scheduled_posts[0].status).toBe("pending"); // reset for a retry, not failed
    expect(tables.post_results).toHaveLength(1);
    expect(tables.post_results[0]).toMatchObject({ verified_live: false });
    expect(tables.post_results[0].platform_post_id).toMatch(/^[0-9a-f]{64}$/);
    expect(String(tables.post_results[0].error_message)).toMatch(/will not post it twice/);

    for (const url of [WRITE_A, WRITE_B]) w.relays[url].hideStored = false;
    tables.scheduled_posts[0].scheduled_for = new Date(Date.now() - MIN).toISOString();
    await runSchedulerCycle(registryOf(w.adapter));

    expect(signCalls(w)).toBe(1); // the signer was NOT asked for a second note
    expect(notesAt(w, WRITE_A)).toBe(1); // and no relay was sent a second one
    expect(notesAt(w, WRITE_B)).toBe(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.post_results).toHaveLength(1); // the same proof row, updated
    expect(tables.post_results[0]).toMatchObject({ verified_live: true });
  });

  it("an offline signer is retried later, not failed, and nothing reaches any relay", async () => {
    const w = await build();
    seed(w.connected.platformAccountId);
    w.signer.mode = "offline";
    await runSchedulerCycle(registryOf(w.adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.scheduled_posts[0].retry_count).toBe(1);
    expect(String(tables.post_results[0]?.error_message ?? "")).toMatch(/signer app has to be online/);
    expect(notesAt(w, WRITE_A) + notesAt(w, WRITE_B)).toBe(0);
  });

  it("a signer that refuses fails the post at once and flags the account for reconnect", async () => {
    const w = await build();
    seed(w.connected.platformAccountId);
    w.signer.mode = "refuse";
    await runSchedulerCycle(registryOf(w.adapter));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toMatch(/Reconnect it in Social Platforms|reconnect it in Social Platforms/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(tables.post_results[0].raw_error_message).toMatch(/nostr_signer_refused/);
  });

  it("relays that block the account fail the post with a readable reason; rate limits retry", async () => {
    const w = await build();
    seed(w.connected.platformAccountId);
    for (const url of [WRITE_A, WRITE_B]) w.relays[url].okMode = { reject: "blocked: you are banned" };
    await runSchedulerCycle(registryOf(w.adapter));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toMatch(/relays refused the note/);

    seed(w.connected.platformAccountId);
    for (const url of [WRITE_A, WRITE_B]) w.relays[url].okMode = { reject: "rate-limited: slow down" };
    await runSchedulerCycle(registryOf(w.adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
  });
});
