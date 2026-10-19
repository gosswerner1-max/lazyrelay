# Self-healing for the scheduler

What it is, in plain words: when publishing a post fails, LazyRelay used to retry three times (2, 4 and 8 minutes later) and then give up. The self-healing policy replaces that with clearer rules, one rule per kind of failure, plus a safety rule that a post is never sent more than 2 hours after its time. It ships switched OFF. You can watch it in SHADOW mode for a week before it is allowed to act.

## The policy

| Kind of failure | What happens |
| --- | --- |
| Temporary (network, DNS, timeout, a 5xx, anything the error map calls retryable) | 4 retries, 2, 5, 15 and 30 minutes later (about 52 minutes in all). Each wait is multiplied by a random factor between 0.8 and 1.2 so retries do not all land together. The 5th failure is final: reason `retries_exhausted`. |
| Rate limited (the platform said how long to wait) | The platform's wait is honoured exactly (at most 20 minutes, WhatsApp 25 hours). It counts toward the same 4 retries. |
| Login refused (401 or 403, token revoked or expired, missing permission) | No blind retries. If the platform has a token refresh, one refresh is tried and the post goes again once. If there is no refresh, or it fails, the post fails with its plain reason, the connection is marked "needs reconnect" and the owner gets the existing reconnect email once. From then on posts of that connection are left alone (they stay pending) until it is reconnected. |
| Permanent (blocked link, wrong size or format, policy) | Fails at once with the plain reason, as before. |
| Platform may already have the post (publish worked, confirming it did not) | Never published again. It is only re-checked, on the same schedule as a temporary failure. |
| Too late | A post is never published more than 2 hours after its scheduled time. If a post is more than 2 hours late when it is picked up, or a retry would run past that mark, it fails with: "This post was not sent because it was more than 2 hours past its time. Reschedule it if you still want it out." WhatsApp keeps its own 25 hour limit and is not affected. A post the platform already accepted is never failed this way. |

A failed post is never deleted. It shows in the customer's Failed tab, and the existing "Save and schedule" action there makes a fresh copy to send again. Nothing new was built for that.

Circuit breakers (the existing ones: 5 failures in a row for a platform, 3 for a customer's own keys) now have a half-open probe. When the cooldown ends, exactly one attempt is let through. If it works the breaker closes and the cooldown resets. If it fails the breaker opens again with the cooldown doubled, up to 60 minutes.

WhatsApp broadcasts (there is no other channel, and none is added):

* A problem with one recipient (a number not on WhatsApp, a person who opted out, any code the error map already calls permanent) fails that recipient for good. They are never retried and never contacted another way.
* A temporary problem is retried with the existing delays.
* A code nobody has classified is tried 3 times in all, then it fails as `unknown_error`.
* A problem with the connection (bad token, permission, quality or messaging limit) pauses the sending, as before. In addition, when 5 sends in a row fail, or at least 20 percent of the last 50 sends fail (with at least 10 sends), the owner gets one plain email with the counts. At most one such email per connection every 6 hours. Nobody on the recipient list is ever told about a failure.

System audit rows: when a connection goes from working to refused, one `rejected` row is added to the credential audit trail, and one `recovered` row when it works again. Only real transitions, only for refusals (never for network, timeout or 5xx errors), at most one per connection and kind every 24 hours, no secret or message text.

## The switch: SELF_HEALING_MODE

Set on the backend service. Exactly one of these words, in lower case. Anything else, or nothing, means `off`.

| Value | What the scheduler does |
| --- | --- |
| `off` (default) | Exactly as before this change. No new queries, no new rows. |
| `shadow` | The old logic still decides everything and changes everything. In addition, each decision is also given to the new policy and one row is written to `self_healing_shadow_events` (post id, connection id, platform, error class, old action and delay, new action and delay, whether they differ). No post content, tokens or error text. The write is fire and forget: if it fails it is logged with the tag `[self-healing-shadow]` and nothing else happens. Audit rows are written. The owner emails and the half-open breaker are only recorded, never done. |
| `on` | The new policy decides and acts, as in the table above. |

To change it: set the variable on the backend service and restart it. Going back to `off` is the same, and is always safe.

Old rows are cleaned up by the existing 6 hourly job while the mode is `shadow` or `on`: shadow rows after 30 days, audit rows after 13 months.

## Reading the shadow week

Run, on a machine that has the ops credentials:

    node ops/self-healing/shadow-report.js            last 7 days
    node ops/self-healing/shadow-report.js --days 3
    node ops/self-healing/shadow-report.js --json

It only reads. It prints how many decisions were recorded, by platform, by error class, by what the old logic did and what the new policy would have done, how often they differ (and for which pairs), the share that would have been failed as too late (split into "at claim time" and "at retry time"), and how many owner alerts would have gone out.

How to read it:

* Rows where old and new agree are the policy doing the same thing as today.
* Differences that are meant: a temporary failure's 2nd, 3rd or 4th retry (5, 15, 30 minutes instead of 4 or 8), a 4th retry where the old logic gave up, a login failure on a platform that can refresh a token, a post failed as too_late, the half-open probe (`deny_probe` and `reopen` rows from the breaker), an unknown WhatsApp code retried, and a would-be owner alert.
* Any other difference, for example a permanent error that the new policy would retry, is a defect. Do not switch on.

## When shadow may be promoted to on

All of these, after at least 7 days of real traffic:

1. Every difference in the report is one of the meant ones above.
2. "Unexpected" too_late at claim time is 0 (a post that was not 2 hours late must never be called too late). The retry time too_late rows are checked by eye: each is a post whose retry would have run past the 2 hour mark.
3. No shadow insert failures: the backend log has no line with `[self-healing-shadow] insert failed`.
4. No `[credential-audit] system transition failed` or `[whatsapp-fault-alert]` log lines, and the audit trail has `rejected` rows only for logins that really were refused.
5. The would-be owner alert count is believable (a handful, not hundreds).
6. The migrations below were applied and checked on a throwaway Supabase branch first.

## What has to be set and applied to start the shadow week

Environment variable (backend service): `SELF_HEALING_MODE=shadow`.

Migrations, applied by hand in this order (none is applied by this change): 0136 (the shadow table), 0137 (audit actions and the single statement dedupe function), 0138 (the WhatsApp alert time column). 0134 must already be applied.

Without 0136 the shadow rows simply fail to write and are logged. Without 0137 the audit calls fail and are logged. Without 0138 the WhatsApp digest is skipped (it only sends in `on`). None of these can affect publishing.
