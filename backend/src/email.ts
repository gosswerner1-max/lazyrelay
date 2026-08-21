import { Resend } from "resend";

// Customer-facing transactional email — proactive failure alerts (2026-08-08,
// project-competitor-feature-audit-2026-08-07.md item 7). Separate from
// Supabase's own auth-email SMTP integration (confirmation/reset/magic-link
// emails) — this is a direct Resend API call from application code, the
// only way to send a custom message Supabase's auth system doesn't cover.
// Optional, same fall-through pattern as every other integration here
// (ANTHROPIC_API_KEY, MOR credentials): missing config degrades this one
// feature, never crashes boot.

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS ?? "noreply@mail.lazyrelay.com";

function getClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

/** The opt-in failure-alerts toggle on the dashboard's Account tab governs
 *  exactly two senders — a terminal post failure and an account pause. Shared
 *  so those two can't drift apart in wording. */
const FAILURE_ALERT_FOOTER =
  "You're getting this because you turned on failure alerts in your LazyRelay dashboard's Account settings. Turn it off there any time.";

// Same visual language as the existing Supabase auth-email templates
// (dark background, orange LazyRelay logo block) — see the mailer_templates_*
// content in Supabase's Auth config for the original.
//
// footerHtml is REQUIRED on purpose. It used to default to
// FAILURE_ALERT_FOOTER, which was right for the two senders gated on that
// toggle and quietly wrong for everything else: the support-widget
// escalation inherited it and told an internal handoff mail that the
// *recipient* had turned on failure alerts. Twelve-plus of those went to our
// own mailboxes before it was fixed (2026-08-17). A default that is only
// correct for some callers is worse than no default -- every caller now has
// to say who is getting this and why.
function wrapEmailHtml(
  heading: string,
  bodyHtml: string,
  footerHtml: string,
): string {
  return `<body style="margin:0;padding:0;background-color:#0b0c10;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0c10;padding:40px 0;">
  <tr><td align="center">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#15171c;border-radius:12px;overflow:hidden;">
  <tr><td style="padding:32px 40px 0 40px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
  <td width="32" height="32" style="background-color:#ff5a1f;width:32px;height:32px;border-radius:8px;text-align:center;">
  <font color="#0b0c10" style="color:#0b0c10;font-size:16px;font-weight:800;font-family:Arial,sans-serif;line-height:32px;">L</font>
  </td>
  <td style="padding-left:10px;color:#ffffff;font-size:18px;font-weight:600;">LazyRelay</td>
  </tr></table>
  </td></tr>
  <tr><td style="padding:28px 40px 8px 40px;color:#ffffff;font-size:22px;font-weight:700;">${heading}</td></tr>
  <tr><td style="padding:0 40px 32px 40px;color:#a3a7b0;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
  <tr><td style="padding:0 40px 32px 40px;border-top:1px solid #2a2d35;padding-top:20px;color:#6b6f78;font-size:13px;line-height:1.5;">
  ${footerHtml}
  </td></tr>
  </table>
  </td></tr>
  </table>
  </body>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fire-and-forget by design, same as notifyOps — a failed alert email must
 *  never throw back into the scheduler's own failure-handling path. Errors
 *  are logged, not surfaced to the caller. */
export function sendFailureAlert(to: string, content: string, reason: string): void {
  const client = getClient();
  if (!client) return;
  const snippet = content.length > 200 ? `${content.slice(0, 200)}...` : content;
  client.emails
    .send({
      from: `LazyRelay <${FROM_ADDRESS}>`,
      to,
      subject: "A scheduled post couldn't be published",
      html: wrapEmailHtml(
        "A post couldn't be published",
        `We tried repeatedly to publish this post and couldn't confirm it went live:<br><br>` +
          `<span style="color:#ffffff;">&quot;${escapeHtml(snippet)}&quot;</span><br><br>` +
          `Reason: ${escapeHtml(reason)}<br><br>` +
          `Check your dashboard to retry or fix the connected account.`,
        FAILURE_ALERT_FOOTER
      ),
    })
    .then((result) => {
      if (result.error) console.error("[email] sendFailureAlert failed:", result.error.message);
    })
    .catch((err) => console.error("[email] sendFailureAlert threw:", err instanceof Error ? err.message : err));
}

const ESCALATION_ADDRESSES = {
  hello: "hello@lazyrelay.com",
  support: "support@lazyrelay.com",
  accounts: "accounts@lazyrelay.com",
} as const;

/** Support-widget escalation handoff (2026-08-10) — when the AI support
 *  chat can't resolve something itself, it hands the transcript to the same
 *  mailbox a human would route it to, so the existing autonomous email
 *  agent picks it up exactly like any other inbound message. Fire-and-forget
 *  for the same reason as the other senders here — a failed handoff email
 *  must never break the chat response the customer already got. */
export function sendSupportEscalation(mailbox: keyof typeof ESCALATION_ADDRESSES, transcript: string): void {
  const client = getClient();
  if (!client) return;
  const to = ESCALATION_ADDRESSES[mailbox];
  client.emails
    .send({
      from: `LazyRelay Support Widget <${FROM_ADDRESS}>`,
      to,
      subject: "Support widget escalation",
      html: wrapEmailHtml(
        "Support widget escalation",
        `The AI support widget couldn't resolve this conversation and handed it off:<br><br>` +
          `<pre style="white-space:pre-wrap;color:#ffffff;font-family:inherit;font-size:14px;">${escapeHtml(transcript)}</pre>`,
        "Internal handoff from the LazyRelay support widget — not a customer notification, and the customer isn't copied on it. " +
          "Reply to them directly using the address in the Customer line above, if one was captured."
      ),
    })
    .then((result) => {
      if (result.error) console.error("[email] sendSupportEscalation failed:", result.error.message);
    })
    .catch((err) => console.error("[email] sendSupportEscalation threw:", err instanceof Error ? err.message : err));
}

/** Sent once, 23 days into the 30-day post-cancellation grace period
 *  (2026-08-15 data-deletion policy) — gives a real week's notice before
 *  permanent deletion, not just the one checkbox ticked a month earlier at
 *  cancel time. This is NOT gated on the opt-in "failure alerts" setting
 *  used by the other senders in this file (that toggle is about post
 *  failures, unrelated) — it always sends, since it's a real notice a
 *  customer needs regardless of any other preference. Fire-and-forget same
 *  as the rest of this file; a failed send must never block the reaper
 *  job's own run. */
export function sendDataDeletionReminder(to: string, deletionDate: string): void {
  const client = getClient();
  if (!client) return;
  client.emails
    .send({
      from: `LazyRelay <${FROM_ADDRESS}>`,
      to,
      subject: "Your LazyRelay data will be deleted in 7 days",
      html: wrapEmailHtml(
        "Your data will be deleted soon",
        `You cancelled your LazyRelay subscription, and your posts and stored media are scheduled to be permanently deleted on ` +
          `<span style="color:#ffffff;">${escapeHtml(deletionDate)}</span>.<br><br>` +
          `If you want to keep anything, download it before then — this can't be undone once it happens.<br><br>` +
          `If you'd rather keep your account, resubscribing before that date cancels the deletion.`,
        "This is a required notice about your account's stored data, sent to everyone whose data is scheduled for deletion — it isn't tied to any notification preference."
      ),
    })
    .then((result) => {
      if (result.error) console.error("[email] sendDataDeletionReminder failed:", result.error.message);
    })
    .catch((err) => console.error("[email] sendDataDeletionReminder threw:", err instanceof Error ? err.message : err));
}

/** Agency tier v1 team invite (migration 0053, account_members). Sent when
 *  an account owner invites a teammate — the link carries the invite token
 *  from account_members.invite_token, consumed by POST /team/accept-invite
 *  once the invited person is signed in. Fire-and-forget, same as the rest
 *  of this file. */
export function sendTeamInviteEmail(to: string, inviterLabel: string, acceptUrl: string): void {
  const client = getClient();
  if (!client) return;
  client.emails
    .send({
      from: `LazyRelay <${FROM_ADDRESS}>`,
      to,
      subject: `${inviterLabel} invited you to their LazyRelay team`,
      html: wrapEmailHtml(
        "You've been invited to a LazyRelay team",
        `<span style="color:#ffffff;">${escapeHtml(inviterLabel)}</span> invited you to join their LazyRelay account as a team member.<br><br>` +
          `<a href="${acceptUrl}" style="color:#ff5a1f;">Accept the invite</a><br><br>` +
          `If you don't have a LazyRelay login yet, you'll be asked to create one first. Use this same email address.`,
        "You're getting this because someone entered your email address as a LazyRelay team invite. If this wasn't expected, you can ignore it."
      ),
    })
    .then((result) => {
      if (result.error) console.error("[email] sendTeamInviteEmail failed:", result.error.message);
    })
    .catch((err) => console.error("[email] sendTeamInviteEmail threw:", err instanceof Error ? err.message : err));
}

/** Review-feedback form submission (2026-08-21) — Werner's call: the
 *  customer only clicks Submit once, nothing else required from them. This
 *  is the actual delivery mechanism, not a courtesy copy — the structured
 *  ratings live in review_feedback (migration 0063), but the human-readable
 *  version of "the review was sent to us" is this real email landing in
 *  hello@lazyrelay.com, same internal-handoff pattern as
 *  sendSupportEscalation above. Fire-and-forget for the same reason as the
 *  rest of this file — a failed notification must never fail the customer's
 *  actual submission (which already succeeded once the DB write above it
 *  commits). */
export function sendReviewFeedbackNotification(ratingsSummary: string, comment: string | null): void {
  const client = getClient();
  if (!client) return;
  client.emails
    .send({
      from: `LazyRelay Feedback Form <${FROM_ADDRESS}>`,
      to: ESCALATION_ADDRESSES.hello,
      subject: "New review feedback submitted",
      html: wrapEmailHtml(
        "New review feedback",
        `A customer submitted the star-rating feedback form:<br><br>` +
          `<pre style="white-space:pre-wrap;color:#ffffff;font-family:inherit;font-size:14px;">${escapeHtml(ratingsSummary)}</pre>` +
          (comment
            ? `<br>Comment:<br><span style="color:#ffffff;">${escapeHtml(comment)}</span>`
            : `<br><em>No comment left.</em>`),
        "Internal notification from the LazyRelay review-feedback form — not a customer notification, and no reply-to address is attached since the submission is anonymous by design."
      ),
    })
    .then((result) => {
      if (result.error) console.error("[email] sendReviewFeedbackNotification failed:", result.error.message);
    })
    .catch((err) => console.error("[email] sendReviewFeedbackNotification threw:", err instanceof Error ? err.message : err));
}

/** Same alert, worded for the account-paused case (retrying won't help —
 *  the customer needs to reconnect the account or upgrade, not wait). */
export function sendAccountPausedAlert(to: string, content: string): void {
  const client = getClient();
  if (!client) return;
  const snippet = content.length > 200 ? `${content.slice(0, 200)}...` : content;
  client.emails
    .send({
      from: `LazyRelay <${FROM_ADDRESS}>`,
      to,
      subject: "A scheduled post was skipped — account paused",
      html: wrapEmailHtml(
        "A post was skipped",
        `This post was skipped because the connected account is paused (usually a plan downgrade or a disconnected account):<br><br>` +
          `<span style="color:#ffffff;">&quot;${escapeHtml(snippet)}&quot;</span><br><br>` +
          `Reconnect the account or check your plan in your dashboard to resume posting.`,
        FAILURE_ALERT_FOOTER
      ),
    })
    .then((result) => {
      if (result.error) console.error("[email] sendAccountPausedAlert failed:", result.error.message);
    })
    .catch((err) => console.error("[email] sendAccountPausedAlert threw:", err instanceof Error ? err.message : err));
}
