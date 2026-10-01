// Connecting a Whop community, and PROVING the customer owns it.
//
// Why this exists: LazyRelay has ONE Whop app and ONE API key, and that key works in every community that installed
// the app. So knowing a community's biz_ id must never be enough to connect it, or any customer could post into any
// community that ever installed LazyRelay. The proof used here is the one the docs support without extra permissions:
//
//   1. The customer names the community (its biz_ id). LazyRelay checks the app is installed there (GET /experiences),
//      then mints a one-time code bound to THIS LazyRelay account and THAT community, valid 15 minutes.
//   2. The customer posts the code in a forum of the community, as an ADMIN of the community.
//   3. LazyRelay reads the forum back (GET /forum_posts?experience_id=...) and looks for a post that carries the code
//      AND that Whop itself marks `is_poster_admin: true` ("whether the author of this post is an admin"). The flag is
//      Whop's own statement about the author, so a member who only copies the code cannot pass.
//   4. The code is consumed atomically (single use) and the customer picks the forum to post to (the usual picker).
//   5. At the very end one community can belong to ONE LazyRelay account at a time (whop_company_claims).
//
// Only a hash of the code is stored; the code itself exists in the customer's browser and in the forum post they
// make. Nothing here ever handles the app key: every Whop call goes through WhopClient.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { supabase } from "../supabase.js";
import { COMPANY_ID, EXPERIENCE_ID, WhopApiError, WhopClient, safeLabel, type WhopForumList } from "./whopApi.js";

export const WHOP_CODE_PREFIX = "lazyrelay-";
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/1/i/l/o: easy to copy by eye
const CODE_BODY_LENGTH = 12; // 31^12 is about 2^59
const CODE_PATTERN = /lazyrelay-[a-z0-9]{12}/g;
export const WHOP_CHALLENGE_MINUTES = 15;
const MAX_CHECKS_PER_CHALLENGE = 30;
const MAX_CHALLENGES_PER_HOUR = 10;
const MAX_FORUMS_SCANNED = 10;
const POSTS_PER_FORUM = 30;
const PAGES_PER_FORUM = 3;
// A code posted before the challenge existed cannot be ours. A little slack for clock differences.
const CLOCK_SLACK_MS = 2 * 60_000;

/** Placeholder stored where other platforms keep a customer's token. The adapter ignores it: the one credential is the
 *  app key from the environment. It is not a secret and not a key. */
export const WHOP_TOKEN_PLACEHOLDER = "whop-uses-the-lazyrelay-app-connection";

export interface WhopChallenge {
  challengeId: string;
  code: string;
  companyId: string;
  companyTitle: string;
  forums: Array<{ id: string; name: string }>;
  expiresAt: string;
}

/** What is held server-side (Vault) between the proof and the forum pick. Nothing secret: ids and names. */
export interface HeldWhopConnect {
  kind: "whop";
  accountId: string;
  companyId: string;
  companyTitle: string;
  verifiedAt: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function newChallengeCode(): string {
  const bytes = randomBytes(CODE_BODY_LENGTH);
  let body = "";
  for (let i = 0; i < CODE_BODY_LENGTH; i++) body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${WHOP_CODE_PREFIX}${body}`;
}

/** The biz_ id from what the customer typed: the id itself, or any address that contains it (a dashboard link, for
 *  example whop.com/dashboard/biz_xxx/). Null when there is no id in it. */
export function parseCompanyInput(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 400) return null;
  const found = /biz_[A-Za-z0-9]{4,40}/.exec(input.trim());
  return found && COMPANY_ID.test(found[0]) ? found[0] : null;
}

/** Customer-facing words for a Whop refusal during connect. */
function connectProblem(err: unknown): Error {
  if (err instanceof WhopApiError) {
    if (err.code === "whop_unauthorized" || err.code === "whop_forbidden" || err.code === "whop_not_found") {
      return new Error(
        "LazyRelay is not installed in that community yet, or the community id is wrong. Do step 1 (install the LazyRelay app and approve its three permissions), then check the id starts with biz_ and try again.",
      );
    }
    if (err.code === "whop_rate_limited") return new Error("Whop is busy right now. Wait a minute and try again.");
    if (err.code === "whop_validation") return new Error(`Whop said: ${err.message}`);
  }
  return new Error("Could not reach Whop to check your community. Please try again in a moment.");
}

// ---- One community, one LazyRelay account ----

const TAKEN_MESSAGE =
  "That Whop community is already connected to another LazyRelay account. A community can only be connected to one account at a time. If it is yours, ask whoever connected it to disconnect it first, or contact LazyRelay support.";

/** True when `holder` still has a connected (not disconnected) Whop forum in this community. */
async function holderStillConnected(holder: string, companyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("social_accounts")
    .select("platform_account_id")
    .eq("account_id", holder)
    .eq("platform", "whop")
    .is("disconnected_at", null);
  if (error) throw error;
  return (data ?? []).some((r) => typeof r.platform_account_id === "string" && r.platform_account_id.startsWith(`${companyId}:`));
}

/** Early, friendly check at the start and at the proof. The binding one is claimWhopCompany. */
export async function assertCompanyAvailable(companyId: string, accountId: string): Promise<void> {
  const { data, error } = await supabase.from("whop_company_claims").select("account_id").eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  if (!data || data.account_id === accountId) return;
  if (await holderStillConnected(data.account_id as string, companyId)) throw new Error(TAKEN_MESSAGE);
}

/** Takes the community for this account. The primary key makes two simultaneous claims race safely: the loser's insert
 *  fails and it is refused. A claim whose holder has disconnected every forum of it is stale and may be taken over,
 *  but only after the new account has proved ownership (the caller has just done that). */
export async function claimWhopCompany(companyId: string, accountId: string): Promise<void> {
  const read = async () => {
    const { data, error } = await supabase.from("whop_company_claims").select("account_id").eq("company_id", companyId).maybeSingle();
    if (error) throw error;
    return data as { account_id: string } | null;
  };
  let existing = await read();
  if (!existing) {
    const { error } = await supabase.from("whop_company_claims").insert({ company_id: companyId, account_id: accountId });
    if (!error) return;
    if ((error as { code?: string }).code !== "23505") throw error;
    existing = await read(); // somebody else claimed it a moment ago
    if (!existing) throw new Error(TAKEN_MESSAGE);
  }
  if (existing.account_id === accountId) return;
  if (await holderStillConnected(existing.account_id, companyId)) throw new Error(TAKEN_MESSAGE);
  // Stale claim: move it, but only if it is still the one we looked at (a concurrent takeover then fails cleanly).
  const { data: moved, error: moveError } = await supabase
    .from("whop_company_claims")
    .update({ account_id: accountId, claimed_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("account_id", existing.account_id)
    .select("company_id")
    .maybeSingle();
  if (moveError) throw moveError;
  if (!moved) throw new Error(TAKEN_MESSAGE);
}

// ---- Step 2: the challenge ----

export async function startWhopChallenge(api: WhopClient, accountId: string, companyInput: unknown): Promise<WhopChallenge> {
  const companyId = parseCompanyInput(companyInput);
  if (!companyId) {
    throw new Error("Paste your Whop community id: it starts with biz_ (you can see it in the address bar of your Whop dashboard).");
  }

  // Housekeeping first (cheap, and keeps the table small), then the per-account brake.
  await supabase.from("whop_connect_challenges").delete().lt("expires_at", new Date().toISOString());
  const { data: recent, error: recentError } = await supabase
    .from("whop_connect_challenges")
    .select("id")
    .eq("account_id", accountId)
    .gt("created_at", new Date(Date.now() - 60 * 60_000).toISOString());
  if (recentError) throw recentError;
  if ((recent ?? []).length >= MAX_CHALLENGES_PER_HOUR) {
    throw new Error("Too many Whop connection attempts in the last hour. Please wait a while and try again.");
  }

  await assertCompanyAvailable(companyId, accountId);

  let list: WhopForumList;
  try {
    list = await api.listForums(companyId);
  } catch (err) {
    throw connectProblem(err);
  }
  if (list.forums.length === 0) {
    throw new Error("LazyRelay is installed in that community but could not find a forum in it. Add a Forums area to the community in Whop, then try again.");
  }

  const code = newChallengeCode();
  const expiresAt = new Date(Date.now() + WHOP_CHALLENGE_MINUTES * 60_000).toISOString();
  const { data: row, error } = await supabase
    .from("whop_connect_challenges")
    .insert({ account_id: accountId, company_id: companyId, code_hash: sha256(code), attempts: 0, expires_at: expiresAt, used_at: null })
    .select("id")
    .single();
  if (error || !row) throw error ?? new Error("Could not start the Whop connection.");
  return {
    challengeId: row.id as string,
    code,
    companyId,
    companyTitle: list.companyTitle,
    forums: list.forums.map((f) => ({ id: f.id, name: f.label })),
    expiresAt,
  };
}

// ---- Step 3: the proof ----

interface RawPost {
  content?: unknown;
  is_poster_admin?: unknown;
  created_at?: unknown;
}

/** Looks for a post carrying this challenge's code. `found` says a post has the code at all; `byAdmin` says one of
 *  them was written by an admin of the community (Whop's own flag). Only the hash is compared, in constant time. */
async function scanForCode(api: WhopClient, forumIds: string[], codeHash: string, notBefore: number): Promise<{ found: boolean; byAdmin: boolean }> {
  let found = false;
  for (const forumId of forumIds.slice(0, MAX_FORUMS_SCANNED)) {
    if (!EXPERIENCE_ID.test(forumId)) continue;
    let after = "";
    for (let page = 0; page < PAGES_PER_FORUM; page++) {
      const query: Record<string, string> = { experience_id: forumId, first: String(POSTS_PER_FORUM) };
      if (after) query.after = after;
      let reply;
      try {
        reply = await api.request("GET", "/forum_posts", { query });
      } catch {
        throw new Error("Could not reach Whop to look for your code. Please try again in a moment.");
      }
      if (reply.status === 429) throw new Error("Whop is busy right now. Wait a minute and check again.");
      if (reply.status < 200 || reply.status >= 300) break; // one unreadable forum must not block the others
      const posts = Array.isArray(reply.json.data) ? (reply.json.data as RawPost[]) : [];
      for (const post of posts.slice(0, POSTS_PER_FORUM)) {
        if (!post || typeof post.content !== "string") continue;
        const tokens = post.content.slice(0, 20_000).match(CODE_PATTERN) ?? [];
        if (!tokens.some((t) => hashesMatch(sha256(t), codeHash))) continue;
        const createdAt = typeof post.created_at === "string" ? Date.parse(post.created_at) : NaN;
        if (Number.isFinite(createdAt) && createdAt < notBefore - CLOCK_SLACK_MS) continue; // older than the challenge
        found = true;
        if (post.is_poster_admin === true) return { found: true, byAdmin: true };
      }
      const info = reply.json.page_info as { has_next_page?: unknown; end_cursor?: unknown } | undefined;
      after = info?.has_next_page === true && typeof info.end_cursor === "string" && info.end_cursor.length <= 300 ? info.end_cursor : "";
      if (!after) break;
    }
  }
  return { found, byAdmin: false };
}

export interface WhopVerified {
  selectionToken: string;
  options: Array<{ id: string; name: string }>;
}

/** Checks the proof for one challenge. On success the customer gets a selection token for the usual forum picker
 *  (the same pending-selection table Slack and Tumblr use); the held record carries ids and names only. */
export async function verifyWhopChallenge(api: WhopClient, accountId: string, challengeId: unknown): Promise<WhopVerified> {
  const FRESH = "That code is not valid any more. Go back and get a new one.";
  if (typeof challengeId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(challengeId)) throw new Error(FRESH);

  const { data: row, error } = await supabase
    .from("whop_connect_challenges")
    .select("id, account_id, company_id, code_hash, attempts, created_at, expires_at, used_at")
    .eq("id", challengeId)
    .maybeSingle();
  if (error) throw error;
  // Someone else's challenge looks exactly like a missing one.
  if (!row || row.account_id !== accountId) throw new Error(FRESH);
  if (row.used_at) throw new Error("That code was already used. Go back and get a new one.");
  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    await supabase.from("whop_connect_challenges").delete().eq("id", challengeId);
    throw new Error("That code has expired (codes last 15 minutes). Go back and get a new one.");
  }
  const attempts = Number(row.attempts ?? 0);
  if (attempts >= MAX_CHECKS_PER_CHALLENGE) throw new Error("Too many checks for this code. Go back and get a new one.");
  await supabase.from("whop_connect_challenges").update({ attempts: attempts + 1 }).eq("id", challengeId);

  const companyId = row.company_id as string;
  if (!COMPANY_ID.test(companyId)) throw new Error(FRESH);

  let list: WhopForumList;
  try {
    list = await api.listForums(companyId);
  } catch (err) {
    throw connectProblem(err);
  }
  const scan = await scanForCode(api, list.forums.map((f) => f.id), row.code_hash as string, new Date(row.created_at as string).getTime());
  if (!scan.found) {
    throw new Error(
      "LazyRelay could not find your code yet. Post it in one of your community's forums (as the community owner or an admin), wait a few seconds, then check again.",
    );
  }
  if (!scan.byAdmin) {
    throw new Error(
      "LazyRelay found the code, but Whop says the post was not written by an owner or admin of the community. Only an owner or admin can connect a community. Post the code again from an admin account.",
    );
  }

  // Single use: only the check that flips used_at wins. A replay (or a second tab) finds it already set.
  const { data: consumed, error: consumeError } = await supabase
    .from("whop_connect_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("id", challengeId)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (consumeError) throw consumeError;
  if (!consumed) throw new Error("That code was already used. Go back and get a new one.");

  await assertCompanyAvailable(companyId, accountId);

  const held: HeldWhopConnect = { kind: "whop", accountId, companyId, companyTitle: list.companyTitle, verifiedAt: new Date().toISOString() };
  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", { p_token: JSON.stringify(held) });
  if (vaultError) throw vaultError;
  const options = list.forums.map((f) => ({ id: `${companyId}:${f.id}`, name: f.label }));
  const { data: state, error: stateError } = await supabase
    .from("oauth_states")
    .insert({ account_id: accountId, platform: "whop", pending_options: options, pending_token_vault_id: vaultId })
    .select("id")
    .single();
  if (stateError || !state) throw stateError ?? new Error("Could not continue the Whop connection.");
  return { selectionToken: state.id as string, options };
}

export function parseHeldWhopConnect(text: string): HeldWhopConnect | null {
  try {
    const held = JSON.parse(text) as Partial<HeldWhopConnect>;
    if (held.kind !== "whop" || typeof held.accountId !== "string" || typeof held.companyId !== "string" || !COMPANY_ID.test(held.companyId)) return null;
    return { kind: "whop", accountId: held.accountId, companyId: held.companyId, companyTitle: safeLabel(held.companyTitle, 80), verifiedAt: String(held.verifiedAt ?? "") };
  } catch {
    return null;
  }
}
