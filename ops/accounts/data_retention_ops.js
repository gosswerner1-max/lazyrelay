// Data Retention Operator — the one place a customer's data is ever
// genuinely, permanently deleted in this whole product (2026-08-15 policy).
// Everywhere else (storageQuota.ts, this same accounts domain's own
// downgrade-pause logic) deliberately never deletes — see
// ACCOUNTS_KNOWLEDGE.md. This is the sole, deliberate exception, and it
// only fires 30 days after a real subscription.canceled webhook, never
// before, never for an account that resubscribed in the meantime.
//
// Grounded in the real schema (backend/supabase/migrations/0046):
//   accounts(cancelled_at, data_deletion_ack_at, data_deletion_reminder_sent_at, data_deleted_at)
//
// Built as ONE orchestrating function (runDataRetentionSweep), not a set of
// pieces the scheduled task glues together at run time — unlike the other
// ops files, the deletion pass here is irreversible, so it should not be
// improvised fresh by an unattended agent run each time. The scheduled
// task's job is just to call this function and report what it returns.

const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");

const REMINDER_DAYS = 23;
const DELETION_DAYS = 30;
const MEDIA_BUCKET = "post-media";

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

/** Accounts cancelled 23+ days ago, not yet reminded, not yet deleted. */
async function findAccountsNeedingReminder(supabase) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, email, cancelled_at")
    .not("cancelled_at", "is", null)
    .lte("cancelled_at", daysAgo(REMINDER_DAYS))
    .is("data_deletion_reminder_sent_at", null)
    .is("data_deleted_at", null);
  if (error) throw error;
  return (data ?? []).filter((a) => !isInternalTestAccount(a.email));
}

/** Accounts cancelled 30+ days ago, not yet deleted. Being on this list is
 * NOT sufficient to delete on its own — deleteAccountData re-verifies live
 * subscription status before touching anything, in case of a very recent
 * resubscribe that hasn't propagated to this account's cancelled_at yet. */
async function findAccountsPastGracePeriod(supabase) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, email, cancelled_at")
    .not("cancelled_at", "is", null)
    .lte("cancelled_at", daysAgo(DELETION_DAYS))
    .is("data_deleted_at", null);
  if (error) throw error;
  return (data ?? []).filter((a) => !isInternalTestAccount(a.email));
}

/** Sends the 7-days-left reminder and marks it sent. Deletion date shown to
 * the customer is computed from their real cancelled_at, not a guess. */
async function sendReminder(supabase, resend, fromAddress, account) {
  const deletionDate = new Date(new Date(account.cancelled_at).getTime() + DELETION_DAYS * 24 * 3600 * 1000);
  const deletionDateStr = deletionDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  if (resend) {
    const result = await resend.emails.send({
      from: `LazyRelay <${fromAddress}>`,
      to: account.email,
      subject: "Your LazyRelay data will be deleted in 7 days",
      html: `<body style="margin:0;padding:0;background-color:#0b0c10;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0c10;padding:40px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#15171c;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 40px 0 40px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="32" height="32" style="background-color:#ff5a1f;width:32px;height:32px;border-radius:8px;text-align:center;">
<font color="#0b0c10" style="color:#0b0c10;font-size:16px;font-weight:800;font-family:Arial,sans-serif;line-height:32px;">L</font></td>
<td style="padding-left:10px;color:#ffffff;font-size:18px;font-weight:600;">LazyRelay</td>
</tr></table></td></tr>
<tr><td style="padding:28px 40px 8px 40px;color:#ffffff;font-size:22px;font-weight:700;">Your data will be deleted soon</td></tr>
<tr><td style="padding:0 40px 32px 40px;color:#a3a7b0;font-size:15px;line-height:1.6;">
You cancelled your LazyRelay subscription, and your posts and stored media are scheduled to be permanently deleted on
<span style="color:#ffffff;">${deletionDateStr}</span>.<br><br>
If you want to keep anything, download it before then — this can't be undone once it happens.<br><br>
If you'd rather keep your account, resubscribing before that date cancels the deletion.</td></tr>
<tr><td style="padding:0 40px 32px 40px;border-top:1px solid #2a2d35;padding-top:20px;color:#6b6f78;font-size:13px;line-height:1.5;">
This is a required notice about your account's stored data, sent to everyone whose data is scheduled for deletion — it isn't tied to any notification preference.</td></tr>
</table></td></tr></table></body>`,
    });
    if (result.error) throw new Error(`Resend error for ${account.email}: ${result.error.message}`);
  }

  const { error } = await supabase
    .from("accounts")
    .update({ data_deletion_reminder_sent_at: new Date().toISOString() })
    .eq("id", account.id);
  if (error) throw error;
}

/** The actual deletion. Re-verifies live subscription status FIRST — belt
 * and suspenders against the resubscribe-clears-cancelled_at fix in
 * sync.ts, in case of any webhook timing gap. Reuses the exact storage
 * removal pattern already tested and live at DELETE /media/:id
 * (routes.ts) rather than inventing a second way to remove files from the
 * post-media bucket. */
async function deleteAccountData(supabase, account) {
  const { data: sub } = await supabase.from("subscriptions").select("status").eq("account_id", account.id).single();
  if (sub && (sub.status === "active" || sub.status === "trialing")) {
    return { accountId: account.id, deleted: false, reason: "subscription is active again — not deleting" };
  }

  const { data: media, error: mediaError } = await supabase
    .from("media_uploads")
    .select("id, storage_path")
    .eq("account_id", account.id);
  if (mediaError) throw mediaError;

  const paths = (media ?? []).map((m) => m.storage_path).filter(Boolean);
  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage.from(MEDIA_BUCKET).remove(paths);
    if (storageError) throw storageError;
  }

  if ((media ?? []).length > 0) {
    const { error: mediaDeleteError } = await supabase
      .from("media_uploads")
      .delete()
      .eq("account_id", account.id);
    if (mediaDeleteError) throw mediaDeleteError;
  }

  // post_results and post_metrics both cascade from scheduled_posts (on
  // delete cascade) — see migrations 0001 and 0033 — so deleting here is
  // sufficient, no separate delete needed for either.
  const { error: postsError } = await supabase.from("scheduled_posts").delete().eq("account_id", account.id);
  if (postsError) throw postsError;

  const { error: markError } = await supabase
    .from("accounts")
    .update({ data_deleted_at: new Date().toISOString() })
    .eq("id", account.id);
  if (markError) throw markError;

  return { accountId: account.id, deleted: true, mediaFilesRemoved: paths.length };
}

/** Single entry point the scheduled task calls. resend/fromAddress may be
 * null (e.g. RESEND_API_KEY not configured) — the sweep still runs and
 * still deletes on schedule, it just can't send the reminder; that's
 * reported back so it's visible, not silently swallowed. */
async function runDataRetentionSweep(supabase, resend, fromAddress) {
  const reminderCandidates = await findAccountsNeedingReminder(supabase);
  let remindersSent = 0;
  const reminderErrors = [];
  for (const account of reminderCandidates) {
    try {
      await sendReminder(supabase, resend, fromAddress, account);
      remindersSent++;
    } catch (err) {
      reminderErrors.push({ email: account.email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const deletionCandidates = await findAccountsPastGracePeriod(supabase);
  let accountsDeleted = 0;
  let deletionsSkipped = 0;
  const deletionErrors = [];
  const deletionResults = [];
  for (const account of deletionCandidates) {
    try {
      const result = await deleteAccountData(supabase, account);
      deletionResults.push({ email: account.email, ...result });
      if (result.deleted) accountsDeleted++;
      else deletionsSkipped++;
    } catch (err) {
      deletionErrors.push({ email: account.email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    remindersSent,
    reminderCandidateCount: reminderCandidates.length,
    reminderErrors,
    accountsDeleted,
    deletionsSkipped,
    deletionCandidateCount: deletionCandidates.length,
    deletionErrors,
    deletionResults,
  };
}

module.exports = {
  findAccountsNeedingReminder,
  findAccountsPastGracePeriod,
  sendReminder,
  deleteAccountData,
  runDataRetentionSweep,
  REMINDER_DAYS,
  DELETION_DAYS,
};
