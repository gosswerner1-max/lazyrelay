# LazyRelay Health & Safety — knowledge file

Independent monitoring of the live system, separate from the scheduler's own
in-process circuit breaker (which only alerts on platform-API failures the
backend itself hits). This domain checks things from the OUTSIDE — same
vantage point a real customer or an uptime monitor would have — so it can
catch problems the backend itself might not notice (e.g. it being asleep on
Render's free tier, or the frontend being unreachable while the API is fine).

## What it checks and why

1. **Backend health + latency** (`GET {RENDER_BACKEND_URL}/health`) — the
   real signal for "is Render currently strained or asleep." A cold-start
   spin-up on the free tier shows up here as a slow or timed-out response.
2. **Frontend reachability** (`GET https://lazyrelay.com`) — catches cPanel
   hosting issues, DNS problems, or a bad deploy independent of backend health.
3. **SSL certificate expiry** — a lapsed cert takes the whole site down for
   every visitor at once; days-remaining is checked directly via a TLS
   handshake, not assumed from "it auto-renews."
4. **Scheduler lag** (real Supabase read: `scheduled_posts` rows still
   `pending` well past their `scheduled_for` time) — the most direct proxy
   for "the scheduler is falling behind," which is the core Proof-of-Publish
   promise breaking. Does NOT read the in-process circuit breaker state
   (that lives only inside the running backend, not the DB) — this is a
   genuinely different, externally-observable signal.
5. **Media storage overage** (reuses the same real query as the weekly
   report) — reported for visibility, but **excluded from `overall`
   severity** (changed 2026-08-05): Supabase meters/auto-scales storage past
   the included amount rather than hard-blocking (confirmed live on the
   Supabase usage page — "Disk automatically scales up when you get close to
   its size"), so raw GB overage is never an operational emergency. The real
   signal — whether storage add-on revenue still covers the real Supabase
   cost — is `billing_ops.js::checkStorageMargin()`, a pricing question, not
   a health question.
6. **Database disk size** (`ops_db_size_bytes()` RPC, migration 0031, added
   2026-08-05) — direct read of the real Postgres disk size against
   Supabase Pro's 8GB included allowance. Added after finding the original 5
   checks were all *proxies* for capacity strain (latency, lag) rather than
   a direct read of the actual documented cap.
7. **Monthly Active Users** (`ops_monthly_active_users()` RPC, same
   migration) — direct-ish read against Supabase Pro's 100k included MAU.
   This is a conservative proxy (distinct sign-ins in the current calendar
   month via `auth.users.last_sign_in_at`), not Supabase's exact billing
   definition (real MAU also counts token refreshes) — it can only
   under-count the real figure, never over-count, so it's safe to alert on
   without risking a false "all clear."

## Thresholds (the actual "limits" — tune these as real usage teaches us more)

| Check | OK | Warn | Critical |
|---|---|---|---|
| Backend health latency | < 3s | 3-10s | no response / non-200 / >10s |
| Frontend reachability | 200 OK | — | non-200 or unreachable |
| SSL days remaining | > 14 days | 7-14 days | < 7 days or invalid |
| Overdue pending posts | 0 | 1-4 | 5+ |
| Storage overage | 0 GB | > 0 GB (informational only, never affects `overall`) | — |
| Database disk size | < 6GB | 6-8GB | > 8GB (Pro plan included amount) |
| Monthly Active Users | < 80k | 80k-100k | > 100k (Pro plan included amount) |

Warn = worth a look this week. Critical = should trigger an immediate Slack
ping and a real look at whether Render/Supabase need a tier upgrade, per the
guidance already in SERVICE_PROVIDERS.md — this domain's job is to make that
decision data-driven instead of a guess. Both Render and Supabase were
confirmed already upgraded (Starter / Pro respectively) as of 2026-08-05 —
these thresholds reflect the real current caps, not free-tier ones.

## Real infra tiers (confirmed live 2026-08-05, was previously documented wrong)

Render is on **Starter** (~$7/mo, no free-tier spin-down). Supabase is on
**Pro** ($25/mo, 8GB disk / 100k MAU included). See `SERVICE_PROVIDERS.md`
for the full correction — this file and that one had both drifted to
describing free-tier assumptions that were no longer true.

## cPanel disk quota — deliberately NOT automated

The shared cPanel account (5GB quota, ~39% used as of 2026-07-28, mostly
The Lazy Download's `public_html`, not LazyRelay) has no visible "API
Tokens" feature — this host restricts/hides cPanel API access for this
account. Rather than build a fragile workaround (e.g. scraping an
authenticated browser session), this is intentionally left as a periodic
manual check, not part of the automated Health & Safety suite. Not urgent
at current usage — revisit if it trends upward meaningfully (real customer
media uploads growing, etc.).

## Design boundary

This domain only reports. It never restarts services, never changes Render/
Supabase settings, never auto-upgrades a tier or spends money. A human reads
the Slack alert and decides.
