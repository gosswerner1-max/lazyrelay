// Welcome + onboarding-nudge emails — closes the gap flagged during the
// 2026-08-21 launch-readiness pass: no welcome email or onboarding-nudge
// email existed anywhere in the backend. Both are real, direct-to-customer
// auto-sends, same pattern already live for data_retention_ops.js's
// deletion-reminder email (Resend, no draft-and-hold).
//
// Distinct from findStuckOnboardingAccounts() in accounts_ops.js, which is
// an internal 7-day alert routed to Werner for manual outreach and is left
// completely unchanged by this file. This is an earlier, automatic,
// customer-facing nudge -- both can fire for the same account (nudge at
// day 3, Werner's own internal alert still at day 7 if it's still stuck).
//
// Grounded in the real schema (migration 0062):
//   accounts(welcome_email_sent_at, onboarding_nudge_sent_at)

const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");

const ONBOARDING_NUDGE_DAYS = 3;

/** Accounts that have never received a welcome email. In steady state this
 * is just brand-new signups the poller hasn't seen yet -- migration 0062
 * backfilled every pre-existing row so this never fires retroactively. */
async function findAccountsNeedingWelcome(supabase) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, email, created_at")
    .is("welcome_email_sent_at", null);
  if (error) throw error;
  return (data ?? []).filter((a) => !isInternalTestAccount(a.email));
}

async function sendWelcomeEmail(supabase, resend, fromAddress, account) {
  if (resend) {
    const result = await resend.emails.send({
      from: `LazyRelay <${fromAddress}>`,
      to: account.email,
      subject: "Welcome to LazyRelay",
      html: `<body style="margin:0;padding:0;background-color:#0b0c10;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0c10;padding:40px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#15171c;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 40px 0 40px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="32" height="32" style="background-color:#ff5a1f;width:32px;height:32px;border-radius:8px;text-align:center;">
<font color="#0b0c10" style="color:#0b0c10;font-size:16px;font-weight:800;font-family:Arial,sans-serif;line-height:32px;">L</font></td>
<td style="padding-left:10px;color:#ffffff;font-size:18px;font-weight:600;">LazyRelay</td>
</tr></table></td></tr>
<tr><td style="padding:28px 40px 8px 40px;color:#ffffff;font-size:22px;font-weight:700;">You're in</td></tr>
<tr><td style="padding:0 40px 28px 40px;color:#a3a7b0;font-size:15px;line-height:1.6;">
Two things get you posting: connect a social account, then write your first post and schedule it. LazyRelay checks in every 30 seconds and posts it the moment it's due -- then verifies it actually went live, not just "sent."</td></tr>
<tr><td style="padding:0 40px 36px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background-color:#ffffff;border-radius:8px;padding:14px 28px;">
<a href="https://lazyrelay.com/dashboard" style="font-size:15px;font-weight:700;color:#0b0c10;text-decoration:none;">Connect your first account &#8594;</a>
</td></tr></table></td></tr>
<tr><td style="padding:0 40px 32px 40px;border-top:1px solid #2a2d35;padding-top:20px;color:#6b6f78;font-size:13px;line-height:1.5;">
Questions any time -- just reply to this email, or use the chat on your dashboard.</td></tr>
</table></td></tr></table></body>`,
    });
    if (result.error) throw new Error(`Resend error for ${account.email}: ${result.error.message}`);
  }

  const { error } = await supabase
    .from("accounts")
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq("id", account.id);
  if (error) throw error;
}

/** Accounts ONBOARDING_NUDGE_DAYS+ old, zero connected accounts, never
 * nudged. Same "zero connected accounts" check as accounts_ops.js's
 * findStuckOnboardingAccounts(), independent cutoff and independent
 * sent-flag -- this firing does not stop the later 7-day internal alert
 * from also firing if the account is still stuck by then. */
async function findAccountsNeedingOnboardingNudge(supabase, daysThreshold = ONBOARDING_NUDGE_DAYS) {
  const cutoff = new Date(Date.now() - daysThreshold * 24 * 3600 * 1000).toISOString();
  const { data: accounts, error } = await supabase
    .from("accounts")
    .select("id, email, created_at")
    .lt("created_at", cutoff)
    .is("cancelled_at", null)
    .is("onboarding_nudge_sent_at", null);
  if (error) throw error;

  const candidates = [];
  for (const account of accounts ?? []) {
    if (isInternalTestAccount(account.email)) continue;
    const { count, error: countError } = await supabase
      .from("social_accounts")
      .select("id", { count: "exact", head: true })
      .eq("account_id", account.id)
      .is("disconnected_at", null);
    if (countError) throw countError;
    if ((count ?? 0) === 0) candidates.push(account);
  }
  return candidates;
}

async function sendOnboardingNudgeEmail(supabase, resend, fromAddress, account) {
  if (resend) {
    const result = await resend.emails.send({
      from: `LazyRelay <${fromAddress}>`,
      to: account.email,
      subject: "Still there? Connect an account to get posting",
      html: `<body style="margin:0;padding:0;background-color:#0b0c10;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0c10;padding:40px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#15171c;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 40px 0 40px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="32" height="32" style="background-color:#ff5a1f;width:32px;height:32px;border-radius:8px;text-align:center;">
<font color="#0b0c10" style="color:#0b0c10;font-size:16px;font-weight:800;font-family:Arial,sans-serif;line-height:32px;">L</font></td>
<td style="padding-left:10px;color:#ffffff;font-size:18px;font-weight:600;">LazyRelay</td>
</tr></table></td></tr>
<tr><td style="padding:28px 40px 8px 40px;color:#ffffff;font-size:22px;font-weight:700;">Nothing's connected yet</td></tr>
<tr><td style="padding:0 40px 28px 40px;color:#a3a7b0;font-size:15px;line-height:1.6;">
Your LazyRelay account is ready, but there's no social account linked yet, so there's nothing to schedule to. It takes about a minute to connect one.</td></tr>
<tr><td style="padding:0 40px 36px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background-color:#ffffff;border-radius:8px;padding:14px 28px;">
<a href="https://lazyrelay.com/dashboard" style="font-size:15px;font-weight:700;color:#0b0c10;text-decoration:none;">Connect an account &#8594;</a>
</td></tr></table></td></tr>
<tr><td style="padding:0 40px 32px 40px;border-top:1px solid #2a2d35;padding-top:20px;color:#6b6f78;font-size:13px;line-height:1.5;">
Stuck, or this isn't for you? Just reply to this email -- a real person reads it.</td></tr>
</table></td></tr></table></body>`,
    });
    if (result.error) throw new Error(`Resend error for ${account.email}: ${result.error.message}`);
  }

  const { error } = await supabase
    .from("accounts")
    .update({ onboarding_nudge_sent_at: new Date().toISOString() })
    .eq("id", account.id);
  if (error) throw error;
}

/** Single entry point the scheduled task calls. resend/fromAddress may be
 * null (RESEND_API_KEY not configured) -- the sweep still runs and still
 * marks accounts as handled, it just can't actually send; that's reported
 * back so it's visible, not silently swallowed, same convention as
 * data_retention_ops.js. */
async function runWelcomeOnboardingSweep(supabase, resend, fromAddress) {
  const welcomeCandidates = await findAccountsNeedingWelcome(supabase);
  let welcomeSent = 0;
  const welcomeErrors = [];
  for (const account of welcomeCandidates) {
    try {
      await sendWelcomeEmail(supabase, resend, fromAddress, account);
      welcomeSent++;
    } catch (err) {
      welcomeErrors.push({ email: account.email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const nudgeCandidates = await findAccountsNeedingOnboardingNudge(supabase);
  let nudgeSent = 0;
  const nudgeErrors = [];
  for (const account of nudgeCandidates) {
    try {
      await sendOnboardingNudgeEmail(supabase, resend, fromAddress, account);
      nudgeSent++;
    } catch (err) {
      nudgeErrors.push({ email: account.email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    welcomeSent,
    welcomeCandidateCount: welcomeCandidates.length,
    welcomeErrors,
    nudgeSent,
    nudgeCandidateCount: nudgeCandidates.length,
    nudgeErrors,
  };
}

module.exports = {
  findAccountsNeedingWelcome,
  sendWelcomeEmail,
  findAccountsNeedingOnboardingNudge,
  sendOnboardingNudgeEmail,
  runWelcomeOnboardingSweep,
  ONBOARDING_NUDGE_DAYS,
};
