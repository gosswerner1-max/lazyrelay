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
| "Free tier: up to three posts per day across eighteen networks, free of WhatsApp and white label reporting" | Recorded as a proposal, not enforced | Today Free is **3 connected accounts, 10 scheduled posts per account (refillable), 250 MB**, with Proof of Publish and MCP. A daily cap of 3 is a new and stricter limit for existing Free users. White label agency reporting does not exist in the product. |
| "Enterprise Tier at 99 USD flat with custom client reporting and cryptographically signed proof links" | Recorded as a proposal, not wired | There is no Enterprise plan. The live tiers are Free, Starter ($29.99), Pro ($59.99), Business ($99.99), Agency ($149.99) and Agency Plus ($199.99) with paying customers on Paddle prices. **Custom client reporting is not built.** Proof links exist (`get_proof_link`) but nothing in the code signs them cryptographically. Business is already about 99 USD, with 7 brands and 2 seats included. |
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
