# LazyRelay — Service Providers

Running list of every external service LazyRelay depends on: what it costs, what tier we're on, why we need it, and the trade-offs. Building this one provider at a time.

---

## Render (backend hosting)

**What it's for**: Hosts the Node.js backend — the HTTP API (auth, connect flows, scheduled-posts CRUD, billing webhooks) and the scheduler loop that polls for due posts every 30 seconds and actually publishes them.

**Current tier**: **Starter** (0.5 CPU / 512MB RAM), Oregon region — confirmed live via the Render dashboard 2026-08-05; this doc previously said Free tier, which was stale. No free-tier spin-down risk anymore.

**Cost**: ~$7/month (confirmed via Render billing: $0.56 billed for July, $7.00 projected for August).

**Why we need it**: The backend has to run 24/7 — it's not just serving web requests, it's the thing that actually posts scheduled content on time. Something has to host that process continuously.

**Pros**:
- Free to start — zero cost while LazyRelay has no paying customers yet
- Git-push deploy, no server management
- Easy env var management, HTTPS included

**Cons**:
- Starter still has no uptime SLA (that starts at Standard)
- 512MB RAM could become a bottleneck once real customer volume shows up (more concurrent scheduler work, more API traffic) — Standard ($25/mo) is the next step up if that happens

**Verdict**: Already upgraded off Free — the spin-down risk that would have undermined "Proof-of-Publish, actually posts on time" is resolved. Standard is the next lever if RAM/CPU becomes the bottleneck, not urgent now.

---

## Supabase (database, auth, token vault)

**What it's for**: Three jobs in one — (1) Postgres database holding every real table (`accounts`, `social_accounts`, `scheduled_posts`, `subscriptions`, `storage_addons`, `oauth_states`, etc.), (2) user authentication (signup/login/session management for the Dashboard), and (3) Vault, which encrypts every connected platform's OAuth access/refresh token at rest rather than storing them as plain text.

**Current tier**: **Pro Plan** — confirmed live via the Supabase dashboard 2026-08-05 (org "LazyRelay", billing cycle 29 Jul–29 Aug 2026); this doc previously said Free tier, which was stale.

**Cost**: $25/month base (8GB disk included, currently using 2GB, no overage; 100k monthly active users included; 7-day log retention; no project pausing). Team/Enterprise tiers exist above that but aren't relevant at LazyRelay's scale yet.

**Why we need it**: Building and hosting our own Postgres + auth + secrets-encryption stack from scratch would be significant extra engineering (auth flows, session security, token-at-rest encryption, backups) for something that isn't LazyRelay's actual product. Supabase gives all three as one hosted service with a generous free tier.

**Pros**:
- Free tier is genuinely usable for pre-launch/early-customer volume, not just a toy sandbox
- Built-in Vault means we never had to hand-roll token encryption ourselves — meaningfully lowers the risk of a real security bug in the part of the system that holds customers' actual platform access tokens
- Real Postgres underneath, not a proprietary DB — no lock-in to a weird query language, and easy to reason about
- Auth is fully managed (no separate identity provider needed)

**Cons**:
- Everything (auth, DB, secrets) is one vendor — an outage or incident on Supabase's side takes down the whole backend at once, not just one feature
- Disk auto-scales past the included 8GB at $0.125/GB/month — not a hard cap, but an unbounded cost if usage grows without anyone watching

**Verdict**: Already upgraded to Pro — the free-tier risks (project pausing, 500MB DB cap, short log retention) are resolved. Current usage (2GB of 8GB disk) has plenty of headroom; no near-term action needed.

---

## cPanel shared hosting (frontend + email)

**What it's for**: Two jobs — (1) hosts the static built React frontend (`lazyrelay.com`), and (2) hosts all 4 real email mailboxes (`hello@`, `support@`, `accounts@`, `werner@lazyrelay.com`) via standard IMAP/SMTP.

**Current tier**: Shared hosting account on `s55.registerdomain.net.za` — the same cPanel account already used for The Lazy Download, not a dedicated LazyRelay account.

**Cost**: $0 marginal cost for LazyRelay — this hosting is already paid for as part of The Lazy Download's existing plan, so adding LazyRelay's site + mailboxes onto it cost nothing extra.

**Why we need it**: The frontend is just a static build (HTML/CSS/JS from `vite build`) — it doesn't need a real server, just somewhere to serve files with SSL. Reusing existing paid hosting for that, plus 4 mailboxes, is free.

**Pros**:
- Genuinely $0 — no new vendor bill at all
- Already-known environment (File Manager, SSL, DNS) from running The Lazy Download on it for years
- Real mailboxes on our own domain, not a third-party inbox-as-a-service tool
- **Deploy is fully automated as of 2026-07-28** (corrected 2026-08-05 — this doc previously said manual, which was stale): `.github/workflows/deploy-frontend.yml` builds and FTP-deploys `frontend/dist/` straight to the cPanel document root on every push to `main` that touches `frontend/`. Verified live: 36/36 runs green, most recent same-week. No human upload step anymore.

**Cons**:
- **Shared account with The Lazy Download** — an issue on one product (a spam flag, a resource limit, a billing lapse) can affect the other. No isolation between the two businesses at the infrastructure level.
- No CDN — static assets are served straight from the shared host, not edge-cached, so global load times aren't as fast as a CDN-backed static host (Vercel/Netlify/Cloudflare Pages) would give for free.
- Mailbox spam filtering has to be configured carefully so account-wide settings (like auto-delete spam) don't inadvertently affect The Lazy Download's mailboxes too — already hit this exact issue when designing the email cleanup automation.

**Verdict**: Reasonable while both products are small and cost matters more than polish — it's free and it works, and deploy is already automated (see above). The remaining reason to reconsider moving to Vercel/Netlify/Cloudflare Pages later is the cross-product coupling and lack of a real CDN, not the deploy step, which is already solved.

---

## Domain & SSL (domains.co.za + Let's Encrypt)

**What it's for**: `domains.co.za` is the registrar that owns the `lazyrelay.com` domain name and its DNS/nameserver configuration. Let's Encrypt provides the SSL certificate that makes `https://lazyrelay.com` show a valid padlock instead of a security warning.

**Current tier**: Standard domain registration; Let's Encrypt's free auto-issued certificate (auto-renews via cPanel, no manual renewal needed).

**Cost**: Domain registration is a small annual renewal fee (typical `.com` pricing, roughly R200-300/year depending on domains.co.za's current rate) — this is the one recurring cost in the whole stack that isn't $0. SSL itself is $0 — Let's Encrypt is free.

**Why we need it**: Can't have a real product without owning its domain name, and can't take real signups/payments without valid HTTPS — browsers and platforms (Meta, TikTok, etc.) all require it for OAuth redirect URIs.

**Pros**:
- Free SSL that auto-renews — no recurring cert cost, no manual renewal risk
- Domain cost is small and predictable (once a year, not monthly)
- domains.co.za is a familiar South African registrar already used for other businesses

**Cons**:
- Registrar renewal is a manual date to track — a missed renewal would take the entire site and all 4 mailboxes offline at once
- No real con on the SSL side — Let's Encrypt is genuinely free and solid

**Verdict**: Nothing to change here. Only action item is making sure the annual domain renewal doesn't get missed (auto-renew should be enabled on the registrar side if it isn't already — worth double-checking).

---

## Paddle (billing / Merchant of Record)

**What it's for**: Handles all subscription billing — checkout pages, recurring charges for the Starter/Pro/Business tiers, and critically, Merchant-of-Record status, meaning Paddle (not LazyRelay) is legally responsible for collecting and remitting sales tax/VAT in every customer's country.

**Current tier/status**: Sandbox only right now — `PADDLE_ENVIRONMENT` is not set to production, no real customer has ever been charged. This is deliberately deferred per your own call to leave billing for last.

**Cost**: No monthly fee — Paddle charges a percentage + fixed fee per transaction (roughly 5% + $0.50 per transaction, higher than raw Stripe's ~2.9%+30¢, because Paddle is absorbing the tax-compliance work). Zero cost until a real transaction happens.

**Why we need it**: Handling international sales tax/VAT compliance ourselves (dozens of jurisdictions, changing rules) would be a serious ongoing burden for a small team. Paying Paddle a higher per-transaction cut buys out that entire problem.

**Pros**:
- No tax/VAT compliance work falls on us — Paddle is the seller of record
- No monthly fee — cost only exists when there's real revenue to pay it from
- Handles failed-payment dunning, proration, cancellation flows out of the box

**Cons**:
- Meaningfully more expensive per transaction than a plain payment processor (Stripe direct) — the tax-compliance convenience has a real ongoing cost baked into every sale
- We already switched adapters once (Stripe → Paddle) mid-build, so there's some integration cost already sunk on both sides
- Going live requires real production API keys and `PADDLE_ENVIRONMENT=production`, plus a completed Paddle merchant approval on their side — still outstanding

**Verdict**: Right choice for a solo/small operation selling internationally — the tax-compliance offload is worth the extra transaction cost. Just needs the production cutover to actually start earning revenue, which is intentionally the last box left to check.

---

## Google Analytics 4 (GA4)

**What it's for**: Tracks website traffic and one specific conversion event (`sign_up`) so we can see how many visitors actually create an account.

**Current tier**: Free (GA4's standard tier — Google Analytics 360 is the only paid tier and is enterprise-scale, irrelevant here).

**Cost**: $0.

**Why we need it**: Without it we'd have zero visibility into whether the landing page, SEO content, or any future ad spend is actually converting visitors into signups.

**Pros**:
- Completely free, industry-standard, well-documented
- Already wired into every legal/static page as well as the main app, so tracking is consistent site-wide

**Cons**:
- Privacy/consent implications — this is exactly why the cookie-consent banner exists on the site; GA4 firing without consent handling would be a compliance problem, not just a tracking one
- GA4's own interface/reporting model is notoriously less intuitive than the old Universal Analytics it replaced
- No conversion tracking beyond signup yet (e.g. no revenue/purchase event wired up), so it can't yet answer "which channel drives paying customers," only "which channel drives signups"

**Verdict**: Right free tool for now. Once Paddle goes to production, worth wiring a purchase/revenue event into GA4 too, so marketing spend can eventually be judged against actual revenue, not just signups.

---

## Social platform APIs (Meta, TikTok, Pinterest, YouTube, Bluesky, Mastodon, Telegram, LinkedIn, Threads, Discord, Tumblr, X, Reddit)

**What they're for**: These aren't hosting/infra vendors — they're the actual product. Each platform's developer API is what LazyRelay's adapters call to publish a scheduled post and verify (Proof-of-Publish) that it actually went live.

**Current tier/status per platform (corrected 2026-08-05 — this table previously said "Live and passing" for Facebook/Instagram/TikTok, which conflated "adapter code works in testing" with "approved for real customers"; verified directly in each platform's own dashboard instead of trusting old notes):**
- **Approved for real customers**: Pinterest (Standard access, approved 2026-08-04)
- **Adapter built and passes internal tests, but NOT approved for real customers yet**: Meta/Facebook/Instagram (`pages_manage_posts` — the actual posting permission — shows "Pending App Review"; Instagram's own setup flow confirms app review hasn't been completed), TikTok (production app shows "In review," submitted 2026-08-03). Only Werner's own developer/tester-role accounts can post through these right now.
- **Adapter built, review status not separately re-verified this pass**: YouTube, Bluesky, Mastodon, Telegram, LinkedIn, Threads, Discord, Tumblr — see `SUPPORT_KNOWLEDGE.md`'s Current product state block for whichever of these matters for a live customer question, and re-check directly rather than trusting this line if it's been a while.
- **Adapter built, no platform review gate exists, but zero real usage yet**: X (Twitter) — corrected 2026-08-05, this previously said "adapter not built yet" which was stale. `XAdapter` is fully implemented and registered in the platform registry (`backend/src/index.ts`). X's own developer console shows the app status "active" with a real read/write access token already generated — X's API model has no Meta/TikTok-style manual app review to wait on. "No usage data available" on the account just means nobody has actually posted through it yet, not that anything is blocked.
- **Blocked**: Reddit — pending Reddit's own manual "Responsible Builder Policy" approval (ticket submitted, followed up, no reply yet)

**Cost**: $0 across the board — every platform's developer API is free to register and use at LazyRelay's current call volume. None of these platforms charge for API access at this scale (this could change if any platform introduces paid-tier API access in the future, or if usage grows enough to hit a metered tier — worth periodically re-checking each platform's developer terms).

**Why we need them**: This is the entire reason LazyRelay exists — without real API access to these platforms, there's no product, just a UI that can't actually post anywhere.

**Pros**:
- All currently free — no infrastructure cost tied to platform count
- Real API access (not scraping/browser automation), which is what makes Proof-of-Publish possible at all

**Cons**:
- Each platform has its own approval process, rate limits, and policy risk — an API access revocation or policy change on any single platform (most acutely Meta right now) can take a whole platform offline for customers with zero warning
- Approval timelines are entirely out of our control (Meta verification, Reddit's ticket) — real launch blockers with no cost lever to pull
- Sandbox/trial access tiers (TikTok, Pinterest) may have volume or feature caps not yet stress-tested against real customer usage

**Verdict**: No cost decision to make here — the only lever is time and following each platform's own approval process, which is already underway.

---

## Slack (internal ops alerting)

**What it's for**: Internal-only alerting — the scheduler posts here when a post fails or a platform's circuit breaker trips, and the email/billing automation posts summaries here too. Not customer-facing at all.

**Current tier**: Free tier, dedicated personal workspace, `#all-lazyrelay` channel.

**Cost**: $0 — Slack's free tier has message-history limits but that's irrelevant for a live alerting feed that's read in real time, not searched historically months later.

**Why we need it**: Without it, a failing post or a tripped circuit breaker would only be visible by someone actively checking logs — Slack turns that into a push notification.

**Pros**:
- Free, instant, and something you're already checking regularly
- Keeps operational visibility separate from customer-facing systems entirely

**Cons**:
- Free tier's 90-day message retention means old alert history eventually disappears — fine for "did something break recently," not for long-term audit trail
- Single channel could get noisy if alert volume grows significantly with more customers/platforms — might eventually need alert routing/severity splitting

**Verdict**: No change needed — free tier is genuinely sufficient for this use case.

---

## Roundcube / IMAP-SMTP (customer support)

**What it's for**: Not a separate paid vendor — Roundcube is the webmail UI bundled free with the cPanel hosting above, giving a human-usable inbox view over the same 4 mailboxes the in-house email agent operates over IMAP/SMTP. There's no third-party helpdesk tool (no Zendesk, Intercom, Freshdesk) in the stack at all.

**Current tier**: Whatever ships free with cPanel — no separate account or plan.

**Cost**: $0 marginal cost — bundled with hosting already counted above.

**Why we need it**: Customer support has to go somewhere, and standard email (not a dedicated helpdesk SaaS) is proportional to LazyRelay's current support volume (near-zero while the product is pre-revenue/testing).

**Pros**:
- Zero extra cost — genuinely free on top of hosting already paid for
- No vendor lock-in or per-agent seat pricing that a real helpdesk tool would add
- Same mailboxes are both human-readable (Roundcube) and machine-readable (the IMAP tool), so nothing needs syncing between two systems

**Cons**:
- No ticketing structure — no SLA timers, no canned-response macros, no multi-agent assignment; fine solo, would strain if support volume grows or a second person needs to help
- No built-in customer-facing knowledge base/help center — that content currently lives only in internal memory (`support/SUPPORT_KNOWLEDGE.md`), not anywhere a customer could self-serve

**Verdict**: Right-sized for now. Worth revisiting once real customer volume shows up — a real helpdesk tool (even a free tier of one) would add ticket tracking and canned responses that plain email lacks, but there's no reason to pay for that before there's support volume to justify it.

---

## Claude (Anthropic) — Claude Max plan

**What it's for**: Not part of LazyRelay's runtime infrastructure at all — this is the AI subscription used to actually build LazyRelay: all the coding, debugging, deployment, research, and now this in-house automation (email agent, accounts/billing ops) that runs the business day-to-day.

**Current tier**: Claude Max plan (personal subscription).

**Cost**: Flat monthly subscription fee (not a per-token/API cost) — same cost regardless of how much LazyRelay work happens in a given month versus other projects, since it's shared across everything you use Claude for, not billed per-business.

**Why we need it**: LazyRelay's entire build — the backend, frontend, all 12+ platform adapters, billing integration, the in-house Accounts/Billing/Email automation — was built through this subscription rather than hiring developers or a dev agency. It's effectively substituting for engineering labor cost.

**Pros**:
- Flat cost regardless of usage volume — no surprise bill from a busy building month
- Replaces what would otherwise be a much larger cost (hiring an engineer or agency to build and maintain all of this)
- Also covers all your other work (Lazy Download, other products), so the cost isn't LazyRelay-specific overhead

**Cons**:
- Not a LazyRelay-specific line item — hard to cleanly attribute "how much of this subscription is LazyRelay's cost" versus everything else it's used for
- Unlike every other provider on this list, this one has a human (you) directing it each session rather than running unattended — it doesn't reduce ongoing work the way a SaaS integration does, it changes who's doing the work

**Verdict**: The odd one out on this list — it's the tool building and running everything above, not a runtime dependency of the live product. Worth including for completeness since it's a genuine real cost behind LazyRelay's existence, but it doesn't fit the same "will this need a tier upgrade before launch" framing as the others.

---

## Summary — total recurring cost today

| Provider | Monthly cost today | Cost driver if it changes |
|---|---|---|
| Render | ~$7/mo (Starter, confirmed live) | Standard ($25/mo) if RAM/CPU becomes a bottleneck |
| Supabase | $25/mo (Pro, confirmed live) | Disk overage at $0.125/GB/month past the included 8GB |
| cPanel hosting | $0 (bundled with Lazy Download's existing plan) | Only if that shared plan itself needs upgrading |
| Domain (domains.co.za) | ~R200-300/year (not monthly) | Standard annual renewal |
| Let's Encrypt SSL | $0 | Never — free forever |
| Paddle | $0 (no monthly fee; ~5%+$0.50 per transaction once live) | Scales with revenue, not a fixed cost |
| GA4 | $0 | Never at this scale |
| Social platform APIs | $0 | Watch for any platform introducing paid API tiers |
| Slack | $0 (free tier) | Only if alert volume needs paid features |
| Roundcube/IMAP | $0 (bundled) | Only if support volume justifies a real helpdesk tool |

**Total real recurring cost right now: ~$32/mo (Render Starter + Supabase Pro) plus the annual domain renewal.** Both infra upgrades already happened (confirmed live 2026-08-05 — this table previously said $0/free-tier for both, which was stale) — this is the actual current baseline, not a future "once we upgrade" projection.
