// Connecting a Whop community through the real connect code (whopConnect.ts + connect.ts): the ownership proof, its
// failure modes, replay, and the one-community-one-account rule. supabase and Vault are in-memory fakes, Whop is the
// fake from whopTestKit.ts, so nothing real is reached.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables, vault } from "../testFakeSupabase.js";
import { APP_ID, APP_PASS, createFakeWhop, freshCompany } from "./whopTestKit.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
vi.mock("../accountLimits.js", () => ({ checkNewDistinctAccountLimit: vi.fn(async () => null) }));
vi.mock("../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { startWhopChallenge, verifyWhopChallenge, parseCompanyInput, newChallengeCode, WHOP_TOKEN_PLACEHOLDER } = await import("./whopConnect.js");
const { getPendingSelection, finalizeConnectSelection } = await import("./connect.js");
const { WhopAdapter } = await import("./whop.js");

const COMPANY = "biz_TestCo12345";
const FORUM = "exp_ForumOne1234";
const FORUM2 = "exp_ForumTwo1234";

let whop: ReturnType<typeof createFakeWhop>;
let adapter: InstanceType<typeof WhopAdapter>;
let logs: string[];
const registry = () => new Map([["whop", adapter]]) as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  tables.social_accounts = [];
  whop = createFakeWhop([freshCompany()]);
  vi.stubGlobal("fetch", vi.fn(whop.handler));
  adapter = new WhopAdapter(APP_PASS, APP_ID);
  logs = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const start = (account = "acc1", company: unknown = COMPANY) => startWhopChallenge(adapter.api, account, company);
const verify = (challengeId: string, account = "acc1") => verifyWhopChallenge(adapter.api, account, challengeId);
const adminPosts = (code: string, forum = FORUM2) => whop.addPost(forum, `Connecting LazyRelay: ${code}`, { admin: true, user: "owner" });

describe("starting: the community and the code", () => {
  it("accepts the biz_ id or any address that contains it, and nothing else", () => {
    expect(parseCompanyInput("biz_TestCo12345")).toBe("biz_TestCo12345");
    expect(parseCompanyInput("https://whop.com/dashboard/biz_TestCo12345/products/")).toBe("biz_TestCo12345");
    for (const bad of ["", "lazyrelay-test", "biz_", "biz_a", "exp_ForumOne1234", 42, null, "x".repeat(500)]) expect(parseCompanyInput(bad)).toBeNull();
  });

  it("returns a one-time code, the forums to post it in, and stores only a hash of the code", async () => {
    const c = await start();
    expect(c.code).toMatch(/^lazyrelay-[a-z0-9]{12}$/);
    expect(c.forums.map((f) => f.id)).toEqual([FORUM, FORUM2]);
    expect(c.companyTitle).toBe("Lazyrelay");
    expect(JSON.stringify(tables.whop_connect_challenges)).not.toContain(c.code);
    expect(tables.whop_connect_challenges[0]).toMatchObject({ account_id: "acc1", company_id: COMPANY, used_at: null });
    expect(new Set(Array.from({ length: 50 }, () => newChallengeCode())).size).toBe(50);
  });

  it("refuses a community that has not installed the app, or one that is not an id, with plain steps", async () => {
    whop.setInstalled(COMPANY, false);
    await expect(start()).rejects.toThrow(/not installed in that community yet/);
    await expect(start("acc1", "my community")).rejects.toThrow(/starts with biz_/);
    expect(tables.whop_connect_challenges ?? []).toHaveLength(0);
  });

  it("limits how many codes one account can ask for in an hour", async () => {
    for (let i = 0; i < 10; i++) await start();
    await expect(start()).rejects.toThrow(/Too many Whop connection attempts/);
  });
});

describe("the ownership proof", () => {
  it("passes only when the code is posted by an admin of the community, then offers the forums to pick from", async () => {
    const c = await start();
    adminPosts(c.code);
    const v = await verify(c.challengeId);
    expect(v.options).toEqual([
      { id: `${COMPANY}:${FORUM}`, name: "Forums (Lazyrelay)" },
      { id: `${COMPANY}:${FORUM2}`, name: "Public forum (Lazyrelay)" },
    ]);
    expect(tables.whop_connect_challenges[0].used_at).toBeTruthy();
    expect(tables.social_accounts).toHaveLength(0); // nothing is saved until a forum is picked
    const pending = await getPendingSelection(v.selectionToken, "acc1", registry());
    expect(pending).toMatchObject({ platform: "whop", singleSelection: true });
  });

  it("a code nobody posted yet fails without using the code up, so the customer can post it and check again", async () => {
    const c = await start();
    await expect(verify(c.challengeId)).rejects.toThrow(/could not find your code yet/);
    expect(tables.whop_connect_challenges[0].used_at).toBeNull();
    adminPosts(c.code);
    await expect(verify(c.challengeId)).resolves.toBeTruthy();
  });

  it("a MEMBER who copies the code does not pass: Whop's own is_poster_admin flag must be true", async () => {
    const c = await start();
    whop.addPost(FORUM, `look: ${c.code}`, { admin: false, user: "member" });
    await expect(verify(c.challengeId)).rejects.toThrow(/not written by an owner or admin/);
    expect(tables.whop_connect_challenges[0].used_at).toBeNull();
    adminPosts(c.code);
    await expect(verify(c.challengeId)).resolves.toBeTruthy();
  });

  it("a guessed or made-up code never matches, even from an admin", async () => {
    const c = await start();
    adminPosts("lazyrelay-aaaaaaaaaaaa");
    adminPosts("lazyrelay-" + "b".repeat(12));
    await expect(verify(c.challengeId)).rejects.toThrow(/could not find your code yet/);
  });

  it("an old post that carries the code from before the challenge existed is ignored", async () => {
    const c = await start();
    whop.addPost(FORUM, c.code, { admin: true, createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await expect(verify(c.challengeId)).rejects.toThrow(/could not find your code yet/);
  });

  it("a replay of a used code fails, including from a second tab racing the first", async () => {
    const c = await start();
    adminPosts(c.code);
    await verify(c.challengeId);
    await expect(verify(c.challengeId)).rejects.toThrow(/already used/);
    expect(tables.oauth_states).toHaveLength(1); // one pending selection, not two
  });

  it("two checks at the same moment: only one wins the single-use update", async () => {
    const c = await start();
    adminPosts(c.code);
    const results = await Promise.allSettled([verify(c.challengeId), verify(c.challengeId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(tables.oauth_states).toHaveLength(1);
  });

  it("an expired code fails and is removed", async () => {
    const c = await start();
    adminPosts(c.code);
    tables.whop_connect_challenges[0].expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(verify(c.challengeId)).rejects.toThrow(/expired/);
    expect(tables.whop_connect_challenges).toHaveLength(0);
  });

  it("another LazyRelay account cannot use someone else's challenge, and an unknown id looks the same", async () => {
    const c = await start("acc1");
    adminPosts(c.code);
    await expect(verify(c.challengeId, "acc2")).rejects.toThrow(/not valid any more/);
    await expect(verify("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/not valid any more/);
    await expect(verify("../etc/passwd")).rejects.toThrow(/not valid any more/);
    expect(tables.whop_connect_challenges[0].used_at).toBeNull();
  });

  it("a code is bound to ITS community: the same code posted in another community proves nothing", async () => {
    const other = freshCompany();
    other.id = "biz_OtherCo12345";
    other.experiences = [{ id: "exp_OtherForum123", name: "Forums", appName: "Forums" }];
    whop = createFakeWhop([freshCompany(), other]);
    vi.stubGlobal("fetch", vi.fn(whop.handler));
    const c = await start();
    whop.addPost("exp_OtherForum123", c.code, { admin: true });
    await expect(verify(c.challengeId)).rejects.toThrow(/could not find your code yet/);
  });

  it("gives up after too many checks of one code", async () => {
    const c = await start();
    tables.whop_connect_challenges[0].attempts = 30;
    await expect(verify(c.challengeId)).rejects.toThrow(/Too many checks/);
  });
});

describe("finishing the connection (the picker) and one community per account", () => {
  async function proven(account = "acc1") {
    const c = await start(account);
    adminPosts(c.code);
    return verify(c.challengeId, account);
  }

  it("saves the forum with only ids and a label, a harmless placeholder token, and claims the community", async () => {
    const v = await proven();
    const ids = await finalizeConnectSelection(v.selectionToken, [`${COMPANY}:${FORUM}`], "acc1", registry());
    expect(ids).toHaveLength(1);
    expect(tables.social_accounts[0]).toMatchObject({
      account_id: "acc1",
      platform: "whop",
      platform_account_id: `${COMPANY}:${FORUM}`,
      display_name: "Forums (Lazyrelay)",
      refresh_token_vault_id: null,
      token_expires_at: null,
    });
    expect(vault.get(String(tables.social_accounts[0].access_token_vault_id))).toBe(WHOP_TOKEN_PLACEHOLDER);
    expect(tables.whop_company_claims).toEqual([expect.objectContaining({ company_id: COMPANY, account_id: "acc1" })]);
    // The held proof is scrubbed after use, and no key ever reached the vault, the tables or the logs.
    expect([...vault.values()].some((x) => x.includes("kind"))).toBe(false);
    expect(JSON.stringify([tables, [...vault.values()], logs])).not.toContain(APP_PASS);
  });

  it("a forum from another community, or one that is not in the list, cannot be picked", async () => {
    const v = await proven();
    await expect(finalizeConnectSelection(v.selectionToken, ["biz_OtherCo12345:exp_OtherForum123"], "acc1", registry())).rejects.toThrow(/wasn't part of the original list/);
    expect(tables.social_accounts).toHaveLength(0);
  });

  it("a forum removed between the proof and the pick is refused", async () => {
    const v = await proven();
    whop = createFakeWhop([{ ...freshCompany(), experiences: [{ id: FORUM2, name: "Forums", appName: "Forums" }] }]);
    vi.stubGlobal("fetch", vi.fn(whop.handler));
    await expect(finalizeConnectSelection(v.selectionToken, [`${COMPANY}:${FORUM}`], "acc1", registry())).rejects.toThrow(/no longer available/);
  });

  it("the selection belongs to the account that proved it", async () => {
    const v = await proven("acc1");
    await expect(finalizeConnectSelection(v.selectionToken, [`${COMPANY}:${FORUM}`], "acc2", registry())).rejects.toThrow(/Not authorized/);
  });

  it("a second LazyRelay account cannot connect a community that is already connected, even with a valid proof", async () => {
    const first = await proven("acc1");
    await finalizeConnectSelection(first.selectionToken, [`${COMPANY}:${FORUM}`], "acc1", registry());
    // Early, friendly refusal when the second account tries to start...
    await expect(start("acc2")).rejects.toThrow(/already connected to another LazyRelay account/);
    // ...and the binding refusal at the end, in case the claim appeared after the proof (a race).
    tables.whop_company_claims = [];
    const c2 = await start("acc2");
    adminPosts(c2.code);
    const second = await verify(c2.challengeId, "acc2");
    tables.whop_company_claims = [{ company_id: COMPANY, account_id: "acc1" }];
    await expect(finalizeConnectSelection(second.selectionToken, [`${COMPANY}:${FORUM}`], "acc2", registry())).rejects.toThrow(/already connected to another LazyRelay account/);
    expect(tables.social_accounts.filter((a) => a.account_id === "acc2")).toHaveLength(0);
  });

  it("the same account can connect a second forum of the same community", async () => {
    const a = await proven("acc1");
    await finalizeConnectSelection(a.selectionToken, [`${COMPANY}:${FORUM}`], "acc1", registry());
    const b = await proven("acc1");
    await finalizeConnectSelection(b.selectionToken, [`${COMPANY}:${FORUM2}`], "acc1", registry());
    expect(tables.social_accounts.map((x) => x.platform_account_id)).toEqual([`${COMPANY}:${FORUM}`, `${COMPANY}:${FORUM2}`]);
  });

  it("once the holder has disconnected, an account that proves ownership can take the community over", async () => {
    const a = await proven("acc1");
    await finalizeConnectSelection(a.selectionToken, [`${COMPANY}:${FORUM}`], "acc1", registry());
    await expect(start("acc2")).rejects.toThrow(/already connected/);
    tables.social_accounts[0].disconnected_at = new Date().toISOString();
    const b = await proven("acc2");
    await finalizeConnectSelection(b.selectionToken, [`${COMPANY}:${FORUM}`], "acc2", registry());
    expect(tables.whop_company_claims[0]).toMatchObject({ account_id: "acc2" });
  });
});
