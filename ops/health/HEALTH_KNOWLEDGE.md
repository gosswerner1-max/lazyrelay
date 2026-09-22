# LazyRelay Health & Safety — knowledge file

Independent monitoring of the live system, separate from the scheduler's own
in-process circuit breaker (which only alerts on platform-API failures the
backend itself hits). This domain checks things from the OUTSIDE — same
vantage point a real customer or an uptime monitor would have — so it can
catch problems the backend itself might not notice (e.g. it being asleep on
Render's free tier, or the frontend being unreachable while the API is fine).

**Placeholder.** This repo is public, so `<other business>` stands for one of
Werner's other businesses rather than naming it; it resolves in the vault via
`09 - Resources/Ops-QA/reference-werner-mailbox-other-businesses.md`.

## What it checks and why

1. **Backend health + latency** (`GET {RENDER_BACKEND_URL}/health`) — the
   real signal for "is Render currently strained or asleep." A cold-start
   spin-up on the free tier shows up here as a slow or timed-out response.
2. **Frontend reachability** (`GET https://lazyrelay.com`) — catches cPanel
   hosting issues, DNS problems, or a bad deploy independent of backend health.
3. **SSL certificate expiry** — a lapsed cert takes the whole site down for
   every visitor at once; days-remaining is checked directly via a TLS
   handshake, not assumed from "it auto-renews."
4. **Domain registration expiry** (added 2026-09-17) — a lapsed domain takes
   down the site *and* every `@lazyrelay.com` mailbox at once, and isn't a
   same-day fix like an SSL reissue. Checked via Verisign's public RDAP
   endpoint (`rdap.verisign.com`, the ICANN-mandated WHOIS successor,
   structured JSON, no credentials) since no API/MCP exists for the real
   registrar (`domains.co.za` — confirmed in `reference-infra-quick-facts.md`
   in the vault). Surfaced by comparing against a PieMonitor cold-pitch email
   that offered this exact check for $2/mo — this closes the one real gap
   that comparison found; the other four features it advertised were already
   covered.

   **KNOWN FALSE-POSITIVE CLASS — a transient RDAP blip used to page Werner's
   phone as if the domain were expiring (found 2026-09-18, FIXED 2026-09-22,
   Werner's go-ahead).** `checkDomainExpiry()` treated ANY fetch failure —
   a timeout, a non-200, a malformed response — as `critical`, the one
   severity wired to both Slack and a phone push, with no retry. Hit for
   real 2026-09-18 20:11 SAST: `overall: critical` on `"RDAP lookup error:
   fetch failed"` while every customer-facing check was green. Verified it
   was a false alarm, not assumed: pulled the same RDAP URL directly (200,
   domain expires 2027-07-21, 305 days out at the time) and a re-run a
   minute later came back clean. The check was one day old; this was its
   first real outing.

   **Fixed 2026-09-22**: `checkDomainExpiry()` now retries once (3s delay)
   before giving up, and any outcome short of a confirmed reading — fetch
   failure, non-200, or a response with no expiration event — is `warn`,
   not `critical`, even after the retry. Only a genuinely confirmed
   <14-days-remaining reading stays `critical`. Verified both paths for
   real: the happy path against the live RDAP endpoint (still returns `ok`,
   302 days), and the failure path with a simulated network error
   (retries once, ~3s elapsed, then returns `warn` with `"(after retry)"`
   in the detail). Full health check re-run clean, `overall: ok`.
5. **Scheduler lag** (real Supabase read: `scheduled_posts` rows still
   `pending` well past their `scheduled_for` time) — the most direct proxy
   for "the scheduler is falling behind," which is the core Proof-of-Publish
   promise breaking. Does NOT read the in-process circuit breaker state
   (that lives only inside the running backend, not the DB) — this is a
   genuinely different, externally-observable signal.

   **KNOWN FALSE-POSITIVE CLASS — a paused batch used to read exactly like a
   dead scheduler (found 2026-09-05, FIXED 2026-09-05, Werner's go-ahead,
   commit `330052a`).** `checkSchedulerLag()`
   filters only on `status = 'pending'` and `scheduled_for < cutoff`. It
   never excludes `scheduled_posts.paused_at`, so posts that were
   deliberately paused still count as "overdue" forever. Pausing sets
   `paused_at` and deliberately leaves `status` as `pending` (see
   `routes.ts:3504-3541` and migration note: pause is a timestamp, not a new
   status value), so the two states are indistinguishable to this check.

   Hit for real on 2026-09-05: `overall: critical`, 41 overdue — all 41
   carrying one identical `paused_at` of `2026-09-04T18:52:21.914Z`, from
   Werner's "stop all ads until we get tiktoks approval" pause of the whole
   1,160-post batch. Exact counts: 1,160 pending / 1,160 paused / **0
   unpaused overdue**. Nothing was wrong — `scheduler.ts:155,177` filters
   `.is("paused_at", null)` on its claim queries, so the scheduler was
   correctly declining to publish paused rows.

   **How to triage this in one query** before reporting a scheduler
   critical: count overdue pending rows split by `paused_at` null vs
   not-null. If `overdueUnpaused` is 0, the scheduler is fine and the batch
   is paused — say so plainly rather than reporting an outage. If it is
   non-zero, *that* is the real number and the scheduler genuinely is
   behind.

   Also worth knowing when investigating this table: a plain PostgREST
   `select` caps at 1,000 rows, so a raw `.length` on the result silently
   under-reports a queue this size and can look like a draining backlog.
   Use `{ count: "exact", head: true }` for any figure you intend to report.

   **Fixed 2026-09-05, Werner's go-ahead**: added `.is("paused_at", null)` to
   the query at `health_ops.js:121` (commit `330052a`, pushed). The check now
   only counts posts that are actually supposed to have gone out. Not yet
   proven against a real digest run — the next `lazyrelay-daily-ops-digest`
   firing with the batch still paused is the live test.
6. **Media storage overage** (reuses the same real query as the weekly
   report) — reported for visibility, but **excluded from `overall`
   severity** (changed 2026-08-05): Supabase meters/auto-scales storage past
   the included amount rather than hard-blocking (confirmed live on the
   Supabase usage page — "Disk automatically scales up when you get close to
   its size"), so raw GB overage is never an operational emergency. The real
   signal — whether storage add-on revenue still covers the real Supabase
   cost — is `billing_ops.js::checkStorageMargin()`, a pricing question, not
   a health question.
7. **Database disk size** (`ops_db_size_bytes()` RPC, migration 0031, added
   2026-08-05) — direct read of the real Postgres disk size against
   Supabase Pro's 8GB included allowance. Added after finding the original 5
   checks were all *proxies* for capacity strain (latency, lag) rather than
   a direct read of the actual documented cap.
8. **Monthly Active Users** (`ops_monthly_active_users()` RPC, same
   migration) — direct-ish read against Supabase Pro's 100k included MAU.
   This is a conservative proxy (distinct sign-ins in the current calendar
   month via `auth.users.last_sign_in_at`), not Supabase's exact billing
   definition (real MAU also counts token refreshes) — it can only
   under-count the real figure, never over-count, so it's safe to alert on
   without risking a false "all clear."

## KNOWN ISSUE CLASS — concurrent Supabase requests intermittently hit Cloudflare 522s (found + measured 2026-09-22, fixed 2026-09-22, Werner's go-ahead)

`run_health_check.js` crashed outright 4 times across 2 runs on 2026-09-22
(04:09, 04:10, 04:11, then again 05:09 SAST), each printing a Cloudflare 522
HTML page from `qbmejnmyqogotdzzzyvj.supabase.co` and dying on a libuv
`UV_HANDLE_CLOSING` assertion, producing **zero check results**. The same
window also broke 4 of 5 step-sets across 2 runs of the metrics-poller task.

Measured root cause: it's concurrency, not availability. Sequential requests
to Supabase: 0/12 failures (~250ms each). Concurrent requests (3 at a time,
`Promise.all`): 1/18 (~6%), each failure stalling ~19.5-21.5s (Cloudflare's
origin-connect timeout) before returning 522. Backend `/health` (its own
separate Supabase-query code path) had 0 failures in 20 samples over the same
window, and Supabase's REST endpoint answered correctly (401) when hit
directly — ruling out a real outage. Per-run, not per-request, is the number
that matters operationally: every Supabase-touching scheduled run that day
hit at least one 522 on first attempt (4 of 4), because firing 8 checks
concurrently makes hitting at least one ~20s stall close to certain even at a
6% per-request rate.

Two separate bugs this exposed, both fixed same day:

1. **A single Supabase hiccup aborted the whole run.** `gatherStorageUsage()`
   ran before `runAllChecks()` in `run_health_check.js` with no error
   handling, so its failure threw past `main()` before any of the 8 checks
   ran. Fixed: wrapped in try/catch; a failure is now surfaced as its own
   `storage_overage` check result (`status: warn`, `excludeFromOverall:
   true`) instead of killing the run.
2. **`runAllChecks()` fired all 8 checks concurrently via `Promise.all`,
   which is exactly the pattern that triggers the 522.** Fixed: checks now
   run sequentially (a plain `for` loop with `await`), matching the 0/12
   sequential failure rate measured above. Slightly slower wall-clock, zero
   measured failures.

A Supabase support ticket was filed the same day (2026-09-22, "Intermittent
Cloudflare 522s on concurrent REST/RPC requests") with the full measurements
above, asking whether this is expected edge behavior under light concurrency
or something to adjust on our side.

## Thresholds (the actual "limits" — tune these as real usage teaches us more)

| Check | OK | Warn | Critical |
|---|---|---|---|
| Backend health latency | < 3s | 3-10s | no response / non-200 / >10s |
| Frontend reachability | 200 OK | — | non-200 or unreachable |
| SSL days remaining | > 14 days | 7-14 days | < 7 days or invalid |
| Domain days remaining | > 30 days | 14-30 days | < 14 days or lookup failed |
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
`<other business>`'s `public_html`, not LazyRelay) has no visible "API
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
