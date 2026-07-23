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

**Interface behavior**: `parseWebhookEvent` returns `null` for a verified-but-irrelevant event (e.g. `transaction.completed`) — confirmed by reading `Webhooks.fromJson`'s own source: an unrecognized `event_type` falls through to a generic `GenericEvent`, it never throws, so treating non-subscription-lifecycle events as "200 OK, nothing to sync" (rather than an error) is correct, not a guess.

**Real instant activation — how it actually works (no agent involved)**: `backend/src/http/webhook.ts` is mounted at `POST /api/webhooks/mor` in `app.ts`. Paddle's event hits that route directly and `syncSubscriptionFromWebhook()` runs synchronously in the same HTTP request — the `subscriptions` row updates within the request. `lazyrelay-billing-ops-daily` is NOT part of this path — it's a periodic safety net (catching a broken/missed webhook, stale sync, tier drift), not the activation mechanism. Activation must never depend on a scheduled agent — even a tight cron still means a delay window, which is the exact failure mode ("paid but not active for hours") this whole processor decision was made to avoid.

**Still needed before this goes live** (real Paddle account setup, not code):
1. Create the Paddle account (works directly from South Africa, confirmed).
2. Create Pro ($24.99) and Business ($49) Prices in Paddle, set their IDs as `PADDLE_PRICE_ID_PRO`/`PADDLE_PRICE_ID_BUSINESS` in `.env`.
3. Set `MOR_API_KEY` (Paddle API key) and `MOR_WEBHOOK_SECRET` (the notification setting's secret key, Paddle Dashboard → Developer Tools → Notifications, once `/api/webhooks/mor` is registered against the deployed backend URL). Set `PADDLE_ENVIRONMENT=production` when ready to go live (defaults to sandbox).
4. **Built 2026-07-22 (frontend)**: `Landing.tsx` now shows all three real tiers (Free/Pro $24.99/Business $49) in a proper pricing grid, FAQ updated to stop saying "it's all free." Added the missing `GET /api/subscription` backend route (nothing previously let the frontend read current tier/status) and wired `Dashboard.tsx`'s Settings tab to show the current plan and either real Upgrade buttons (calling `POST /subscription/checkout` and redirecting to the Paddle-hosted checkout URL) or a Cancel button, depending on tier/status. Verified: backend + frontend both typecheck clean; Landing page pricing section visually verified in-browser (3-column desktop grid, mobile stacking, featured-card styling) via the dev server. The Dashboard billing flow itself (login → Settings → real Paddle checkout redirect) was NOT clicked through live — that needs a real account and would trigger an actual sandbox checkout, left for manual review. Committed, pushed, and manually deployed to the live site 2026-07-22 (frontend has no auto-deploy — `npm run build` + zip + cPanel File Manager upload/extract into `/home/lazydown/lazyrelay.com`, confirmed live at lazyrelay.com/#pricing showing the real 3-tier grid).

## Tier naming (fixed 2026-07-22)

Database `subscriptions.tier` was `solo`/`pro`/`agency`, mismatched with the locked pricing decision (`memory/lazyrelay/project-launch-pricing-tiers.md`: Free/Pro $24.99/Business $49). Fixed via `backend/supabase/migrations/0006_tier_naming.sql` to `free`/`pro`/`business` — the database now matches the real decision, no permanent name-mapping layer needed.

## Dunning cadence

Same reasoning as The Lazy Download's vendor-issue follow-up policy: standard issues get 1-2 days before follow-up; money-impacting issues (a `past_due` subscription is inherently money-impacting) get a tighter 24-hour window. `billing_ops.js::findPastDueNeedingFollowup()` implements this.

## Refund policy

**Authored and live** at https://lazyrelay.com/refunds (published 2026-07-23, linked from the site footer per Paddle's requirement). Summary: no refunds for partial billing periods or change-of-mind — a cancelled plan/add-on simply stops renewing, access continues until the paid-for period ends. Suspected billing errors (duplicate charge, wrong amount) are reviewed individually, not auto-refunded.

`billing_ops.js::planRefund(supabase, refundRequest)` classifies an incoming request against this policy — `deny_per_policy` for the common partial-period/change-of-mind case, `escalate_for_manual_review` when the reason text suggests a billing error. It never issues an actual refund: moving real money stays a manual action in the Paddle dashboard, not something ops code executes unattended. Both outcomes return a `customerMessage` meant to be routed through the existing `support@`/`accounts@` draft-and-hold email agent, same as every other customer-facing message in this project.

## Standing rule

If a billing state doesn't match anything documented here, don't improvise — flag it for the user.
