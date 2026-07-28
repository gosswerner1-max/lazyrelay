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
   report) — the one infra cost that scales with customers; flagged here
   too so it surfaces daily, not just on the weekly cadence.

## Thresholds (the actual "limits" — tune these as real usage teaches us more)

| Check | OK | Warn | Critical |
|---|---|---|---|
| Backend health latency | < 3s | 3-10s | no response / non-200 / >10s |
| Frontend reachability | 200 OK | — | non-200 or unreachable |
| SSL days remaining | > 14 days | 7-14 days | < 7 days or invalid |
| Overdue pending posts | 0 | 1-4 | 5+ |
| Storage overage | 0 GB | > 0 GB | > 20 GB (meaningful $ impact) |

Warn = worth a look this week. Critical = should trigger an immediate Slack
ping and a real look at whether Render/Supabase need a tier upgrade, per the
guidance already in SERVICE_PROVIDERS.md — this domain's job is to make that
decision data-driven instead of a guess.

## Design boundary

This domain only reports. It never restarts services, never changes Render/
Supabase settings, never auto-upgrades a tier or spends money. A human reads
the Slack alert and decides.
