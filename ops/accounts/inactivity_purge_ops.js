// Inactivity Purge Operator. Published policy (Privacy Policy and Terms): "Free and Pay-as-you-go account data is
// permanently deleted after 6 consecutive months of total inactivity." Subscription accounts are NOT handled here: their
// data goes 30 days after the subscription ends (data_retention_ops.js). The two jobs never touch the same account.
//
// SAFE BY DEFAULT. runInactivityPurgeSweep(supabase, opts) only reports (dry run). It deletes only when called with
// {live: true} AND process.env.INACTIVITY_PURGE_ENABLED is exactly the string "true", it deletes at most maxPerRun accounts
// per run (default 25), and it refuses to run at all (returns {aborted: "too_many_eligible"}) when more than 25 accounts look
// eligible until a human has looked and passes approvedEligibleCount. No email is sent: the policy promises no warning
// (a warning email is recommended, see the pull request).
//
// ELIGIBILITY, every line must hold:
//   1. Not a subscription account: NO subscriptions row at all (any status, any tier: active, trialing, past_due, cancelled,
//      Growth, Pro, anything), accounts.cancelled_at is null, accounts.data_deleted_at is null. An ever-cancelled account
//      belongs to the 30-day job.
//   2. Not internal: not isInternalTestAccount(email) (the owner's and family's own accounts, test domains) and no
//      wallet_legacy_accounts row (grandfathered accounts are exempt).
//   3. Total inactivity: the LATEST of all activity signals below is older than the cutoff. A signal that cannot be read
//      makes the account ACTIVE (fail safe) and is reported with its raw error.
//   4. Cutoff = now minus 6 CALENDAR months (computeCutoff): same day-of-month and time, the day clamped to the last day of
//      a shorter month (31 Aug -> 28 Feb). Everything is UTC.
//
// ACTIVITY SIGNALS (ACTIVITY_SIGNALS below, plus the sign-in time and account creation):
//   auth.users.last_sign_in_at, accounts.created_at, scheduled_posts.{created_at, updated_at, scheduled_for (publish time, also
//   any future post)}, post_results.created_at, api_keys.{last_used_at, created_at}, wallet_ledger.created_at,
//   wallet_lots.granted_at, billing_records.created_at (a purchase), social_accounts.{connected_at, disconnected_at},
//   whatsapp_chat_messages.occurred_at, whatsapp_conversations.last_message_at (the only chat/support records kept per
//   account), media_uploads.created_at.
//
// DELETION reuses the existing safe paths: data_retention_ops.deleteAccountData (media files, media rows, posts) and
// account_deletion.deleteAccountRows (members, subscriptions, accounts row with its cascades, auth user), the same row removal
// abandoned_account_ops.js uses. Before either, every stored platform login (Vault secret) is overwritten with the same
// "revoked" marker the disconnect flow uses, because deleting the accounts row would otherwise leave the secrets behind. The
// wallet ledger is append only with no foreign key and is deliberately kept (bookkeeping). billing_records keep their rows with
// account_id set null (tax records). The eligibility check runs again, live, immediately before each deletion.

const fs = require("node:fs");
const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");
const { deleteAccountData } = require("./data_retention_ops.js");
const { deleteAccountRows } = require("./account_deletion.js");

const INACTIVITY_MONTHS = 6;
const DEFAULT_MAX_PER_RUN = 25;
const TOO_MANY_ELIGIBLE = 25;
const SCAN_PAGE = 500;
const ENABLE_ENV = "INACTIVITY_PURGE_ENABLED";
const WIPED_TOKEN_MARKER = "revoked"; // same marker backend/src/tokenWipe.ts writes
const LOGIN_TABLES = ["social_accounts", "google_calendar_connections", "google_sheets_connections"];

/** Every per-account table/column whose newest value counts as activity. */
const ACTIVITY_SIGNALS = [
  ["scheduled_posts", "created_at"], ["scheduled_posts", "updated_at"], ["scheduled_posts", "scheduled_for"],
  ["post_results", "created_at"],
  ["api_keys", "last_used_at"], ["api_keys", "created_at"],
  ["wallet_ledger", "created_at"], ["wallet_lots", "granted_at"],
  ["billing_records", "created_at"],
  ["social_accounts", "connected_at"], ["social_accounts", "disconnected_at"],
  ["whatsapp_chat_messages", "occurred_at"], ["whatsapp_conversations", "last_message_at"],
  ["media_uploads", "created_at"],
];

/** now minus 6 calendar months, UTC, day clamped to the last day of the target month. */
function computeCutoff(now = new Date()) {
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - INACTIVITY_MONTHS);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function errMessage(err) {
  return err instanceof Error ? err.message : err && err.message ? String(err.message) : String(err);
}

/** Newest value of one column for one account, or null when there are no rows. Throws the raw error when unreadable. */
async function latestOf(supabase, table, column, accountId) {
  const { data, error } = await supabase
    .from(table)
    .select(column)
    .eq("account_id", accountId)
    .not(column, "is", null)
    .order(column, { ascending: false })
    .limit(1);
  if (error) throw error;
  const value = data && data[0] ? data[0][column] : null;
  if (value == null) return null;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`${table}.${column} returned an unparseable timestamp`);
  return time;
}

/** Decides one account. Never throws for a single unreadable signal: that makes the account ACTIVE and is reported.
 * Returns {eligible, reason?, lastActivityAt?, unreadable?}. */
async function evaluateAccount(supabase, account, cutoff) {
  if (isInternalTestAccount(account.email)) return { eligible: false, reason: "internal_account" };
  if (account.cancelled_at) return { eligible: false, reason: "ever_cancelled" };
  if (account.data_deleted_at) return { eligible: false, reason: "data_already_deleted" };

  try {
    const { data: subs, error } = await supabase.from("subscriptions").select("status, tier").eq("account_id", account.id);
    if (error) throw error;
    if ((subs ?? []).length > 0) return { eligible: false, reason: "has_subscription_row" };
  } catch (err) {
    return { eligible: false, reason: "unreadable_signal", unreadable: `subscriptions: ${errMessage(err)}` };
  }

  try {
    const { data: legacy, error } = await supabase.from("wallet_legacy_accounts").select("account_id").eq("account_id", account.id).maybeSingle();
    if (error) throw error;
    if (legacy) return { eligible: false, reason: "legacy_exempt" };
  } catch (err) {
    return { eligible: false, reason: "unreadable_signal", unreadable: `wallet_legacy_accounts: ${errMessage(err)}` };
  }

  const stamps = [];
  const created = new Date(account.created_at);
  if (Number.isNaN(created.getTime())) return { eligible: false, reason: "unreadable_signal", unreadable: "accounts.created_at: unparseable" };
  stamps.push(created);

  try {
    const { data, error } = await supabase.auth.admin.getUserById(account.id);
    if (error) throw error;
    if (!data || !data.user) throw new Error("auth user not returned");
    if (data.user.last_sign_in_at) {
      const t = new Date(data.user.last_sign_in_at);
      if (Number.isNaN(t.getTime())) throw new Error("auth.users.last_sign_in_at unparseable");
      stamps.push(t);
    }
  } catch (err) {
    return { eligible: false, reason: "unreadable_signal", unreadable: `auth.users.last_sign_in_at: ${errMessage(err)}` };
  }

  for (const [table, column] of ACTIVITY_SIGNALS) {
    try {
      const t = await latestOf(supabase, table, column, account.id);
      if (t) stamps.push(t);
    } catch (err) {
      return { eligible: false, reason: "unreadable_signal", unreadable: `${table}.${column}: ${errMessage(err)}` };
    }
  }

  const last = new Date(Math.max(...stamps.map((s) => s.getTime())));
  if (last.getTime() >= cutoff.getTime()) return { eligible: false, reason: "recent_activity", lastActivityAt: last.toISOString() };
  return { eligible: true, lastActivityAt: last.toISOString() };
}

/** Accounts created before the cutoff and not obviously excluded, paged. Throws the raw error when unreadable. */
async function* scanCandidates(supabase, cutoff) {
  for (let from = 0; ; from += SCAN_PAGE) {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, email, created_at, cancelled_at, data_deleted_at")
      .lte("created_at", cutoff.toISOString())
      .order("created_at", { ascending: true })
      .range(from, from + SCAN_PAGE - 1);
    if (error) throw error;
    for (const row of data ?? []) yield row;
    if (!data || data.length < SCAN_PAGE) return;
  }
}

/** Overwrites every stored platform login of the account with the revoked marker. Throws on the first failure so the
 * account is NOT deleted while a secret could still be live. */
async function wipeLoginSecrets(supabase, accountId) {
  const ids = new Set();
  for (const table of LOGIN_TABLES) {
    const { data, error } = await supabase.from(table).select("access_token_vault_id, refresh_token_vault_id").eq("account_id", accountId);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.access_token_vault_id) ids.add(row.access_token_vault_id);
      if (row.refresh_token_vault_id) ids.add(row.refresh_token_vault_id);
    }
  }
  for (const id of ids) {
    const { error } = await supabase.rpc("update_social_token", { p_vault_id: id, p_new_token: WIPED_TOKEN_MARKER });
    if (error) throw error;
  }
}

function appendAudit(auditLog, record) {
  fs.appendFileSync(auditLog, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
}

/** Deletes one account. Re-checks eligibility live first. Order: re-check, wipe logins, remove content, remove account +
 * auth user, audit line. Throws raw errors; an account that stopped being eligible returns {deleted: false}. */
async function purgeAccount(supabase, account, { now = new Date(), cutoff, auditLog }) {
  const check = await evaluateAccount(supabase, account, cutoff ?? computeCutoff(now));
  if (!check.eligible) return { accountId: account.id, deleted: false, reason: `no longer eligible on the live re-check (${check.reason})` };

  await wipeLoginSecrets(supabase, account.id);
  const content = await deleteAccountData(supabase, { id: account.id });
  if (!content.deleted) return { accountId: account.id, deleted: false, reason: content.reason };
  await deleteAccountRows(supabase, account.id);

  appendAudit(auditLog, {
    event: "inactivity_purge_deleted",
    accountId: account.id,
    plan: "no_subscription_free_or_payg",
    lastActivityAt: check.lastActivityAt,
    deletedAt: new Date().toISOString(),
  });
  return { accountId: account.id, deleted: true };
}

/** Single entry point. See the header for the safety model. Returns a compact summary (counts only; account ids appear only
 * with opts.detail, never emails). */
async function runInactivityPurgeSweep(supabase, opts = {}) {
  const {
    live = false,
    maxPerRun = DEFAULT_MAX_PER_RUN,
    auditLog,
    now = new Date(),
    env = process.env,
    detail = false,
    approvedEligibleCount,
  } = opts;

  const liveRequested = live === true;
  const liveEnabled = liveRequested && env[ENABLE_ENV] === "true";
  if (liveEnabled && (typeof auditLog !== "string" || !auditLog)) {
    throw new Error("runInactivityPurgeSweep: live mode requires opts.auditLog (a file path) so every deletion is recorded");
  }
  if (!Number.isInteger(maxPerRun) || maxPerRun < 1) throw new Error("runInactivityPurgeSweep: maxPerRun must be a positive integer");

  const cutoff = computeCutoff(now);
  const eligible = [];
  const blocked = {};
  const unreadableErrors = [];
  let scanned = 0;

  for await (const account of scanCandidates(supabase, cutoff)) {
    scanned++;
    const result = await evaluateAccount(supabase, account, cutoff);
    if (result.eligible) {
      eligible.push({ account, lastActivityAt: result.lastActivityAt });
    } else {
      blocked[result.reason] = (blocked[result.reason] ?? 0) + 1;
      if (result.unreadable && unreadableErrors.length < 5) unreadableErrors.push(result.unreadable);
    }
  }

  const summary = {
    mode: liveEnabled ? "live" : "dry_run",
    cutoff: cutoff.toISOString(),
    scanned,
    eligibleCount: eligible.length,
    unreadableCount: blocked.unreadable_signal ?? 0,
    unreadableErrors,
    blocked,
    deleted: 0,
    deletionsSkipped: 0,
    deletionErrors: [],
  };
  if (liveRequested && !liveEnabled) summary.liveRequestedButDisabled = true;
  if (detail) summary.eligible = eligible.map((e) => ({ accountId: e.account.id, lastActivityAt: e.lastActivityAt }));

  const abortAbove = Number.isInteger(approvedEligibleCount) ? approvedEligibleCount : TOO_MANY_ELIGIBLE;
  if (eligible.length > abortAbove) {
    summary.aborted = "too_many_eligible";
    return summary;
  }
  if (!liveEnabled) return summary;

  appendAudit(auditLog, { event: "inactivity_purge_run_start", at: new Date().toISOString(), eligibleCount: eligible.length, maxPerRun });
  for (const { account } of eligible.slice(0, maxPerRun)) {
    try {
      const res = await purgeAccount(supabase, account, { now, cutoff, auditLog });
      if (res.deleted) summary.deleted++;
      else summary.deletionsSkipped++;
    } catch (err) {
      summary.deletionErrors.push({ accountId: account.id, error: errMessage(err) });
    }
  }
  summary.capped = eligible.length > maxPerRun;
  return summary;
}

module.exports = {
  runInactivityPurgeSweep,
  evaluateAccount,
  purgeAccount,
  computeCutoff,
  ACTIVITY_SIGNALS,
  INACTIVITY_MONTHS,
  DEFAULT_MAX_PER_RUN,
  TOO_MANY_ELIGIBLE,
  ENABLE_ENV,
};
