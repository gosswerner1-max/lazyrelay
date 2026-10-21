// Inactivity Purge Operator. Published policy (Privacy Policy and Terms): "Free and Pay-as-you-go account data is
// permanently deleted after 6 consecutive months of total inactivity." Subscription accounts are NOT handled here: their
// data goes 30 days after the subscription ends (data_retention_ops.js). The two jobs never touch the same account.
//
// SAFE BY DEFAULT. runInactivityPurgeSweep(supabase, opts) only reports (dry run). It deletes only when called with
// {live: true} AND process.env.INACTIVITY_PURGE_ENABLED is exactly the string "true", it deletes at most maxPerRun accounts
// per run (default 25), and it refuses to run at all (returns {aborted: "too_many_eligible"}) when more than 25 accounts look
// eligible until a human has looked and passes approvedEligibleCount.
//
// WARNING FIRST. runInactivityWarningSweep(supabase, resend, opts) (below) emails each account once, 14 days before it
// becomes eligible, and records accounts.inactivity_warned_at. The purge is tied to that record: an account is only
// purge-eligible when inactivity_warned_at is set, at least 14 days old, and no activity has happened since. With the warning
// switched off (INACTIVITY_WARNING_ENABLED not "true") no warning is ever recorded, so nothing can ever be purged. The warning
// sweep has its own switch, separate from INACTIVITY_PURGE_ENABLED.
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
//   5. Warned: accounts.inactivity_warned_at is set, at least 14 days old, and not older than the latest activity (activity
//      after a warning blocks the purge even before the warning sweep has cleared the record).
//
// ACTIVITY SIGNALS (ACTIVITY_SIGNALS below, plus the sign-in time, the session refresh time and account creation):
//   auth.users.last_sign_in_at, auth.sessions newest created_at / updated_at / refreshed_at (read through the service role only
//   SQL function public.inactivity_last_session_activity, migration 0144: a person who only browses the dashboard refreshes
//   a token without a new sign in, and must not look inactive), accounts.created_at, scheduled_posts.{created_at, updated_at, scheduled_for (publish time, also
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
const WARNING_DAYS_BEFORE = 14; // the warning goes out this long before the account becomes eligible; the purge waits the same time
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_WARNING_MAX_PER_RUN = 25;
const WARNING_ENABLE_ENV = "INACTIVITY_WARNING_ENABLED";
const SESSION_RPC = "inactivity_last_session_activity";
const SUPPORT_ADDRESS = "support@lazyrelay.com";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
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

/** date shifted by whole calendar months, UTC, day clamped to the last day of the target month. */
function shiftMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** now minus 6 calendar months, UTC, day clamped to the last day of the target month. */
function computeCutoff(now = new Date()) {
  return shiftMonths(now, -INACTIVITY_MONTHS);
}

/** now minus (6 calendar months minus 14 days): activity older than this is due its warning. */
function computeWarnCutoff(now = new Date()) {
  return new Date(computeCutoff(now).getTime() + WARNING_DAYS_BEFORE * DAY_MS);
}

/** "5 November 2026": day, month name, year, so no reader can mistake day and month. UTC. */
function formatDate(d) {
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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

/** Newest Supabase auth session activity (created / updated / refreshed) for one account, or null when it has no session.
 * Read through the service role only SQL function from migration 0144 (auth.sessions is not exposed to PostgREST). Throws the
 * raw error when the function is missing or fails: the caller treats that as ACTIVE. */
async function latestSessionActivity(supabase, accountId) {
  const { data, error } = await supabase.rpc(SESSION_RPC, { p_account_ids: [accountId] });
  if (error) throw error;
  const row = Array.isArray(data) ? data.find((r) => r && r.account_id === accountId) : null;
  if (!row || row.last_activity == null) return null;
  const time = new Date(row.last_activity);
  if (Number.isNaN(time.getTime())) throw new Error(`${SESSION_RPC} returned an unparseable timestamp`);
  return time;
}

/** Everything about one account that does not depend on a cutoff: the exclusions and the LATEST of all activity signals.
 * Never throws for a single unreadable signal: that makes the account ACTIVE and is reported.
 * Returns {excluded: {reason, unreadable?}} or {lastActivity: Date, emailConfirmed: boolean}. */
async function inspectAccount(supabase, account) {
  const blocked = (reason, unreadable) => ({ excluded: { reason, ...(unreadable ? { unreadable } : {}) } });
  if (isInternalTestAccount(account.email)) return blocked("internal_account");
  if (account.cancelled_at) return blocked("ever_cancelled");
  if (account.data_deleted_at) return blocked("data_already_deleted");

  try {
    const { data: subs, error } = await supabase.from("subscriptions").select("status, tier").eq("account_id", account.id);
    if (error) throw error;
    if ((subs ?? []).length > 0) return blocked("has_subscription_row");
  } catch (err) {
    return blocked("unreadable_signal", `subscriptions: ${errMessage(err)}`);
  }

  try {
    const { data: legacy, error } = await supabase.from("wallet_legacy_accounts").select("account_id").eq("account_id", account.id).maybeSingle();
    if (error) throw error;
    if (legacy) return blocked("legacy_exempt");
  } catch (err) {
    return blocked("unreadable_signal", `wallet_legacy_accounts: ${errMessage(err)}`);
  }

  const stamps = [];
  const created = new Date(account.created_at);
  if (Number.isNaN(created.getTime())) return blocked("unreadable_signal", "accounts.created_at: unparseable");
  stamps.push(created);

  let emailConfirmed = false;
  try {
    const { data, error } = await supabase.auth.admin.getUserById(account.id);
    if (error) throw error;
    if (!data || !data.user) throw new Error("auth user not returned");
    emailConfirmed = Boolean(data.user.email_confirmed_at || data.user.confirmed_at);
    if (data.user.last_sign_in_at) {
      const t = new Date(data.user.last_sign_in_at);
      if (Number.isNaN(t.getTime())) throw new Error("auth.users.last_sign_in_at unparseable");
      stamps.push(t);
    }
  } catch (err) {
    return blocked("unreadable_signal", `auth.users.last_sign_in_at: ${errMessage(err)}`);
  }

  try {
    const t = await latestSessionActivity(supabase, account.id);
    if (t) stamps.push(t);
  } catch (err) {
    return blocked("unreadable_signal", `auth.sessions (${SESSION_RPC}): ${errMessage(err)}`);
  }

  for (const [table, column] of ACTIVITY_SIGNALS) {
    try {
      const t = await latestOf(supabase, table, column, account.id);
      if (t) stamps.push(t);
    } catch (err) {
      return blocked("unreadable_signal", `${table}.${column}: ${errMessage(err)}`);
    }
  }

  // the latest of all signals
  return { lastActivity: new Date(Math.max(...stamps.map((s) => s.getTime()))), emailConfirmed };
}

/** Purge decision for one account. Returns {eligible, reason?, lastActivityAt?, unreadable?}. Eligible means: not excluded,
 * the latest activity is older than the cutoff, AND the account was warned (inactivity_warned_at set, at least 14 days old,
 * not older than the latest activity). */
async function evaluateAccount(supabase, account, cutoff, now = new Date()) {
  const seen = await inspectAccount(supabase, account);
  if (seen.excluded) return { eligible: false, ...seen.excluded };
  const lastActivityAt = seen.lastActivity.toISOString();
  if (seen.lastActivity.getTime() >= cutoff.getTime()) return { eligible: false, reason: "recent_activity", lastActivityAt };

  if (!account.inactivity_warned_at) return { eligible: false, reason: "not_warned", lastActivityAt };
  const warned = new Date(account.inactivity_warned_at);
  if (Number.isNaN(warned.getTime())) return { eligible: false, reason: "unreadable_signal", unreadable: "accounts.inactivity_warned_at: unparseable" };
  if (seen.lastActivity.getTime() > warned.getTime()) return { eligible: false, reason: "activity_after_warning", lastActivityAt };
  if (warned.getTime() > now.getTime() - WARNING_DAYS_BEFORE * DAY_MS) return { eligible: false, reason: "warning_too_recent", lastActivityAt };
  return { eligible: true, lastActivityAt };
}

/** Accounts created before the cutoff and not obviously excluded, paged. Throws the raw error when unreadable. */
async function* scanCandidates(supabase, cutoff) {
  for (let from = 0; ; from += SCAN_PAGE) {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, email, created_at, cancelled_at, data_deleted_at, inactivity_warned_at")
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
  // re-read the warning record live: a warning cleared (activity seen) after the scan must stop the deletion
  const { data: fresh, error: freshError } = await supabase.from("accounts").select("inactivity_warned_at").eq("id", account.id).maybeSingle();
  if (freshError) throw freshError;
  if (!fresh) return { accountId: account.id, deleted: false, reason: "account no longer exists on the live re-check" };
  const check = await evaluateAccount(supabase, { ...account, inactivity_warned_at: fresh.inactivity_warned_at }, cutoff ?? computeCutoff(now), now);
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
    const result = await evaluateAccount(supabase, account, cutoff, now);
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

// ================================================================ WARNING EMAIL
// Policy: a Free or Pay-as-you-go account whose latest activity is older than (6 calendar months minus 14 days) gets ONE
// plain email saying when its data becomes eligible for deletion and that signing in keeps it. The send is recorded in
// accounts.inactivity_warned_at; the purge needs that record to be at least 14 days old, so the date promised in the email
// is never earlier than the earliest possible deletion. If a sweep runs late (the activity is already older than 6 months),
// the date promised is today plus 14 days, because that is the earliest the purge could act.

/** The warning email for one account. eligibleOn = the later of (latest activity + 6 calendar months) and (today + 14 days). */
function buildWarningEmail(lastActivity, now = new Date()) {
  const byActivity = shiftMonths(lastActivity, INACTIVITY_MONTHS);
  const byWarning = new Date(now.getTime() + WARNING_DAYS_BEFORE * DAY_MS);
  const eligibleOn = formatDate(byActivity.getTime() > byWarning.getTime() ? byActivity : byWarning);
  const lastDate = formatDate(lastActivity);
  const paragraphs = [
    "Hi,",
    `Your LazyRelay account has had no activity since ${lastDate}.`,
    `Free and Pay as you go accounts are subject to deletion after 6 consecutive months of total inactivity. For your account that date is ${eligibleOn}. From then on your account, posts and uploaded media can be deleted, and a deletion can't be undone.`,
    `To keep everything, sign in at lazyrelay.com and use your account any time before ${eligibleOn}. That's all it takes. You don't have to post or buy anything.`,
    `Questions? Write to ${SUPPORT_ADDRESS} and we will reply.`,
    "Werner\nLazyRelay",
  ];
  return {
    subject: "Sign in to keep your LazyRelay data",
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n"),
    eligibleOn,
  };
}

/** Warning decision for one account (same exclusions and fail safe rules as the purge). Returns {warn: true, lastActivity} or
 * {reason, unreadable?}. */
async function classifyForWarning(supabase, account, warnCutoff) {
  const seen = await inspectAccount(supabase, account);
  if (seen.excluded) return seen.excluded;
  if (seen.lastActivity.getTime() >= warnCutoff.getTime()) return { reason: "recent_activity" };
  if (!seen.emailConfirmed || typeof account.email !== "string" || !account.email) return { reason: "email_not_confirmed" };
  if (account.inactivity_warned_at) {
    const warned = new Date(account.inactivity_warned_at);
    if (Number.isNaN(warned.getTime())) return { reason: "unreadable_signal", unreadable: "accounts.inactivity_warned_at: unparseable" };
    if (warned.getTime() >= seen.lastActivity.getTime()) return { reason: "already_warned" };
  }
  return { warn: true, lastActivity: seen.lastActivity };
}

/** Every account that carries a warning record, collected up front (clearing changes what the filter matches mid paging). */
async function listWarnedAccounts(supabase) {
  const rows = [];
  for (let from = 0; ; from += SCAN_PAGE) {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, email, created_at, cancelled_at, data_deleted_at, inactivity_warned_at")
      .not("inactivity_warned_at", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + SCAN_PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < SCAN_PAGE) return rows;
  }
}

/** Single entry point for the warning email. Safe by default: a dry run that reports who WOULD be warned (and the text of the
 * first email) and sends nothing. It sends only when called with {live: true} AND env INACTIVITY_WARNING_ENABLED is exactly
 * "true". At most maxPerRun (default 25) per run; more than 25 to warn aborts until a human passes approvedEligibleCount.
 * Also clears inactivity_warned_at for accounts whose latest activity is newer than the warning (live only; a dry run only
 * counts them). opts.fromAddress is the sender address (no display name). Raw errors are surfaced, never swallowed. */
async function runInactivityWarningSweep(supabase, resend, opts = {}) {
  const {
    live = false,
    maxPerRun = DEFAULT_WARNING_MAX_PER_RUN,
    auditLog,
    now = new Date(),
    env = process.env,
    detail = false,
    approvedEligibleCount,
    fromAddress,
  } = opts;

  const liveRequested = live === true;
  const sendEnabled = liveRequested && env[WARNING_ENABLE_ENV] === "true";
  if (sendEnabled) {
    if (typeof auditLog !== "string" || !auditLog) throw new Error("runInactivityWarningSweep: live mode requires opts.auditLog (a file path) so every send is recorded");
    if (!resend || !resend.emails || typeof resend.emails.send !== "function") throw new Error("runInactivityWarningSweep: live mode requires a Resend client");
    if (typeof fromAddress !== "string" || !fromAddress) throw new Error("runInactivityWarningSweep: live mode requires opts.fromAddress");
  }
  if (!Number.isInteger(maxPerRun) || maxPerRun < 1) throw new Error("runInactivityWarningSweep: maxPerRun must be a positive integer");

  const warnCutoff = computeWarnCutoff(now);
  const blocked = {};
  const unreadableErrors = [];
  const noteBlocked = (result) => {
    blocked[result.reason] = (blocked[result.reason] ?? 0) + 1;
    if (result.unreadable && unreadableErrors.length < 5) unreadableErrors.push(result.unreadable);
  };

  // 1. activity seen after a warning: the warning no longer applies, clear it
  let wouldClearCount = 0;
  let cleared = 0;
  const clearErrors = [];
  for (const account of await listWarnedAccounts(supabase)) {
    const seen = await inspectAccount(supabase, account);
    if (seen.excluded) { if (seen.excluded.unreadable && unreadableErrors.length < 5) unreadableErrors.push(seen.excluded.unreadable); continue; }
    if (seen.lastActivity.getTime() <= new Date(account.inactivity_warned_at).getTime()) continue;
    wouldClearCount++;
    if (!sendEnabled) continue;
    const { error } = await supabase.from("accounts").update({ inactivity_warned_at: null }).eq("id", account.id);
    if (error) clearErrors.push({ accountId: account.id, error: errMessage(error) });
    else cleared++;
  }

  // 2. who is due a warning
  const toWarn = [];
  let scanned = 0;
  for await (const account of scanCandidates(supabase, warnCutoff)) {
    scanned++;
    const result = await classifyForWarning(supabase, account, warnCutoff);
    if (result.warn) toWarn.push({ account, lastActivity: result.lastActivity });
    else noteBlocked(result);
  }

  const summary = {
    mode: sendEnabled ? "live" : "dry_run",
    warnCutoff: warnCutoff.toISOString(),
    scanned,
    wouldWarnCount: toWarn.length,
    sent: 0,
    skipped: 0,
    blocked,
    unreadableCount: blocked.unreadable_signal ?? 0,
    unreadableErrors,
    wouldClearCount,
    cleared,
    clearErrors,
    sendErrors: [],
  };
  if (liveRequested && !sendEnabled) summary.liveRequestedButDisabled = true;
  if (detail) summary.wouldWarn = toWarn.map((e) => ({ accountId: e.account.id, lastActivityAt: e.lastActivity.toISOString() }));
  if (!sendEnabled && toWarn.length > 0) {
    const first = buildWarningEmail(toWarn[0].lastActivity, now);
    summary.firstEmail = { subject: first.subject, text: first.text };
  }

  const abortAbove = Number.isInteger(approvedEligibleCount) ? approvedEligibleCount : TOO_MANY_ELIGIBLE;
  if (toWarn.length > abortAbove) {
    summary.aborted = "too_many_eligible";
    return summary;
  }
  if (!sendEnabled) return summary;

  appendAudit(auditLog, { event: "inactivity_warning_run_start", at: new Date().toISOString(), wouldWarnCount: toWarn.length, maxPerRun });
  for (const { account } of toWarn.slice(0, maxPerRun)) {
    // live re-check immediately before the send: re-read the warning record and every activity signal
    const { data: fresh, error: freshError } = await supabase.from("accounts").select("inactivity_warned_at").eq("id", account.id).maybeSingle();
    if (freshError) { summary.sendErrors.push({ accountId: account.id, error: errMessage(freshError) }); continue; }
    if (!fresh) { summary.skipped++; continue; }
    const check = await classifyForWarning(supabase, { ...account, inactivity_warned_at: fresh.inactivity_warned_at }, warnCutoff);
    if (!check.warn) { summary.skipped++; continue; }

    const mail = buildWarningEmail(check.lastActivity, now);
    try {
      const result = await resend.emails.send({
        from: `LazyRelay <${fromAddress}>`,
        to: account.email,
        replyTo: SUPPORT_ADDRESS,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      if (result && result.error) throw new Error(`Resend error: ${result.error.message ?? JSON.stringify(result.error)}`);
    } catch (err) {
      summary.sendErrors.push({ accountId: account.id, error: errMessage(err) });
      continue; // nothing recorded: the account stays unwarned, so it cannot be purged
    }

    const sentAt = new Date().toISOString();
    const { error: recordError } = await supabase.from("accounts").update({ inactivity_warned_at: sentAt }).eq("id", account.id);
    if (recordError) {
      // the email went out but is not recorded: stop here so the next account is not put at the same risk of a repeat send
      summary.sent++;
      summary.recordError = `warning sent to account ${account.id} but could not be recorded: ${errMessage(recordError)}`;
      break;
    }
    appendAudit(auditLog, { event: "inactivity_warning_sent", accountId: account.id, lastActivityAt: check.lastActivity.toISOString(), sentAt });
    summary.sent++;
  }
  summary.capped = toWarn.length > maxPerRun;
  return summary;
}

module.exports = {
  runInactivityPurgeSweep,
  runInactivityWarningSweep,
  buildWarningEmail,
  evaluateAccount,
  purgeAccount,
  computeCutoff,
  computeWarnCutoff,
  DEFAULT_WARNING_MAX_PER_RUN,
  WARNING_ENABLE_ENV,
  WARNING_DAYS_BEFORE,
  ACTIVITY_SIGNALS,
  INACTIVITY_MONTHS,
  DEFAULT_MAX_PER_RUN,
  TOO_MANY_ELIGIBLE,
  ENABLE_ENV,
};
