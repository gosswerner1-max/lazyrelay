# LazyRelay Incident Response Runbook

A short, real runbook for a solo-founder, pre-revenue SaaS — not a corporate
50-page plan. The goal is that when something actually goes wrong at 2am,
there's a checklist to follow instead of a blank page. Written 2026-08-26,
closing Open Item #11 from `SECURITY_CHECKLIST.md`.

**Who this is for**: Werner (founder/operator) and Claude/James (operations
partner) — there is no separate security team. Every "you" below means
whoever is actually handling the incident, human or Claude, together.

---

## How incidents get noticed

Real, working channels as of tonight — check these first, don't wait for a
customer to report something:

- **`#all-lazyrelay` Slack channel** (`C0BJW47SUAD`) — the actual real-time
  alert feed. Posts automatically for: scheduler/posting failures
  (`notifyOps()`), security-event spikes (401/403 auth-denial spikes,
  429 rate-limit spikes, any admin-key auto-revoke, any MFA recovery-code
  use — `backend/src/http/securityAlerts.ts`), and the daily/weekly ops
  digests.
- **Render dashboard** — backend service health, deploy status, logs.
- **Supabase dashboard** — database health, Auth logs, storage usage.
- **Cloudflare dashboard** — traffic/threat analytics, WAF events (CDN/WAF
  live as of 2026-08-26).
- **A customer or platform (Meta/TikTok/etc.) reporting something directly.**
- **The monthly `lazyrelay-security-checklist-monthly` task** — flags drift
  in the standing security posture; not real-time, but a real detection path.

If you're not sure something is actually an incident, treat a "maybe" as a
real one until you've checked — the cost of a false alarm is a few minutes;
the cost of a missed real one is much higher.

## Severity — pick one fast, don't overthink it

| Level | What it means | Example |
|---|---|---|
| **Critical** | Real customer data exposed or at risk, money at risk, or the site/backend is fully down | DB credentials leaked, a live payment-fraud pattern, backend won't start |
| **High** | A real security gap exists but nothing confirmed exploited yet, or a partial outage | A secret was committed to git, one platform's posting is broken, MFA recovery abused once |
| **Low** | Contained, no customer impact, or already mitigated by existing defenses | A single rate-limit spike that Cloudflare/the app already blocked cleanly |

Critical → stop what you're doing and work the incident now. High → same day.
Low → log it, fix it in the next normal session.

## First 15 minutes (any Critical or High)

1. **Don't panic-fix.** A rushed change made under pressure is how a second
   incident gets created on top of the first one.
2. **Contain, don't yet fully solve.** If a key is leaked: revoke/rotate it
   first, understand the blast radius after. If an account looks
   compromised: the standing hard rule still applies — never type a
   password into a login field, use the platform's own admin/reset tools.
3. **Write down what you know, live, as you go** — timestamp, what
   triggered the discovery, what's been touched so far. This becomes the
   post-incident write-up later; reconstructing it from memory afterward is
   much worse than capturing it in real time.
4. **Check blast radius using real data, not guesses** — which table/route/
   customer is actually affected. Every playbook below says exactly where
   to look.
5. **Decide Critical vs. High** using the table above, and follow that
   playbook.

---

## Playbooks

### 1. Leaked secret or API key (found in git history, a screenshot, a log, anywhere)

1. **Rotate it immediately** — a leaked secret is compromised the moment it
   leaked, whether or not anyone's used it yet. Rotation order:
   - `SLACK_WEBHOOK_URL` → delete the Slack app's webhook, create a fresh
     one (same pattern as the 2026-08-26 setup), update Render.
   - Supabase service-role key / anon key → regenerate in Supabase
     dashboard → Project Settings → API, update Render + `frontend/.env.production`, redeploy both.
   - `MOR_WEBHOOK_SECRET` (Paddle) → create a new notification destination
     in Paddle (can't re-reveal an existing one's secret), update Render,
     deactivate the old destination. See `feedback-webhook-secret-mismatch-2026-08-04` in the vault for the exact steps — this has happened before.
   - Any platform OAuth app secret (Meta/TikTok/etc.) → regenerate in that
     platform's developer console, update Render — every currently
     connected customer's token stays valid (regenerating the app secret
     doesn't invalidate already-issued user tokens on any of these
     platforms), but new OAuth connects will fail until the new secret is
     live.
   - LazyRelay customer API key (`lzr_live_...`) or admin key
     (`lzr_admin_...`) → these are already designed to be individually
     revocable without touching anything else; revoke via the dashboard
     (customer key) or `revoked_at` update (admin key, or let the
     auto-revoke guard handle it).
2. **Check if it was actually committed to git** — `git log --all -p --
   '<path>'` or search the string directly. If yes, rotating isn't enough:
   the old value is in history forever unless the repo is force-rewritten
   (a genuinely last-resort, disruptive action — usually just rotate and
   move on, since a private repo's history isn't public exposure the same
   way a leaked-to-the-internet value is).
3. **Check what the leaked value could have reached** — grep for real usage
   in the affected window (Render logs, `admin_audit_log` for admin keys,
   Supabase Auth logs for service-role misuse).
4. Log it in the vault (`03 - LazyRelay/`) and bank the lesson if the leak
   path reveals something fixable (e.g. a log statement that shouldn't
   exist — see the 2026-08-26 log-hygiene pass for the pattern).

### 2. Suspected data breach / unauthorized database access

1. **Confirm it's real first** — check Supabase's own Auth/API logs for the
   actual access pattern (unfamiliar IP, unfamiliar service-role usage,
   requests outside normal traffic shape) before assuming the worst.
2. **If confirmed**: rotate the Supabase service-role key immediately (this
   alone kills any stolen-key access), then work out what was actually
   touched — `admin_audit_log` for admin-key-mediated access,
   `support_chat_usage`/row timestamps for anything else.
3. **Check RLS is still intact** — `SECURITY_CHECKLIST.md` §2/§5 record what
   "normal" looks like; a breach that came through an RLS gap would show up
   as a policy that's missing or wrong, not just a leaked key.
4. Once contained, this becomes a Critical write-up regardless of whether
   real customer data existed at the time (currently near-zero real
   customers, but the process should already be proven before it matters).

### 3. Compromised customer or admin account

1. **Customer account**: force a password reset via Supabase Auth admin
   (never type their password, never handle it directly). If they have MFA
   enrolled and it looks like the compromise involved bypassing it, check
   `mfa_recovery_codes`/`admin_audit_log` for suspicious recent recovery-code
   use (this fires a Slack alert on every use already — check if it fired).
2. **Admin key**: the system already self-defends here — any admin-key use
   outside a registered job or an open human-approved intent window
   auto-revokes the key immediately (`backend/src/http/auth.ts`). If one
   fires, that's the alert; the response is just minting a fresh key
   (`backend/src/create-admin-key.ts`) and checking `admin_audit_log` for
   what the leaked key actually touched before revocation.
3. **Werner's own accounts** (Supabase dashboard login, Render, Cloudflare,
   registrar, Paddle, GitHub) — if any of these look compromised, rotate
   that vendor's own login credentials directly on their site (Claude never
   handles login credentials — this is always Werner's own hands).

### 4. Payment / billing fraud or a Paddle incident

1. Paddle is Merchant of Record — they carry primary responsibility for
   fraud detection/chargebacks on the payment side, but LazyRelay's own
   webhook handling still needs checking: verify `webhook.ts`'s signature
   check is genuinely rejecting bad signatures (a real incident here before
   was a false-positive-403 bug, not fraud — see `Active Priorities.md`
   history), and check `billing_records` for the specific transaction.
2. If a specific account looks fraudulent (stolen card, chargeback abuse),
   the response lives in Paddle's own dashboard (refund/dispute tools) —
   don't try to solve payment fraud in LazyRelay's own code.
3. Check `getMorStatus()`'s drift detection first — if local/deployed
   billing config disagree, that's a real risk multiplier during any
   billing incident and should be fixed before anything else.

### 5. DDoS or abuse spike

Already substantially mitigated by tonight's work — this playbook is mostly
"confirm the defenses are doing their job," not "build defenses under fire."

1. Check Cloudflare's Security Analytics — is it already absorbing the
   traffic (rate limiting, Bot Fight Mode, WAF)?
2. Check `#all-lazyrelay` for `rate_limited` security alerts from the app's
   own layer — confirms the second line of defense is also firing.
3. If genuinely overwhelming: Cloudflare's "Under Attack Mode" (visible on
   the zone Overview page) is a real, one-click extra layer — a JS
   challenge on every visitor, more aggressive than normal, meant for
   exactly this.
4. This should rarely require code changes — if it does, that's itself a
   finding (an endpoint that needed a rate limit and didn't have one).

### 6. Vendor outage (Render, Supabase, Cloudflare, Paddle, cPanel/mail)

1. Check the vendor's own public status page first — don't assume it's
   LazyRelay's own bug before ruling that out.
2. **Render down**: backend + scheduler are both offline — posts stop
   publishing on time. Nothing to do but wait and watch Render's status;
   there's no fast failover for a single-instance Starter-tier service.
3. **Supabase down**: everything (DB, Auth, Storage/Vault) goes down at
   once — this is the single-vendor concentration risk already flagged in
   `SERVICE_PROVIDERS.md`. No fast mitigation; the real defense is the
   proven restore capability below if data is actually lost, not
   uptime during a vendor outage.
4. **Cloudflare down**: if proxied records are affected, the site could go
   fully unreachable — the emergency lever is "Pause Cloudflare" (visible on
   the zone Overview page), which bypasses Cloudflare and routes straight to
   the origin again, no DNS change needed.
5. **cPanel/mail down**: site and all 4 mailboxes offline together (shared
   hosting, see `SERVICE_PROVIDERS.md`'s cross-product coupling risk).

### 7. Data loss requiring a real restore

**This has been proven live, not just planned** — see the 2026-08-26 restore
drill (`03 - LazyRelay/project-pre-launch-hardening-2026-08-25.md`). The real
steps, already tested end-to-end:

1. Create a scratch Supabase project (or, for restoring into the *same*
   project after real data loss, use Supabase's own dashboard restore from
   its daily snapshot — the drill tested the cross-project path
   specifically, which is strictly harder).
2. Push all migrations (`supabase db push`) — watch for the known `0007`/
   `0023` duplicate-migration-version quirk; never use `--include-all`
   against a project with real history, only against a genuinely empty one.
3. Restore `auth.users` first (accounts foreign-keys into it) — a bare
   public-schema restore fails without this.
4. Restore the rest of the tables in FK-dependency order (or disable/
   re-enable constraints if going table-by-table isn't practical under
   time pressure).
5. **Known limitation, not a bug**: Vault-encrypted platform tokens
   (`social_accounts.access_token_vault_id`/`refresh_token_vault_id`,
   `oauth_states.pending_token_vault_id`) cannot be restored into a
   *different* Supabase project — Vault's encryption key is project-specific
   and Vault blocks reassigning a secret's ID even for service-role. This
   only matters for a cross-project restore; restoring into the *same*
   project (the realistic disaster-recovery case, e.g. Supabase's own PITR/
   snapshot restore) doesn't hit this at all. If it ever does matter for
   real: every customer needs to reconnect their social accounts — plan the
   communication for that specifically, don't improvise it mid-incident.
6. Verify with a real spot-check (byte-for-byte row comparison), not just
   row counts.

### 8. A platform (Meta/TikTok/etc.) revokes or flags API access

1. Check the platform's own developer dashboard for the actual reason —
   don't guess. `03 - LazyRelay/project-platform-review-status-check-2026-08-04.md`
   and its siblings have the real history/precedent for how these
   review cycles actually work.
2. If it's a policy violation, not a security incident: this is a product/
   compliance response, not an incident-response one — different playbook,
   different urgency (see the vault's platform-specific notes).
3. If it's a real security concern the platform is flagging (e.g. a
   reported token leak, an abuse report): treat it like §3 (compromised
   account) for the specific connected accounts affected, and rotate that
   platform's own app credentials per §1 regardless.

---

## Communication

**Right now (near-zero real external customers)**: internal only —
Slack + the vault write-up is sufficient. No customer-notification process
exists yet because there's essentially no one to notify.

**Once there are real customers**, this needs an actual plan before it's
needed for real — draft one when the first real customer signs up, don't
wait for an incident to improvise it. At minimum it should cover: who gets
told and when (immediately for anything touching their data, on a reasonable
timeline for anything contained), what channel (email via the existing
`hello@`/`support@` mailboxes), and what NOT to say until the facts are
actually confirmed (don't speculate publicly about scope before it's known).

## After the incident

1. **Write it up for real** — what happened, when it was noticed, what was
   done, what the actual root cause was (not just the symptom). Same
   discipline already used for every other incident in this project's
   history (see `feedback-webhook-secret-mismatch-2026-08-04`,
   `project-host-process-leak-2026-08-09`, etc. for the pattern).
2. **Bank the lesson**, not just the fix — if this incident revealed a
   process gap (a check that should exist and didn't), that's the more
   valuable output than the specific fix, since the specific fix only
   prevents this exact recurrence.
3. **Update `SECURITY_CHECKLIST.md`** if the incident revealed a real gap in
   what it covers — the checklist should reflect real lessons learned, not
   stay frozen at its 2026-08-26 starting point.
4. **Decide if this changes the monthly checklist task's scope** — if the
   incident came through a path the monthly drift-check wouldn't have
   caught, that's worth adding to what it checks.
