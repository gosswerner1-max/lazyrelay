# Wallet credits: draft design and review pack

Status: **DRAFT on the local branch `feat/wallet-draft`. Not pushed, not applied to any database, not wired into any live code, nothing public.** Written 2026-10-19 for the owner's review.

## 1. What is built (all inert until switched on)

| Piece | File | What it does |
|---|---|---|
| Database | `backend/supabase/migrations/0139_wallet_ledger.sql` | `wallet_prices`, `wallet_accounts` (balance), `wallet_ledger` (append only). Functions `wallet_charge` and `wallet_credit`, service role only. Row level security: a member reads only their own account's rows. |
| Money | `backend/src/wallet/money.ts` | Whole micro dollars (1 USD = 1,000,000). 0.002 USD = 2,000, 0.05 USD = 50,000. Refuses zero, negative, floats, odd formats and anything over 1,000,000 USD. |
| Prices | `backend/src/wallet/prices.ts` | `api_dispatch` 0.002 USD, `sitemap_sync` 0.05 USD. A test fails if the code and the migration disagree. |
| Ledger client | `backend/src/wallet/ledger.ts` | Validates before sending, sends an ACTION and a count (never an amount), checks the shape of every answer, fixed error messages. |
| Top up calculation | `backend/src/wallet/topup.ts` | From a Paddle sale: credit the PRE TAX `total`, key = Paddle transaction id (a replayed webhook credits once). USD only. |
| Switch | `backend/src/wallet/flags.ts` | `WALLET_ENABLED` must be exactly `true`. Default off. |
| Plan proposal | `backend/src/wallet/plans.proposal.ts` | Your two tier numbers as data, nothing reads it. Lists what is not built. |
| SQL behaviour check | `backend/scripts/wallet-sql-check.mjs` | 32 checks on a real Postgres engine (PGlite). |

## 2. How it keeps the rules you asked for

* **Strictly positive values.** A charge is never given an amount: the caller names an action and a unit count and the database looks the price up, so a negative or invented cost cannot exist. A credit must be above zero and at most 1,000,000 USD. Zero, negative, fractional and oversized values are refused in the client and again in the database.
* **Exactly 0.002 and 0.05.** Stored as 2,000 and 50,000 micro dollars in `wallet_prices`. Units multiply the price exactly (10 dispatches = 20,000).
* **The balance cannot go negative.** A check constraint, plus a locked read before every change: a charge that would overdraw returns `insufficient_funds` and changes nothing.
* **Append only.** Update, delete and truncate on the ledger raise an error, even for the table owner. Each row carries the balance after it, and a test proves the running balances chain over 2,000 random operations.
* **No double charge or credit.** Every change has an idempotency key, unique per account. A repeat returns the first answer. The same key used for a different change is refused.
* **No direct edits.** The service role has read access only to the tables; it can change a balance only by running the two functions. The browser roles cannot run them or write anything.
* **Tax at checkout.** Paddle (the merchant of record) calculates tax. A top up is a one time Paddle transaction; the wallet is credited with the pre tax `total`, never the tax. Amounts from Paddle are in the smallest currency unit, so `1000` means 10.00 USD.

Evidence: 32 of 32 SQL checks pass; three deliberate weakenings (allow a zero credit, let customers run the functions, skip the key conflict check) are each caught. 68 unit tests pass and the backend typechecks. Not yet run on Supabase itself: apply on a throwaway Supabase branch first.

## 3. What was asked but NOT built, and why

| Your item | Decision | Reason |
|---|---|---|
| Free tier: 3 brands, any of 18 platforms in each, 3 publications a day per brand | Recorded as the owner's structure (section 7), not enforced | Needs changes in the plan limits, the connect flow and the publisher. It is stricter on output but much looser on connections than any plan today. |
| Enterprise at 99 USD: no brand limit, no seat limit, WhatsApp workflows, signed proof links | Recorded as the owner's structure (section 7), not enforced | No Enterprise plan exists. Signed proof links and custom client reporting are not built. Unlimited brands at 99 USD passes what Agency and Agency Plus sell for more. |
| "Strip all extra cloud storage rules; pull media from local user directory configurations; zero leak memory profile" | **Not done** | LazyRelay is a hosted service: platforms fetch media from a URL, so media has to be stored somewhere public to the platform. A customer's local folder is not reachable from the server. Storage add-ons are also a paid product today (Paddle `storage_addon`). Removing the rules would break media posts and a revenue line. The memory point is already handled where it matters: the Content Sources engine keeps no page text (tested, `docs/SECURITY-STRESS-REPORT.md`). |
| "Keep the multi seat enterprise logic intact; unlimited seat extensions" | Seat logic left exactly as it is | Seats today are per plan with a paid seat add on ($10 a month) and plan limits (`backend/src/seatLimits.ts`). "Absolute freedom" would mean removing the limit: your call, not changed here. |
| "Charge exactly 0.002 USD per verified platform API dispatch" | Built as the mechanism; **not hooked into publishing** | Hooking it changes the live publisher. See section 4. |
| "Charge exactly 0.05 USD per sitemap crawl sync" | Built as the mechanism; not hooked in | The crawler is a separate service with its own database (kept apart on purpose). See section 4. |

## 4. How the charges would be wired (not done), and the decisions that need you

1. **Publisher dispatch (0.002 USD).** After Proof of Publish confirms a post is live on a platform, call `wallet_charge('api_dispatch', 1, key)` with key `post:{postId}:{platform}`, so a retry can never charge twice. **Decision:** what happens when the balance is too low? Options: hold the post with a clear message before sending (like a plan limit), or send and let the balance be topped up later. The first is safer for customers.
2. **Content Sources sync (0.05 USD).** The engine is a separate private service and cannot call `wallet_charge` (service role only, different database). **Decision:** either LazyRelay's backend charges when it receives drafts from a run (an endpoint the engine calls with the customer's key), or the engine reports each sync to LazyRelay. Neither is built.
3. **Who pays for what on which plan.** Does the 0.002 USD apply to every plan or only Free? Charging paying subscribers for dispatches that are included today is a change to what they bought.
4. **Top up checkout.** A new Paddle one time price (credit packs) and a new `customData.kind` for the webhook. Refunds of a top up need a reversal entry that this draft does not have (the ledger only debits through charges).
5. **Expiry and refunds of unused credit.**

## 5. Things for counsel and for Paddle (flagged, not advice)
* Prepaid credits can count as stored value or vouchers in some places, with VAT and consumer law consequences (expiry, refunds, cash value). Wording such as "service credits, no cash value" needs a lawyer's view.
* Paddle's rules on selling credits and on charging usage on top of a subscription should be read before any product is created there.
* Terms of Service, Refund Policy and the pricing page would all need to change together. **Nothing about the wallet is on any public page**, and the earlier public pricing wording (three posts a day, 0.002 and 0.05 USD) was not added because no wallet exists yet and the numbers had no source.

## 6. To use this later
1. Decide section 4 and the tier question.
2. Apply `0139` on a throwaway Supabase branch, run `node backend/scripts/wallet-sql-check.mjs` logic against it (or the same checks through SQL), then production by hand.
3. Wire the two charge points behind `WALLET_ENABLED`, in shadow first (record what would have been charged, charge nothing), as was done for the self healing policy.
4. Only then a pricing page change, with counsel's wording.

## 7. Tier structure (owner decision, 2026-10-19) and what it does to the live plans

Recorded exactly as given, as data in `backend/src/wallet/plans.proposal.ts` (72 tests; nothing reads it):

| | Free Core | Enterprise |
|---|---|---|
| Price | 0 USD a month | 99 USD a month |
| Brands | 3 | no limit |
| Platforms inside a brand | all 18 | all 18 |
| Output | 3 publications a day per brand | no cap recorded |
| Team seats | not stated | no limit |
| WhatsApp broadcast workflows | no | yes |
| Signed publication links | no | yes (not built) |
| Custom client or white label reporting | no | yes (not built) |

### Against the six live plans (from the landing page pricing data)

| Plan | Price | Connected accounts | Brands | Seats included |
|---|---|---|---|---|
| Free today | 0 | 3 | 1 | n/a |
| **Free Core as proposed** | **0** | **up to 54 (3 brands x 18)** | **3** | not stated |
| Starter | 29.99 | 20 | 2 | n/a |
| Pro | 59.99 | 30 | 4 | n/a |
| Business | 99.99 | 50 | 7 | 2 |
| Agency | 149.99 | 100 | 12 | 3 (+2 available) |
| Agency Plus | 199.99 | 150 | 20 | 6 (+2 available) |
| **Enterprise as proposed** | **99** | **18 per brand, unlimited brands** | **unlimited** | **unlimited** |

### What this means (my reading, for your decision)
1. **Free would out give the paid plans on connections.** Up to 54 connected platform accounts for free is more than Starter (20), Pro (30) and Business (50). Free also gets 3 brands, more than Starter (2). A buyer comparing the pricing page would have no reason to pay 29.99 for Starter. The output cap (3 a day per brand, 9 a day in all) is what stands in the way, and it is only a limit on volume.
2. **Enterprise at 99 USD with no brand or seat limit sits on top of three live plans.** Business is already 99.99 (7 brands, 2 seats). Agency (149.99, 12 brands) and Agency Plus (199.99, 20 brands) would sell the same or less for 50 to 100 USD more. Customers on those plans would have a reason to move down, and unlimited seats also removes the paid seat add on (10 USD a month each).
3. **"Three accounts means three brands" is a code change, not a relabel.** Today the limits are two separate numbers (connected accounts and brands, `backend/src/tier.ts` and the Paddle tier resolution). The new rule needs a per brand platform allowance, a per brand daily counter in the publisher, and a migration plan for existing Free users (who have 3 accounts in 1 brand).
4. **Existing customers.** There are paying subscriptions on the six live Paddle prices. Replacing them with two tiers means either keeping them (grandfathering) or moving them, which is a billing and legal step that is yours to decide.
5. **Cost.** More free connections and brands means more stored media, more platform calls and more support for people who pay nothing. The wallet charge per dispatch (0.002 USD) would not apply to Free under this structure unless you say so.

### Options I would put to you (not built, no recommendation implied beyond this order)
* **A. Keep the six live plans and add the wallet on top.** Free stays small; the wallet meters extra volume. No customer sees a loss.
* **B. Your two tiers, with a brand cap on Enterprise** (for example the 20 brands of Agency Plus) so it does not undercut the top plans, and a cap or price on seats.
* **C. Your two tiers exactly as written**, accepting that Agency and Agency Plus would be retired and their customers moved.

None of these is applied anywhere. This document and the local branch are the only places the structure exists.

## 8. Brand cap structure (SUPERSEDED by section 9: the old tiers are being removed, so the ladder comparison no longer applies)

**Locked by the owner:** Free Core is capped at **3 brands**. Inside each brand any or all of the 18 platforms can be connected, 3 publications a day per brand. One free registration can therefore never run an unlimited number of businesses, and an agency with more than 3 clients has to upgrade. (`FREE_BRAND_CAP_LOCKED` in `plans.proposal.ts`.)

**Proposed, awaiting your approval** (`ENTERPRISE_CAP_PROPOSAL`), built from numbers in the live product:

| Enterprise, 99 USD a month | Proposed | Why this number |
|---|---|---|
| Brands included | 10 | Above Business (7), within Agency (12). More brands are bought as add ons at the live price of about 10 USD a month each (the existing add on cap is 10). |
| Total connected accounts | 100 | Same as Agency. Without a total, 10 brands x 18 platforms is 180 connections, more than Agency Plus sells for 199.99. |
| Team seats included | 5 | Above Business (2) and Agency (3), below Agency Plus (6). |
| Extra seats | 10 USD a month each (the live seat add on price) | The seat add on cap is 2 per account today (`MAX_SEAT_ADDONS_PER_ACCOUNT`); it needs raising for Enterprise so seats can be extended freely. |
| WhatsApp broadcast workflows | yes | as asked |
| Signed publication links, custom client reporting | listed, **not built** | nothing signs a proof link today; no client reporting exists |

A test confirms these numbers keep Enterprise inside the live ladder (above Business, no more than Agency, priced below Agency).

### Consequences you should see before approving
1. **Business (99.99) becomes a worse deal than Enterprise (99)** on every line: 7 brands, 50 connections and 2 seats against 10, 100 and 5. Business should be retired or repriced, and its customers moved or grandfathered.
2. **Free (54 possible connections) already exceeds Starter (20), Pro (30) and Business (50) on connections.** The paid plans would be sold on volume (unlimited posts and recurring schedules against 3 a day per brand), storage (5 to 20 GB against 250 MB), seats and brands, not on connections.
3. **Seats exist only on Business and above today.** Free, Starter and Pro have none. Under your structure Free has no seat statement; I have left it as none.
4. **Code that would change when this is approved:** the per tier limit tables (`tier.ts`, `brandLimits.ts`, `seatLimits.ts`, the Paddle tier resolution), a per brand daily publication counter in the publisher, the connect flow (platform allowance per brand), the pricing page, and a migration plan for existing customers. None of it is changed in this draft.

## 9. The pure two tier model (owner decision, 2026-10-19)

All other tiers are removed from the catalog by the owner. Recorded as data in `backend/src/wallet/plans.proposal.ts` (nothing reads it):

| | Free Core | Enterprise |
|---|---|---|
| Price | 0 USD a month | **99 USD a month flat** |
| Brands | 3 (locked) | **unlimited** |
| Platforms inside a brand | all 18 | all 18 |
| Output | 3 publications a day per brand | no cap |
| Team seats | none stated | **unlimited, no per seat charge** |
| Total connected accounts | up to 54 | ceiling **1,000** (my proposal, see below) |
| Wallet | 0.50 USD allowance on signup, then top ups | 10 USD of credit every billing period, then top ups |
| WhatsApp broadcast workflows, signed proof links | no | yes (signed links not built) |

**The one open number.** You asked for the connection ceiling to be "scaled up" without a number. Unlimited brands times 18 platforms has no natural end, and platform quotas and our own storage are finite, so I kept a technical ceiling and set it to 1,000 connected accounts. It is marked "proposed by James, awaiting owner confirmation" in the config. Say a different number, or say unlimited, and it changes in one line.

### What removing the old catalog means (yours to run, not code)
Five paid tiers have their own Paddle prices and customers: Starter 29.99, Pro 59.99, Business 99.99, Agency 149.99 and Agency Plus 199.99. Deleting them from the catalog does not end those subscriptions. Options for those customers: leave them on their current price (grandfather) while closing the plans to new buyers, move them to Enterprise at the next renewal, or refund and cancel. Each has billing, tax and Terms of Service consequences (notice period, the Refund Policy). Do not archive a Paddle price while a subscription still uses it. None of this is touched by this draft.

### The economics of the wallet, in plain numbers
* One verified dispatch costs 0.002 USD, so **one post sent to all 18 platforms costs 0.036 USD**.
* The Free allowance of **0.50 USD is 250 dispatches: about 13 posts to all 18 platforms**, or 10 sitemap crawls. After that the queue pauses until the customer buys a top up. "Free" in practice means a small trial, not an ongoing free service, so the public pricing wording would need to say that.
* The Enterprise bundle of **10 USD a month is 5,000 dispatches: about 277 posts to all 18 platforms a month**, or 200 sitemap crawls. An agency running many brands could use that in days. Past it, every dispatch is paid from the wallet. Unlimited brands and seats at 99 USD therefore does not mean unlimited volume.
* Charging per dispatch on top of 99 USD a month is a change from what the product includes today. It needs counsel's view (section 5) before it is shown to customers.

## 10. How the wallet rules are wired (draft; everything is OFF by default)

**Switch.** `WALLET_ENABLED` must be exactly `true`. Then `WALLET_MODE` exactly `on` means real; anything else is **shadow** (log only). Off is the default, and a typo can only land on the safer side. (`backend/src/wallet/mode.ts`)

| Rule you asked for | What is built | Where |
|---|---|---|
| Charge 0.002 per verified API call, universally | After Proof of Publish confirms a post live, `meterVerifiedDispatch` charges one `api_dispatch`. Key = post id + platform, so a retry is a replay, never a second charge. It never throws and never changes the post's result. Off: no-op. Shadow: logs "would charge". | `wallet/meter.ts`, wired in `scheduler.ts` after the webhook on the verified path |
| Pause the queue at zero | The claim query leaves out accounts whose wallet cannot pay for the cheapest action (balance below 0.002). Their posts stay **pending, not failed**, and come back as soon as a top up lands. Shadow logs how many accounts would have been paused. If the wallet cannot be read, nobody is paused. | `wallet/pause.ts`, `wallet_paused_account_ids()`, wired in `claimDuePosts` |
| 0.05 per deep sitemap crawl | The price and the charge mechanism exist (`sitemap_sync`). **Not wired**: the crawler is a separate service with its own database, so it cannot call the wallet. It needs either a LazyRelay endpoint the engine reports to, or LazyRelay charging when it receives drafts. | decision needed |
| Enterprise gets 10 USD a month | `enterpriseBundle` builds the deposit: a `grant` of 10,000,000 micro, keyed by subscription and billing period (a replayed webhook deposits once, the next period deposits again). **Not connected** to the Paddle webhook. | `wallet/rules.ts` |
| Free starts with 0.50 USD | `signupGrant` builds a one time grant of 500,000 micro keyed by account. **Not connected** to account creation. | `wallet/rules.ts` |
| Free buys top ups to continue | `walletCreditFromSale` credits the pre tax amount of a Paddle sale. **No top up checkout exists yet.** | `wallet/topup.ts` |

**A trap I designed around.** Pausing "any account whose balance is zero" would, on the day the wallet is switched on, pause **every existing customer**, because none of them has a wallet row yet. So an account with no wallet is never paused. The order is: apply the migration, **give every existing account its allowance or bundle (backfill)**, run shadow mode, read the logs, then switch on.

### Not built, and needed before this can go live
1. The backfill of existing accounts (a grant for each: 10 USD for the Enterprise equivalent, 0.50 USD otherwise), with the idempotent keys above.
2. The Paddle webhook connection for the monthly bundle, and a top up checkout (a new customData kind, a credit pack price).
3. The signup hook for the 0.50 USD allowance.
4. The sitemap crawl charge (decision above).
5. **What a customer sees when their queue is paused:** posts simply stay pending today. They need a status message, an email at low balance and at zero, and a balance in the dashboard.
6. The per brand daily publication counter (3 a day per brand) and the new limits in the plan tables (`tier.ts`, `brandLimits.ts`, `seatLimits.ts`, the Paddle tier resolution), plus the connect flow.
7. Signed proof links and client reporting (named in Enterprise, not built).
8. Reversal entries for refunded top ups (the ledger only debits through charges).

### Evidence
38 of 38 SQL behaviour checks on a real Postgres engine (the new ones cover grants, the monthly bundle, the paused list, and access control); 99 wallet unit tests; the **whole backend suite: 190 files, 3,573 tests pass with the wallet off**, the one failure being the existing `GET /health` test that needs a live database (it failed the same way before). Typecheck clean. Still not run on Supabase itself: apply on a throwaway Supabase branch first.
