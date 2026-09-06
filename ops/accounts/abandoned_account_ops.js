// Abandoned Account Operator — the SECOND (and only other) place a real
// customer's account is ever permanently deleted in this product, alongside
// data_retention_ops.js. Deliberately a separate module and a separate
// scheduled task, not folded into that one: this policy is genuinely
// different, not a variant of it. data_retention_ops.js only wipes CONTENT
// (posts/media) for a formerly-active customer AFTER a real
// subscription.canceled webhook -- it never touches the accounts row itself.
// This module deletes the ACCOUNT ITSELF (accounts row + auth.users row),
// and only for an account that NEVER had a subscription lifecycle at all --
// signed up, connected zero social accounts, created zero posts, ever.
// There is nothing to "wipe" for a genuinely abandoned account since it has
// no content by definition; the only meaningful action is removing the
// empty account.
//
// Policy decided 2026-09-06 (Werner, after competitor research showed the
// industry norm -- SocialBee, Planable -- is to scope any inactivity-based
// deletion strictly to accounts with zero real configuration, and to exempt
// paid accounts unconditionally, never basing it on login activity, since
// LazyRelay's own pitch is "schedule it and forget it" -- a paid customer
// who stops logging in while their posts keep running is not a problem to
// solve).
//
// "Abandoned" = accounts.cancelled_at IS NULL (never had a subscription
// cancellation -- an account that DID have one is data_retention_ops.js's
// job, not this one, so the two systems can never double-process the same
// row) AND zero rows in social_accounts AND zero rows in scheduled_posts
// AND no currently active/trialing subscription (checked live, not
// inferred, exactly like deleteAccountData's own resubscribe-safety check
// below). Age is measured from accounts.created_at, since a truly abandoned
// account has no later timestamp to measure from -- nothing ever happened.
//
// Timeline: 180 days (6 months) old -> deleted, with 2 warning emails at
// day 166 (14 days before) and day 177 (3 days before). Any account that
// connects a social account or creates a post at any point immediately
// stops qualifying -- the live re-check at every stage (including
// immediately before deletion) guarantees this, the same belt-and-suspenders
// pattern data_retention_ops.js already uses for resubscribe safety.
//
// Grounded in the real schema (backend/supabase/migrations/0085):
//   accounts(abandonment_reminder_1_sent_at, abandonment_reminder_2_sent_at)
//
// Built as ONE orchestrating function (runAbandonedAccountSweep), same
// discipline as data_retention_ops.js and for the same reason: the deletion
// pass here is irreversible, so it must not be improvised fresh by an
// unattended agent run each time.

const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");

const ABANDONMENT_DAYS = 180;
const REMINDER_1_DAYS_BEFORE = 14;
const REMINDER_2_DAYS_BEFORE = 3;
const REMINDER_1_AT_DAYS = ABANDONMENT_DAYS - REMINDER_1_DAYS_BEFORE; // 166
const REMINDER_2_AT_DAYS = ABANDONMENT_DAYS - REMINDER_2_DAYS_BEFORE; // 177
const MIN_DAYS_AFTER_REMINDER_2 = REMINDER_2_DAYS_BEFORE; // 3 -- same shape as data_retention_ops.js's MIN_DAYS_AFTER_REMINDER

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

/** Re-verified live at every stage (initial candidate list, second reminder,
 * and immediately before deletion) -- never trusted from an earlier read.
 * Returns false the moment ANY of the three conditions stops holding, so an
 * account that connects a platform or creates a post between checks is
 * immediately safe. */
async function isCurrentlyAbandoned(supabase, accountId) {
  const { count: socialCount, error: socialError } = await supabase
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (socialError) throw socialError;
  if ((socialCount ?? 0) > 0) return false;

  const { count: postCount, error: postError } = await supabase
    .from("scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (postError) throw postError;
  if ((postCount ?? 0) > 0) return false;

  // Same check as data_retention_ops.js's deleteAccountData -- exempt paid
  // no matter what, checked live rather than inferred from cancelled_at.
  const { data: sub, error: subError } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("account_id", accountId)
    .maybeSingle();
  if (subError) throw subError;
  if (sub && (sub.status === "active" || sub.status === "trialing")) return false;

  return true;
}

/** Accounts old enough for the first warning (166+ days), never cancelled
 * (that's data_retention_ops.js's territory), not yet reminded once. */
async function findAccountsNeedingReminder1(supabase) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, email, created_at")
    .is("cancelled_at", null)
    .lte("created_at", daysAgo(REMINDER_1_AT_DAYS))
    .is("abandonment_reminder_1_sent_at", null);
  if (error) throw error;
  const candidates = (data ?? []).filter((a) => !isInternalTestAccount(a.email));
  const stillAbandoned = [];
  for (const account of candidates) {
    if (await isCurrentlyAbandoned(supabase, account.id)) stillAbandoned.push(account);
  }
  return stillAbandoned;
}

/** Accounts old enough for the second warning (177+ days), already got
 * reminder 1, not yet reminded twice. Re-verifies abandonment live -- an
 * account that connected something after reminder 1 must not get reminder 2. */
async function findAccountsNeedingReminder2(supabase) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, email, created_at")
    .is("cancelled_at", null)
    .lte("created_at", daysAgo(REMINDER_2_AT_DAYS))
    .not("abandonment_reminder_1_sent_at", "is", null)
    .is("abandonment_reminder_2_sent_at", null);
  if (error) throw error;
  const candidates = (data ?? []).filter((a) => !isInternalTestAccount(a.email));
  const stillAbandoned = [];
  for (const account of candidates) {
    if (await isCurrentlyAbandoned(supabase, account.id)) stillAbandoned.push(account);
  }
  return stillAbandoned;
}

/** Accounts past the 180-day mark, reminded twice, with a genuine
 * MIN_DAYS_AFTER_REMINDER_2 gap since the second reminder -- same
 * missed-run protection as data_retention_ops.js's findAccountsPastGracePeriod,
 * so a late-running sweep can never collapse the last warning and the
 * actual deletion into the same run. */
async function findAccountsPastAbandonmentThreshold(supabase) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, email, created_at, abandonment_reminder_2_sent_at")
    .is("cancelled_at", null)
    .lte("created_at", daysAgo(ABANDONMENT_DAYS))
    .not("abandonment_reminder_2_sent_at", "is", null)
    .lte("abandonment_reminder_2_sent_at", daysAgo(MIN_DAYS_AFTER_REMINDER_2));
  if (error) throw error;
  const candidates = (data ?? []).filter((a) => !isInternalTestAccount(a.email));
  const stillAbandoned = [];
  for (const account of candidates) {
    if (await isCurrentlyAbandoned(supabase, account.id)) stillAbandoned.push(account);
  }
  return stillAbandoned;
}

function emailShell(headline, bodyHtml) {
  return `<body style="margin:0;padding:0;background-color:#0b0c10;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0c10;padding:40px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#15171c;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 40px 0 40px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="32" height="32" style="background-color:#ff5a1f;width:32px;height:32px;border-radius:8px;text-align:center;">
<font color="#0b0c10" style="color:#0b0c10;font-size:16px;font-weight:800;font-family:Arial,sans-serif;line-height:32px;">L</font></td>
<td style="padding-left:10px;color:#ffffff;font-size:18px;font-weight:600;">LazyRelay</td>
</tr></table></td></tr>
<tr><td style="padding:28px 40px 8px 40px;color:#ffffff;font-size:22px;font-weight:700;">${headline}</td></tr>
<tr><td style="padding:0 40px 32px 40px;color:#a3a7b0;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
<tr><td style="padding:0 40px 32px 40px;border-top:1px solid #2a2d35;padding-top:20px;color:#6b6f78;font-size:13px;line-height:1.5;">
This is a required notice about your account, sent to everyone whose account is scheduled for deletion under our Privacy Policy's inactivity terms — it isn't tied to any notification preference.</td></tr>
</table></td></tr></table></body>`;
}

async function sendReminder1(supabase, resend, fromAddress, account) {
  const deletionDate = new Date(new Date(account.created_at).getTime() + ABANDONMENT_DAYS * 24 * 3600 * 1000);
  const deletionDateStr = deletionDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  if (resend) {
    const result = await resend.emails.send({
      from: `LazyRelay <${fromAddress}>`,
      to: account.email,
      subject: "Still there? Your LazyRelay account is due for cleanup",
      html: emailShell(
        "Still there?",
        `We noticed your LazyRelay account has never connected a social account or scheduled a post. Under our inactivity policy, an account like this is deleted after 6 months — yours is scheduled for <span style="color:#ffffff;">${deletionDateStr}</span>.<br><br>
        If you want to keep it, just log in and connect a platform or schedule a post any time before then — that's all it takes to cancel the deletion.<br><br>
        If you meant to leave it, there's nothing else to do.`,
      ),
    });
    if (result.error) throw new Error(`Resend error for ${account.email}: ${result.error.message}`);
  }

  const { error } = await supabase
    .from("accounts")
    .update({ abandonment_reminder_1_sent_at: new Date().toISOString() })
    .eq("id", account.id);
  if (error) throw error;
}

async function sendReminder2(supabase, resend, fromAddress, account) {
  const deletionDate = new Date(new Date(account.created_at).getTime() + ABANDONMENT_DAYS * 24 * 3600 * 1000);
  const deletionDateStr = deletionDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  if (resend) {
    const result = await resend.emails.send({
      from: `LazyRelay <${fromAddress}>`,
      to: account.email,
      subject: "Your LazyRelay account will be deleted in 3 days",
      html: emailShell(
        "Last notice",
        `Your LazyRelay account still has no connected social account and no scheduled post. It will be permanently deleted on <span style="color:#ffffff;">${deletionDateStr}</span>.<br><br>
        Log in and connect a platform or schedule a post before then to keep it — that's all it takes.`,
      ),
    });
    if (result.error) throw new Error(`Resend error for ${account.email}: ${result.error.message}`);
  }

  const { error } = await supabase
    .from("accounts")
    .update({ abandonment_reminder_2_sent_at: new Date().toISOString() })
    .eq("id", account.id);
  if (error) throw error;
}

/** The actual deletion. Re-verifies abandonment live FIRST, one more time,
 * immediately before touching anything — the same belt-and-suspenders
 * principle as deleteAccountData's live resubscribe check. Deletes
 * account_members rows (both as owner and as any membership grant),
 * subscriptions rows (defensive — should be none), the accounts row, and
 * finally the auth.users row via the admin API. Unlike deleteAccountData,
 * there is no media/post cleanup to do first: an abandoned account has zero
 * of either by definition, re-confirmed by this same check. */
async function deleteAbandonedAccount(supabase, account) {
  const stillAbandoned = await isCurrentlyAbandoned(supabase, account.id);
  if (!stillAbandoned) {
    return { accountId: account.id, deleted: false, reason: "no longer abandoned as of the live re-check — not deleting" };
  }

  const { error: membersError } = await supabase
    .from("account_members")
    .delete()
    .or(`account_id.eq.${account.id},user_id.eq.${account.id}`);
  if (membersError) throw membersError;

  const { error: subsError } = await supabase.from("subscriptions").delete().eq("account_id", account.id);
  if (subsError) throw subsError;

  const { error: accountError } = await supabase.from("accounts").delete().eq("id", account.id);
  if (accountError) throw accountError;

  const { error: authError } = await supabase.auth.admin.deleteUser(account.id);
  if (authError) throw authError;

  return { accountId: account.id, deleted: true };
}

/** Single entry point the scheduled task calls. resend/fromAddress may be
 * null (e.g. RESEND_API_KEY not configured) — the sweep still runs and
 * still deletes on schedule, it just can't send reminders; that's reported
 * back so it's visible, not silently swallowed. */
async function runAbandonedAccountSweep(supabase, resend, fromAddress) {
  const reminder1Candidates = await findAccountsNeedingReminder1(supabase);
  let reminder1Sent = 0;
  const reminder1Errors = [];
  for (const account of reminder1Candidates) {
    try {
      await sendReminder1(supabase, resend, fromAddress, account);
      reminder1Sent++;
    } catch (err) {
      reminder1Errors.push({ email: account.email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const reminder2Candidates = await findAccountsNeedingReminder2(supabase);
  let reminder2Sent = 0;
  const reminder2Errors = [];
  for (const account of reminder2Candidates) {
    try {
      await sendReminder2(supabase, resend, fromAddress, account);
      reminder2Sent++;
    } catch (err) {
      reminder2Errors.push({ email: account.email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const deletionCandidates = await findAccountsPastAbandonmentThreshold(supabase);
  let accountsDeleted = 0;
  let deletionsSkipped = 0;
  const deletionErrors = [];
  const deletionResults = [];
  for (const account of deletionCandidates) {
    try {
      const result = await deleteAbandonedAccount(supabase, account);
      deletionResults.push({ email: account.email, ...result });
      if (result.deleted) accountsDeleted++;
      else deletionsSkipped++;
    } catch (err) {
      deletionErrors.push({ email: account.email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    reminder1Sent,
    reminder1CandidateCount: reminder1Candidates.length,
    reminder1Errors,
    reminder2Sent,
    reminder2CandidateCount: reminder2Candidates.length,
    reminder2Errors,
    accountsDeleted,
    deletionsSkipped,
    deletionCandidateCount: deletionCandidates.length,
    deletionErrors,
    deletionResults,
  };
}

module.exports = {
  findAccountsNeedingReminder1,
  findAccountsNeedingReminder2,
  findAccountsPastAbandonmentThreshold,
  sendReminder1,
  sendReminder2,
  deleteAbandonedAccount,
  isCurrentlyAbandoned,
  runAbandonedAccountSweep,
  ABANDONMENT_DAYS,
  REMINDER_1_AT_DAYS,
  REMINDER_2_AT_DAYS,
  MIN_DAYS_AFTER_REMINDER_2,
};
