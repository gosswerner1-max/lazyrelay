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

// Same visual language as the existing Supabase auth-email templates
// (dark background, orange LazyRelay logo block) — see the mailer_templates_*
// content in Supabase's Auth config for the original.
function wrapEmailHtml(
  heading: string,
  bodyHtml: string,
  footerHtml: string = "You're getting this because you turned on failure alerts in your LazyRelay dashboard's Account settings. Turn it off there any time.",
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
          `Check your dashboard to retry or fix the connected account.`
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
          `<pre style="white-space:pre-wrap;color:#ffffff;font-family:inherit;font-size:14px;">${escapeHtml(transcript)}</pre>`
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
          `Reconnect the account or check your plan in your dashboard to resume posting.`
      ),
    })
    .then((result) => {
      if (result.error) console.error("[email] sendAccountPausedAlert failed:", result.error.message);
    })
    .catch((err) => console.error("[email] sendAccountPausedAlert threw:", err instanceof Error ? err.message : err));
}
