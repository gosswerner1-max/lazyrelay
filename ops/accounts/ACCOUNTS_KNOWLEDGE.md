# LazyRelay Accounts — Operating Knowledge

Living document for the Accounts Operator/Auditor. Read every run before doing anything else. Update whenever a genuinely new account-state scenario is handled that isn't covered here yet — same discipline as `support/SUPPORT_KNOWLEDGE.md`.

## Domain boundary (decided 2026-07-22)

**Accounts owns the customer-account state machine.** **Billing owns pure money events.** The split: Billing detects a payment event (success/failure) and reports it; Accounts is the one that actually reacts by changing account state and what that means product-side (e.g. pausing scheduled posts). Accounts never initiates a charge, refund, or subscription-tier change — that's Billing's job.

## Plain-language state mapping (grounded in the real schema — no invented states)

The real state machine lives in `subscriptions.status`: `trialing` / `active` / `past_due` / `cancelled`. There is no literal "blocked" value anywhere in the schema. Mapping onto the buckets discussed with the user:

| Plain-language bucket | Real DB condition |
|---|---|
| New | `subscriptions.status = 'trialing'`, or no subscription row exists yet at all (`new_no_subscription`) |
| Unpaid / blocked | `subscriptions.status = 'past_due'` |
| Existing | `subscriptions.status = 'active'` |
| Cancelled | `subscriptions.status = 'cancelled'` |

## Downgrade policy (pause, never delete)

Documented policy from `support/SUPPORT_KNOWLEDGE.md`: "accounts beyond the new limit get paused, never auto-deleted. Let the customer choose which stay active." As of migration `0013_social_accounts_paused.sql` (2026-07-23), this is fully enforced, not just planned: `accounts_ops.js::planDowngradePause()` picks which accounts would be paused (oldest-connected-first stays active), `enforceDowngradePause()` actually sets `social_accounts.paused_at` on the rest, and `unpauseAccounts()` reverses it on re-upgrade or reconnection. `backend/src/scheduler.ts`'s `processPost()` checks `paused_at` before every post attempt and fails immediately (no retry, no circuit-breaker impact) if the account is paused — a paused account's tokens and connection stay fully intact, it just can't post until unpaused. **2026-07-28: wired.** `backend/src/billing/sync.ts::syncSubscriptionFromWebhook()` now calls `unpausePausedAccountsUpToLimit()` whenever a webhook brings a subscription to `status: "active"` — it unpauses oldest-paused-first up to the new tier's `ACCOUNT_LIMITS` cap. This is a TS reimplementation living in the backend (not a call into this JS module directly, since backend/ compiles as ESM and ops/ is CommonJS) — keep the pause-side policy here and the unpause-side policy in sync.ts in sync if either one's limit/ordering logic changes.

## Stuck onboarding

Signed up 7+ days ago with zero connected `social_accounts` (excluding disconnected ones) — a real candidate for a nudge. Route any nudge through the existing `support@lazyrelay.com` draft-and-hold email agent (`support/email-agent/imap-tool.js`'s `save-draft`), never a new send path — this keeps the same human-review discipline the email agent already has.

## Review requests (built 2026-07-22)

There's no public reviews/testimonials section on the site yet — real customers don't exist yet, and displaying fake or placeholder reviews would undercut the Proof-of-Publish trust positioning. But *collecting* reviews doesn't need a public section, and doesn't need to wait: `accounts_ops.js::findReviewRequestCandidates()` finds accounts with a real milestone (5+ posts confirmed actually live via `post_results.verified_live`, not just "sent" — the same trust signal the product itself is built on) and surfaces them as candidates for a review-request email. Excludes cancelled accounts. Dedup via a `StateStore` at `ops/accounts/state/review_requests.json` — `markReviewRequested(accountId)` is only called once a draft is actually saved, so a dry-run that just lists candidates never burns the mark, and no account is ever asked twice.

Same draft-and-hold discipline as stuck-onboarding: candidates are never emailed directly by this code — a human (or the scheduled email agent, once approved) drafts the actual ask via `support/email-agent/imap-tool.js`'s `save-draft` into the `hello@lazyrelay.com` Drafts folder, reviews it, and sends manually. The reply (an actual quote/rating) lands back in the inbox — there's no separate storage table for it yet, since with zero reviews collected so far there's nothing to justify building a table before there's real content to put in it. Once a handful of real quotes exist, that's the trigger to (a) decide where to store them and (b) build the public-facing Reviews section — not before.

## Standing rule

If an account is in a state this file doesn't cover, don't improvise a fix — flag it in the run report for the user, same standing rule as the email agent's SUPPORT_KNOWLEDGE.md.
