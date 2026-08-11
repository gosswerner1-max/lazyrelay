# LazyRelay Billing — Operating Knowledge

Living document for the Billing Operator/Auditor. Read every run before doing anything else.

## Domain boundary

**Billing owns pure money events only**: subscription tier, payment status, dunning, refunds. It never changes account state directly (pausing posts, connected-account limits) — it reports payment events and `accounts_ops.js` reacts. See `ops/accounts/ACCOUNTS_KNOWLEDGE.md` for the full split rationale.

## Payment processor decision (2026-07-22, revised same day — final: Paddle)

**First choice, Stripe Managed Payments, turned out not to work**: Stripe doesn't support South Africa as an account home country at all — it's only reachable via Paystack (a separate Stripe-owned product for African markets) or by incorporating a foreign entity (e.g. Stripe Atlas, a US company). Given the user is South Africa-based and doesn't want that overhead, Stripe was ruled out and the already-built `StripeMorAdapter` was removed.

**PayPal was also considered and ruled out**: works directly from South Africa and has a real Subscriptions API, but (a) it's a plain payment processor, not a Merchant of Record — same tax-compliance burden Paddle/Stripe both solve — and (b) it has a documented, still-current fund-hold/account-freeze reputation (21-180 day holds, an active related lawsuit) plus a confirmed Nov-2025 IPN outage that silently failed to deliver recurring-payment webhooks — exactly the "paid but not activated" failure mode this whole decision exists to avoid.

**Final decision: Paddle.** Works directly from South Africa (no foreign entity needed, unlike Stripe), is a true MoR (unlike PayPal), and — while it does have its own documented risk-review account-hold complaints (the reason it wasn't the first choice) — has no comparable recent outage or fund-hold pattern on record beyond that. Buyer-side checkout: cards (credit/debit, Visa/Mastercard/Amex/etc.), PayPal, Apple Pay, Google Pay. No South African local EFT/instant-bank-transfer option exists on any of the three platforms evaluated — a South African customer without an international card or PayPal balance can't pay through any of them; this is a real limitation, flagged rather than hidden, but LazyRelay's audience is global SaaS users, not South-Africa-only, so it matters less here than it would for a local-only product.

**Built 2026-07-22** (`backend/src/billing/paddle.ts`): `PaddleMorAdapter` implementing `MerchantOfRecordAdapter` — real webhook signature verification (`paddle.webhooks.unmarshal`), real status mapping (Paddle's `trialing/active/past_due/paused/canceled` → our `trialing/active/past_due/cancelled` — `paused` is treated as a payment-lapse state, not full cancellation), real cancellation (`paddle.subscriptions.cancel`). Verified via `backend/src/test-paddle-adapter.ts` (7/7 pass) — since Paddle's SDK has no built-in test-signing helper (unlike Stripe's `generateTestHeaderString`), the test replicates Paddle's own signing scheme directly (confirmed by reading `WebhooksValidator`'s source: HMAC-SHA256 over `${ts}:${rawBody}`, header format `ts=<epoch>;h1=<hex>`, 5-second validity window) — this tests signature verification and mapping logic for real without needing a live Paddle account. `backend/src/index.ts` picks `PaddleMorAdapter` automatically the moment `MOR_API_KEY`/`MOR_WEBHOOK_SECRET` exist in `.env`, falling back to `StubMorAdapter` otherwise — confirmed via a real boot test (logs `Billing adapter: StubMorAdapter` today). `PADDLE_ENVIRONMENT=production` switches out of sandbox mode; defaults to sandbox otherwise as a deliberate safety default.

**Two real SDK surprises found by reading the installed `@paddle/paddle-node-sdk`'s own `.d.ts`/source files directly, not just docs** (this is why "verify against the actual SDK" matters more than reading blog posts):
1. **`webhooks.unmarshal()` is ASYNC** (`Promise<EventEntity>`), unlike Stripe's synchronous `constructEvent`. This forced a real interface change: `MerchantOfRecordAdapter.parseWebhookEvent()` went from `SubscriptionEvent | null` to `Promise<SubscriptionEvent | null>` — `webhook.ts` now awaits it, `stub.ts` and `test-cancel.ts`'s mocks were updated to match (marked `async`).
2. **`transactions.create()` requires a `customerId`, not an inline email** — there's no "create transaction for arbitrary email" shortcut in Paddle Billing. `buildCheckoutTransaction()` does a real get-or-create Customer lookup (`customers.list({email: [...]}).next()`, falling back to `customers.create()`) before creating the transaction — this is a required step, not a workaround.

**Design note — why `parseWebhookEvent` still avoids a second network call**: resolving the account from a bare webhook payload would otherwise need an extra API call. Avoided the same way as the removed Stripe adapter: `accountEmail` + `tier` are embedded in the transaction's `customData` at checkout-creation time and echoed back by Paddle on every subsequent subscription webhook, so parsing only ever needs the one (already-required) signature-verification call, never a second lookup.

**Interface behavior**: `parseWebhookEvent` returns `null` for a verified-but-genuinely-irrelevant event (e.g. `customer.created`) — confirmed by reading `Webhooks.fromJson`'s own source: an unrecognized `event_type` falls through to a generic `GenericEvent`, it never throws, so treating those as "200 OK, nothing to sync" (rather than an error) is correct, not a guess. As of 2026-07-23, `transaction.completed` and `adjustment.created` are no longer treated as irrelevant — see "SARS bookkeeping records" below.

**Real instant activation — how it actually works (no agent involved)**: `backend/src/http/webhook.ts` is mounted at `POST /api/webhooks/mor` in `app.ts`. Paddle's event hits that route directly and `syncSubscriptionFromWebhook()` runs synchronously in the same HTTP request — the `subscriptions` row updates within the request. `lazyrelay-billing-ops-daily` is NOT part of this path — it's a periodic safety net (catching a broken/missed webhook, stale sync, tier drift), not the activation mechanism. Activation must never depend on a scheduled agent — even a tight cron still means a delay window, which is the exact failure mode ("paid but not active for hours") this whole processor decision was made to avoid.

## LIVE IN PRODUCTION as of 2026-08-11 — verified deployed (previous sandbox drift resolved)

**Billing went live on 2026-08-11.** The 2026-08-11 scheduled run found `getMorStatus()` returning `{live: true, environment: "production", source: "deployed", localDisagreesWithDeployed: false}` — the first production result after five consecutive days of sandbox. Verified directly against Render's deployed env vars, not the local `.env`:

| Where | `PADDLE_ENVIRONMENT` | `MOR_API_KEY` | Verdict |
|---|---|---|---|
| **Deployed Render service** | `production` | `pdl_live_...` | **LIVE** |
| Local `backend/.env` | `production` | `pdl_live_...` | agrees (no drift) |

All six production Price IDs (`STARTER`/`PRO`/`BUSINESS` + the three storage add-ons) and a production `pdl_ntfset_` `MOR_WEBHOOK_SECRET` are set on the deployed service. `localDisagreesWithDeployed: false` — the 2026-08-06 drift (local live / deployed sandbox) is resolved.

**The $0 live-checkout gate passed — and it immediately earned its keep by exposing a real bug.** `Active Priorities.md`'s locked decision was that only a real $0 checkout proves checkouts work, regardless of what Paddle's email said. That was correct: the first live purchase (invoice `43431-10001`, 07:31) was **silently rejected by a webhook signature bug that had been present since the adapter was built** — every live Paddle webhook had been failing verification, and the subscription had to be manually recovered. The self-signed `test-paddle-adapter.ts` tests (10/10 pass) never caught it, because they signed payloads the same wrong way the verifier read them. Root-caused and fixed the same day; the second purchase (invoice `43431-10002`, 08:35, the +5GB storage add-on) then landed **automatically** with no manual recovery — that second one is the real proof the pipeline is healthy rather than patched around. Both sales are `total: 0` (100% discount, as designed for the test).

**Lesson worth keeping: a passing self-signed test suite is not evidence the live path works.** Only the real $0 purchase against production credentials found this. Treat "verified via self-signed payloads" as necessary but never sufficient for anything money-related.

**Cancellation semantics changed the same day (migration `0043_cancel_at_period_end.sql`).** Cancelling used to flip `subscriptions.status` to `cancelled` instantly *and* call Paddle with `effectiveFrom: "immediately"` — so a customer lost paid access on the spot despite the confirmation modal promising access until period end (`resolveTier()` treats anything but active/trialing as Free). Now Paddle cancels with `effectiveFrom: "next_billing_period"` and a new `cancel_at_period_end` flag on `subscriptions`/`storage_addons` marks the pending cancellation while `status` **stays active** until the genuine `subscription.canceled` webhook lands at the real period end. Cascade confirmed: cancelling a plan also cancels its storage add-on.

**Consequence for this task's auditing and dunning:** `status` alone no longer tells you whether a customer is leaving — a row can be `active` with `cancel_at_period_end: true`. Never treat such a row as a churn/dunning candidate, and never quote it as a plain active subscription either. Werner's own `werner@lazyrelay.com` row reads `status: cancelled` (08:46) because it was cancelled *before* this fix deployed — a pre-fix artifact, not the behavior a future cancellation will produce.

**Consequence for every scheduled run from here: the production gate is now OPEN and sends are real.** Verify `environment === "production"` AND `source === "deployed"` on every run before sending — a `local-fallback` source is unverified and must not be treated as a green light.

**No real paying customers exist yet as of 2026-08-11.** All three `subscriptions` rows are internal test accounts (`paddle-upgrade-test-…@lazyrelay.invalid`, `shop@lazydownloader.co.za`, `werner@lazyrelay.com`) and are correctly filtered by `isInternalTestAccount()`. The first genuine customer row will be the first one that is *not* on that list — treat that as the real milestone.

**Live prices are NOT the Pro $24.99 / Business $49 pair recorded below.** Verified live 2026-08-11: **Free $0 / Starter $29.99 / Pro $59.99 / Business $99.99** per month (recorded in `support/EMAIL_REPLY_TEMPLATES.md` template 3, kept in sync with `frontend/src/pages/Landing.tsx`'s `PRICING` array — the one place a human reviews these numbers).

**Internal tier codes are deliberately offset from display names — do not "fix" this.** Verified 2026-08-11 in `backend/src/tier.ts`'s `TIER_DISPLAY_NAMES` and `routes.ts:2490`'s checkout mapping:

| DB `subscriptions.tier` | Display name | Price | Checkout price ID env var |
|---|---|---|---|
| `free` | Free | $0 | — |
| `pro` | **Starter** | $29.99 | `PADDLE_PRICE_ID_STARTER` |
| `business` | **Pro** | $59.99 | `PADDLE_PRICE_ID_PRO` |
| `enterprise` | **Business** | $99.99 | `PADDLE_PRICE_ID_BUSINESS` |

The codes were kept stable across a display-name rename rather than migrating live rows. **This resolves the `PADDLE_PRICE_ID_STARTER` open question flagged under "Tier naming" below: the price ID is real and actively sold, and it correctly needs no `starter` DB value — a Starter purchase records as `pro`.** The four DB values cover all four sold tiers with nothing missing. The trap to avoid: reading a `tier` value and quoting its name or price to a customer without passing it through `TIER_DISPLAY_NAMES` first — a row reading `business` is a **Pro** customer paying $59.99, not a Business customer paying $99.99.

**Still needed before this goes live** (real Paddle account setup, not code — ALL COMPLETED, retained for the record):
1. Create the Paddle account (works directly from South Africa, confirmed).
2. Create Pro ($24.99) and Business ($49) Prices in Paddle, set their IDs as `PADDLE_PRICE_ID_PRO`/`PADDLE_PRICE_ID_BUSINESS` in `.env`.
3. Set `MOR_API_KEY` (Paddle API key) and `MOR_WEBHOOK_SECRET` (the notification setting's secret key, Paddle Dashboard → Developer Tools → Notifications, once `/api/webhooks/mor` is registered against the deployed backend URL). Set `PADDLE_ENVIRONMENT=production` when ready to go live (defaults to sandbox).
4. **Built 2026-07-22 (frontend)**: `Landing.tsx` now shows all three real tiers (Free/Pro $24.99/Business $49) in a proper pricing grid, FAQ updated to stop saying "it's all free." Added the missing `GET /api/subscription` backend route (nothing previously let the frontend read current tier/status) and wired `Dashboard.tsx`'s Settings tab to show the current plan and either real Upgrade buttons (calling `POST /subscription/checkout` and redirecting to the Paddle-hosted checkout URL) or a Cancel button, depending on tier/status. Verified: backend + frontend both typecheck clean; Landing page pricing section visually verified in-browser (3-column desktop grid, mobile stacking, featured-card styling) via the dev server. The Dashboard billing flow itself (login → Settings → real Paddle checkout redirect) was NOT clicked through live — that needs a real account and would trigger an actual sandbox checkout, left for manual review. Committed, pushed, and manually deployed to the live site 2026-07-22 (frontend has no auto-deploy — `npm run build` + zip + cPanel File Manager upload/extract into `/home/lazydown/lazyrelay.com`, confirmed live at lazyrelay.com/#pricing showing the real 3-tier grid).

## Tier naming (fixed 2026-07-22)

Database `subscriptions.tier` was `solo`/`pro`/`agency`, mismatched with the locked pricing decision (`memory/lazyrelay/project-launch-pricing-tiers.md`: Free/Pro $24.99/Business $49). Fixed via `backend/supabase/migrations/0006_tier_naming.sql` to `free`/`pro`/`business` — the database now matches the real decision, no permanent name-mapping layer needed.

**Superseded — the live tier set is four, not three (recorded 2026-08-05).** `backend/supabase/migrations/0011_add_enterprise_tier.sql` additively widened the constraint to `free`/`pro`/`business`/`enterprise` (its own comment: the top tier is shown as "Business" but coded internally as `enterprise`). `ops/oversight/billing_auditor.js`'s `VALID_TIERS` already matches the database, so a live `enterprise` row is correct and is *not* drift — the 2026-08-05 audit found one and correctly passed it. Two follow-ups for Werner, flagged not fixed:
1. ~~`billing_auditor.js:17`'s flag message still reads "not in the corrected free/pro/business set" while the array it guards allows `enterprise`.~~ **RESOLVED — verified fixed 2026-08-11.** Line 17 now interpolates `VALID_TIERS` directly (`not in the valid set (${VALID_TIERS.join("/")})`), so the message can no longer drift from the array it guards.
2. ~~`.env` carries a `PADDLE_PRICE_ID_STARTER` with no corresponding `starter` tier in the database constraint or `VALID_TIERS`.~~ **RESOLVED 2026-08-11 — not a defect.** Internal tier codes are offset from display names by design (`pro` = Starter, `business` = Pro, `enterprise` = Business); a Starter purchase correctly records as `pro`. See the tier mapping table in the live-in-production section above. Nothing to fix here.

## Dunning cadence

Same reasoning as The Lazy Download's vendor-issue follow-up policy: standard issues get 1-2 days before follow-up; money-impacting issues (a `past_due` subscription is inherently money-impacting) get a tighter 24-hour window. `billing_ops.js::findPastDueNeedingFollowup()` implements this.

## Refund policy

**Authored and live** at https://lazyrelay.com/refunds (published 2026-07-23, linked from the site footer per Paddle's requirement). Summary: no refunds for partial billing periods or change-of-mind — a cancelled plan/add-on simply stops renewing, access continues until the paid-for period ends. Suspected billing errors (duplicate charge, wrong amount) are reviewed individually, not auto-refunded.

`billing_ops.js::planRefund(supabase, refundRequest)` classifies an incoming request against this policy — `deny_per_policy` for the common partial-period/change-of-mind case, `escalate_for_manual_review` when the reason text suggests a billing error. It never issues an actual refund: moving real money stays a manual action in the Paddle dashboard, not something ops code executes unattended. **Corrected 2026-08-11 — the line below was stale**: both outcomes return a `customerMessage` that `lazyrelay-billing-ops-daily` (step 7) sends **directly** via `send-mail`, once `environment === "production"` — draft-and-hold was retired for every customer-facing LazyRelay mailbox on 2026-08-03 (see `03 - LazyRelay/Support/feedback-email-agent-draft-and-hold.md` in the vault), so this no longer routes through a review queue.

## SARS bookkeeping records (built 2026-07-23)

The user's requirement: since LazyRelay operates under a registered, VAT-registered South African company (IPE Projects (Pty) Ltd), IPE Projects needs its own paperwork for every product sold and refunded, for SARS purposes. Confirmed with the user before building: Paddle is the merchant of record and already issues its own tax invoices directly to end customers — this is NOT a duplicate customer-facing invoice. It's an internal-only bookkeeping trail covering two things the user explicitly asked for: (1) a record of what Paddle actually pays out to IPE Projects (the real "payment record"), and (2) a record tied to each individual sale/refund. Confirmed **never emailed to customers** — internal records only.

**Schema**: `billing_records` (migration 0014) — one row per sale or refund, with both the customer-facing amounts (`subtotal`/`tax`/`total`/`grand_total`) and the actual payout amounts Paddle settles to IPE Projects (`payout_subtotal`/`payout_tax`/`payout_fee`/`payout_earnings`) attached to that same row — the fee and net-earnings figures are the concrete numbers SARS/an accountant would need per transaction. RLS enabled with no policies — service-role-only, no customer ever reads this table directly.

**How it's populated**: `backend/src/billing/paddle.ts` now treats `transaction.completed` (a sale) and `adjustment.created` (a refund/credit) as relevant webhook events, alongside the existing subscription-lifecycle ones — confirmed against the installed `@paddle/paddle-node-sdk`'s own `.d.ts` files for the exact event names and payload shapes (`TransactionNotification`/`AdjustmentNotification`), not guessed. A sale resolves its account the same way subscriptions already do (`customData.accountEmail`, echoed back on the transaction since it was embedded at checkout). A refund's Paddle payload has no email of its own — `sync.ts::recordRefund()` resolves the account by looking up the original sale record already stored for that `transactionId`, and throws (rather than guessing) if that sale record isn't found, since Paddle retries failed webhook deliveries and an orphaned tax record is worse than a retry. `webhook.ts` dispatches to `recordBillingEvent()` for these two event kinds instead of `syncSubscriptionFromWebhook()`.

Verified via `backend/src/test-paddle-adapter.ts` (10/10 pass, including the two new event kinds) — no live Paddle account needed, same self-signed-payload technique used for the subscription-lifecycle tests.

## Storage margin monitoring (added 2026-08-05)

Werner's concern: LazyRelay sells storage add-ons (+5GB/$2.99, +20GB/$7.99, +50GB/$14.99 — `project-storage-addons-2026-07-23`), but a customer's paid storage physically lives in the same Supabase storage pool that drives LazyRelay's own Supabase bill (100GB included on Pro, $0.021/GB overage past that). So "we sell storage" and "we pay for storage" aren't actually separate pools — the real question is whether what's charged still covers what's paid to Supabase.

`billing_ops.js::checkStorageMargin(supabase)` answers this with real numbers, not the raw GB figure: sums active/trialing `storage_addons` revenue, compares against `storageUsage.js::gatherStorageUsage()`'s real overage cost. At current usage (2GB of 100GB) cost is $0, so margin is trivially fine — the check only becomes meaningful once real overage cost exists. Thresholds: `critical` if cost actually exceeds revenue (losing money), `warn` if revenue is under 2x cost (thinning margin, worth a pricing look), `ok` otherwise. This is a **pricing decision trigger for Werner, never an automated price change or a "storage full" block** — nothing in the storage pipeline itself ever breaks or throttles a customer regardless of margin (see Health & Safety's storage_overage note — Supabase auto-scales, never hard-blocks). Wired into `lazyrelay-daily-ops-digest` (Part 2 step 6).

## Auditor now distinguishes pending cancellations (fixed 2026-08-11)

`billing_auditor.js` now also selects `cancel_at_period_end` and threads it through `evaluateSubscriptionSnapshot()`. The `status active + period expired` shape still flags either way (a stuck `subscription.canceled` webhook is real and worth catching) — but the reason text now says explicitly which case it looks like: `cancel_at_period_end: true` reads as "looks like a pending cancellation whose webhook hasn't landed yet, not necessarily broken," `false` keeps the original "may be stale (missed/delayed webhook sync)" wording. New self-test fixture `pending_cancellation_webhook_not_landed.json` covers it; 5/5 self-test cases pass, including the two pre-existing ones unchanged (they have no `cancelAtPeriodEnd` field, which falls through to the original behavior).

## Standing rule

If a billing state doesn't match anything documented here, don't improvise — flag it for the user.
