# LazyRelay Security Checklist

The standing security checklist for this codebase — one list, not five scattered
ones. Built 2026-08-26 after running five separate "vibe coding security"
checklists (a TikTok list, SecurityWall's 44-item list, arjaythedev.com's 7-item
list, NxCode's 10-item list, and astoj/vibe-security's 17-category list) against
the real code in one night and merging what mattered into this.

**How this file is used**: `lazyrelay-security-checklist-monthly` (a scheduled
task) re-verifies every item against the live code/infra monthly and posts a
digest to `#all-lazyrelay`, flagging **drift** — something that passed before
and doesn't now — not routine "still fine" restatements. Read the task's own
`SKILL.md` for exactly how it checks each item.

**Status legend**: ✅ verified live with real evidence · ⚠️ known limitation,
accepted · ❌ open gap, needs a decision · — not applicable to this stack.

Every item below carries the date it was last actually verified (not assumed).
When the monthly task re-checks an item, it updates that date and the evidence
line in place — this file should always reflect the *last real check*, not the
original one.

---

## 1. Authentication & Session Management

- ✅ **Passwords hashed, never handled by our code.** All auth delegated to
  Supabase Auth (`frontend/src/context/AuthContext.tsx`) — bcrypt hashing,
  session issuance, and token refresh are Supabase's problem, not ours.
  *(2026-08-26)*
- ✅ **MFA available.** Optional TOTP via Supabase Auth's built-in support,
  shipped `f9118f4`. Recovery codes shipped same night (`16c39f6`) — 10
  single-use codes, reveal-once, redeemable at the login challenge screen to
  remove a lost authenticator and get back in. Not mandatory for owners yet
  — see Open Items. *(2026-08-26)*
- ✅ **Sessions actually revoke server-side on sign-out**, not just cleared
  client-side (`supabase.auth.signOut()`, default global scope).
  *(2026-08-26)*
- ✅ **Password reset uses Supabase's own time-limited, single-use tokens** —
  no custom reset-token logic in this codebase. *(2026-08-26)*
- ✅ **Session timebox set to 30 days** (`sessions_timebox = 720` — the
  dashboard field is in **hours**, not days). Was `0` (never expire) until
  2026-09-01; Werner set it this session and it is verified live via the
  Management API. `sessions_inactivity_timeout` deliberately left at `0` —
  LazyRelay is a check-in-occasionally tool, and an inactivity logout is
  user-hostile for little gain on top of the timebox. `jwt_exp = 3600` +
  refresh-token rotation (`security_refresh_token_reuse_interval = 10`)
  unchanged. *(2026-09-01)*
- ✅ **Leaked-password protection enabled** (`password_hibp_enabled = true`)
  — new passwords are checked against the HaveIBeenPwned breach corpus. Was
  `false` until 2026-09-01; enabled this session, verified live. Pro-plan
  feature. *(2026-09-01)*
- ✅ **All three security notification emails enabled** — `mailer_
  notifications_password_changed_enabled`, `mailer_notifications_mfa_factor_
  enrolled_enabled`, and `..._unenrolled_enabled` all set `true` on
  2026-09-01 via the Management API (`PATCH /v1/projects/{ref}/config/auth`,
  HTTP 200, re-read to confirm). All three were `false`, so an account owner
  got **no email** when their password changed or a TOTP factor was
  added/removed — the account-takeover *detection* gap, sharpened by the MFA
  recovery codes shipped in `16c39f6` (a recovery code can remove a factor).
  Templates were already written and sitting unused. **Not yet proven
  end-to-end** — no real notification email has been received and read; do
  that on the next password change. *(2026-09-01)*
- ⚠️ **`security_update_password_require_current_password = false` —
  deliberately left off.** Turning it on looks like a win but risks breaking
  the only password-update path in the app: `ResetPassword.tsx:36` calls
  `supabase.auth.updateUser({ password })` with no `current_password`, and
  it is reached from a *forgot-password* email link, where the user by
  definition does not know the current password. Whether Supabase exempts
  recovery-token sessions is undocumented and untested. There is also no
  logged-in "change password" screen for it to protect. Revisit only with a
  real test on a scratch project first. *(2026-09-01)*
- ✅ **Password policy tightened**: `password_min_length` raised 6 → **10**
  on 2026-09-01 (was the Supabase default; never examined in the 2026-08-26
  sweep, so a previously-unexamined gap rather than drift). Raising it does
  not affect existing passwords. Done at the cheapest possible moment — 3
  accounts, all internal, zero customers. *(2026-09-01)*
- ⚠️ **`password_required_characters` set to the strictest option**
  (lowercase + uppercase + digits + symbols, all four required). Set
  2026-09-01. This is *stricter* than recommended, not weaker — the advice
  given was to leave it off, because current NIST guidance (SP 800-63B)
  holds that length plus a breach-corpus check beats composition rules,
  which tend to push people toward predictable `Password1!` shapes. With a
  10-char minimum and HIBP now on, the composition rule adds little and
  costs signup friction on a SaaS that needs to convert signups. Kept as
  Werner's call — flagged, not overridden. Revisit if signup drop-off shows
  up. *(2026-09-01)*
- ✅ **HTTPS enforced everywhere**, not just login — real `mod_rewrite` 301,
  HSTS with `includeSubDomains`. *(2026-08-25)*
- ✅ **JWTs verified properly**: remote JWKS, `ES256` pinned (blocks
  alg-confusion), issuer/expiry/audience all checked
  (`backend/src/http/mcpAuth.ts`). No signing secret in source — asymmetric
  keys only. *(2026-08-26)*

## 2. API Security & Access Control

- ✅ **Every non-public route requires auth** (`requireAuth` on everything
  except `/public/*`, `/support/chat`, and the callback/webhook routes
  below). Re-verified 2026-09-01: 93 routes in `routes.ts`, and every one
  not in that set carries `requireAuth`/`requireOwner`/`requireAdmin`/
  `requireHumanAuth`. **Evidence line corrected** — the 2026-08-26 wording
  ("the OAuth callback", singular) is out of date: three more pre-auth
  routes shipped 2026-08-29→31. Each authenticates by a non-JWT means
  because the caller can't attach one:
  - `/social-accounts/callback` — CSRF state cookie (unchanged).
  - `/google-calendar/callback` — CSRF state cookie (`lr_gcal_oauth_state`),
    compared before the code is exchanged.
  - `/google-calendar/webhook` — Google echoes a per-connection random
    `X-Goog-Channel-Token` we generated at subscribe time; compared with
    `timingSafeEqual` (length-guarded), 404 on any mismatch, and the
    notification body is never trusted — a valid call just re-runs the same
    `syncConnectionInbound()` the hourly poller already runs.
  - `/public/signup/check-business-name` — no auth by design (availability
    check during signup); returns only a boolean + suggestions, never names.
    Its full-table read was fixed the same day via migration 0077 — see
    Open Items 8. *(2026-09-01)*
- ✅ **No IDOR**: service-role bypasses RLS, but every mutation route
  re-checks `account_id` ownership in app code, AND Postgres RLS is
  independently enabled with `auth.uid()`-scoped policies — defense in two
  layers, not one. *(2026-08-26)*
- ✅ **Admin/owner/delete-class routes have server-side role checks**
  (`requireOwner`, `requireAdmin`, `requireHumanAuth` in
  `backend/src/http/auth.ts`). *(2026-08-26)*
- ✅ **Rate limiting on every route**, tiered by subscription plan, plus a
  coarse IP limiter on the one pre-auth route (OAuth callback)
  (`backend/src/http/rateLimit.ts`). *(2026-08-26)*
- ✅ **Errors never leak stack traces/internal details** — generic message to
  the customer, real detail server-side only. *(2026-08-26)*
- ✅ **CORS locked to an explicit origin allowlist**, never a wildcard.
  *(2026-08-19)*
- ✅ **No internal/admin routes reachable without an admin key**, and admin
  keys themselves need a pre-registered job or a human-opened intent window —
  a key used outside both auto-revokes immediately. **As of 2026-09-01 there
  are zero live admin keys** (all three revoked: two by the auto-revoke guard
  on 2026-08-08 and 2026-08-30, the third — minted 2026-08-13, never used,
  plaintext not retained — revoked manually on Werner's instruction).
  `admin_key_registered_jobs` is empty and nothing calls
  `getLazyRelayAdminApiKey()`, so nothing depends on one existing. This is
  Werner's standing position: *mint one only when needed*
  (`backend/src/create-admin-key.ts`). *(2026-09-01)*
- ✅ **Security-event alerting**: 401/403 spikes, 429 rate-limit spikes, and
  any admin-key auto-revoke page `#all-lazyrelay` in real time
  (`backend/src/http/securityAlerts.ts`, commit `5253a9b`). Proven against
  live production traffic, not just locally. **Re-confirmed 2026-09-01 by
  reading the actual Slack history**, not the code: the 2026-08-30 admin-key
  auto-revoke produced a real bot alert in `#all-lazyrelay` at 12:11:41 CAT,
  ~1 second after the revoke timestamp in `admin_api_keys`. An `auth_denied`
  spike alert fired the same morning. This item is now evidenced by observed
  output rather than by inspection. *(2026-09-01)*

## 3. Secrets & Configuration

- ✅ **Nothing hardcoded in source** — zero literal `sk_live_`/`sk-ant-`/
  `AIza…`/`ghp_`/`xoxb-`/private-key matches in `backend/src`,
  `frontend/src`, `ops`, `mcp-server`, or `support`. The only `lzr_live_`
  hits in source are the `API_KEY_PREFIX` constant and `lzr_live_your_key_
  here` placeholders in docs/UI. **Evidence line corrected** — the
  2026-08-26 claim of "zero `lzr_live_` matches anywhere in … `ops`" is no
  longer literally true: `ops/config/credentials.local.json` (created
  2026-08-30) holds a real live LazyRelay API key plus an admin key, npm
  token, and Supabase access token. Verified 2026-09-01 that this is **not
  a leak** — it is gitignored by `.gitignore:7` (`*.local.json`), has never
  been tracked (`git ls-files` no match), and the key literal appears
  nowhere in history (`git log --all -S`). It is a local-only credentials
  file, same class as `.env`. Future greps will hit it; this is the
  sanctioned file, not a regression. *(2026-09-01)*
- ✅ **`.env` never committed** — checked full git history
  (`git log --all -p -- '*.env'`), only `.env.example` files were ever
  tracked. *(2026-08-26)*
- ✅ **Dev/staging vs. production secrets are genuinely separate**
  (`PADDLE_ENVIRONMENT`, separately cut-over Render env vars). **Re-verified
  live 2026-09-01** against the Render API (`GET /v1/services/{id}/env-vars`,
  HTTP 200): `PADDLE_ENVIRONMENT = production`, and **all 60** production env
  var values scanned for sandbox/test-shaped patterns
  (`sandbox`/`_test_`/`sdbx`/`dummy`/`localhost`) — **zero matches**. This is
  the exact class of drift that caused the 2026-08-05 incident (Render on
  sandbox Paddle keys for weeks while local held live ones), so it is worth
  re-running every month. Credentials come from `RENDER_API_KEY` /
  `RENDER_SERVICE_ID` via `ops/config/credentials.js`'s
  `getRenderCredentials()`. *(2026-09-01)*
- ✅ **Third-party keys are least-privilege** — every platform OAuth adapter
  requests only the named scopes it needs, checked adapter-by-adapter.
  Re-verified 2026-09-01 including the new Google Calendar client: it uses a
  **separate, dedicated** Google Cloud OAuth client (`GOOGLE_CALENDAR_
  CLIENT_ID`/`_SECRET`, not the Business Profile one) and was deliberately
  narrowed in `7b5c9a6` from broad `calendar` to `calendar.app.created` +
  `calendar.calendarlist` + the non-sensitive `userinfo.email` — it can only
  touch the calendar it created itself. *(2026-09-01)*
- ✅ **Nothing sensitive in the client bundle** — only the Supabase *anon* key
  (RLS-protected), a Turnstile site key, and Paddle's client-side token.
  Service-role key is backend-only by explicit code comment and by grep.
  *(2026-08-26)*
- ✅ **DB credentials never reach the client** — no raw `DATABASE_URL`/
  connection string anywhere in the app; all access via Supabase's managed
  API gateway. *(2026-08-26)*

## 4. Input Validation & Output Encoding

- ✅ **Server-side validation everywhere**, independent of client JS (54
  length/shape checks across `routes.ts`). *(2026-08-26)*
- ✅ **No raw SQL string concatenation** — Supabase JS client (parameterized
  under the hood) or `.rpc()` only. *(2026-08-26)*
- ✅ **No XSS surface** — zero `dangerouslySetInnerHTML` in the frontend;
  React's default escaping relied on everywhere. *(2026-08-26)*
- ✅ **File uploads validated by real content, not extension** — magic-byte
  detection (`fileTypeFromBuffer`) against an explicit MIME allowlist before
  storage. *(2026-08-26)*
- ✅ **Uploaded files can't be executed / aren't in an executable path** —
  stored in Supabase Storage, served as static media only.
- ✅ **Open-redirect protected** — OAuth callback redirects only to a
  server-configured URL, never user-supplied. *(2026-08-26)*
- ✅ **SSRF guarded** — customer-supplied media URLs are checked
  (`backend/src/urlSafety.ts`) against private/loopback/link-local/
  cloud-metadata ranges before the server ever fetches them, and every
  platform adapter's own media fetch refuses redirects (`redirect: "manual"`,
  commit `86bcbb1`). *(2026-08-21)*

## 5. Database & Storage Security

- ✅ **RLS enabled with real per-row policies** (see §2). Re-verified
  2026-09-01 across all 76 migrations: every `create table` has a matching
  `enable row level security` — zero exceptions, including the six new
  Google Calendar migrations (0071–0076). `google_calendar_connections`
  carries an `auth.uid() = account_id` policy; `google_calendar_oauth_states`
  is fail-closed by omission (service_role only), matching `oauth_states`.
  *(2026-09-01)*
- ✅ **Service-role key is server-only.** *(2026-09-01)*
- ✅ **Storage buckets**: `post-media` is deliberately public (social
  platforms must fetch media directly to publish it) — still the *only*
  bucket. Upgraded from a grep to a **live** check 2026-09-01 (Supabase
  Management API `GET /v1/projects/{ref}/storage/buckets`): exactly one
  bucket returned, `post-media`, `public: true`. *(2026-09-01)*
- ✅ **Production database not directly internet-exposed** — no raw
  Postgres port ever touched from the app; Supabase's managed gateway only.
  *(2026-08-26)*

## 6. Dependency & Supply-Chain Security

- ✅ **Lockfile committed**, CI uses `npm ci` (reproducible builds).
  *(2026-08-26)*
- ✅ **Dependabot configured** (`.github/dependabot.yml`, weekly).
  *(2026-08-26)*
- ⚠️ **One unfixed high-severity `image-size` CVE** (ICNS/JXL/HEIF DoS, no
  upstream fix exists) — accepted as low-risk: the app's own upload allowlist
  blocks those file types from ever reaching the vulnerable code path.
  Re-check when a fix ships. Re-confirmed 2026-09-03: backend still reports
  exactly this one high and nothing else (`fixAvailable: false` — still no
  upstream fix); frontend and mcp-server both report **zero** vulnerabilities
  at every severity. **This is the only real gap left after closing a real
  one found the same day**: `fast-uri` (4 distinct high-severity advisories)
  and `qs` (2 medium) had appeared as transitive dependencies since the
  09-01 check — in `backend` via `@modelcontextprotocol/sdk`'s `ajv`, and
  separately in `mcp-server`'s own copy of the same dependency tree — and
  had been sitting unfixed long enough to show the "GitHub found N
  vulnerabilities" warning on every single push. Fixed both lockfiles with a
  clean, non-forcing `npm audit fix`, verified each package still builds,
  deployed, and confirmed **0 open Dependabot alerts repo-wide** via the
  GitHub API (not the push-time message, which lags the actual scan by one
  push and briefly showed a confusingly higher number right after the
  first fix). *(2026-09-03)*
- ✅ **No auto-merge of dependency updates.** *(2026-08-26)*
- ✅ **`package.json` deps use caret ranges, but the lockfile pins exact
  versions** — reproducibility holds via the lockfile even though the
  manifest itself floats. Low-priority polish item, not a real risk.
  *(2026-08-26)*

## 7. Backups & Disaster Recovery

- ✅ **Database**: Supabase Pro plan daily snapshots.
- ✅ **Storage**: weekly local backup of the `post-media` bucket
  (`lazyrelay-storage-backup-weekly`) — ⚠️ laptop-only, no off-site copy yet;
  revisit once real customer volume justifies the cost.
- ✅ **Restore genuinely proven, not assumed** — a full real restore drill
  2026-08-26: created a temporary Supabase project, restored all 69
  migrations + every real table's data, verified byte-for-byte on a real row,
  deleted the scratch project after. Two real findings recorded: `accounts`
  depends on `auth.users` (restore that first), and Vault-encrypted tokens
  are **provably non-portable across projects** — a cross-project disaster
  recovery would need every customer to reconnect their social accounts;
  restoring into the *same* project doesn't hit this. *(2026-08-26)*

## 8. Logging & Monitoring

- ✅ **Admin-key actions logged** (`admin_audit_log`, every request).
  *(2026-08-26)*
- ✅ **Security-event spikes alert Slack in real time** (see §2).
  *(2026-08-26)*
- ✅ **Scheduler/posting failures alert Slack** (`notifyOps()`, wired to
  `SLACK_WEBHOOK_URL` on Render). *(2026-08-26)*
- ✅ **Deploys are verifiable**: `/health` returns the live
  `RENDER_GIT_COMMIT`/`RENDER_GIT_BRANCH`, but **only** to a caller holding
  a real admin key — the public response stays exactly `{"status":"ok"}`.
  Gated deliberately: the GitHub repo is public, so a commit SHA on an
  unauthenticated endpoint would tell anyone which code is live and, most
  usefully to an attacker, whether a given fix has shipped. Added
  2026-09-01 (`40f5a60`) after verifying the 0077 deploy required a detour
  through `pg_stat_statements`. Uses `isKnownAdminKey()`, **not**
  `requireAdmin` — the latter auto-revokes a key presented without a
  registered job, which on a liveness probe would destroy it. The lookup
  runs only when an `Authorization` header is present and is wrapped in its
  own try/catch, so build metadata can never make the probe report
  unhealthy. *(2026-09-01)*
- ✅ **Logs checked for over-capture of sensitive data** — full audit of
  ~584 `console.*` calls found everything clean (tokens only ever logged as
  hashes/prefixes, no raw `req.body` logging, AI prompts/responses never
  logged beyond `err.message`) **except one real finding**: see Open Items.
  *(2026-08-26)*

## 9. AI-Specific Risks

- ✅ **AI-generated code is read by a human before deploying** — standing
  process rule (double-confirm before any source edit), not code-verifiable
  but consistently followed this session.
- ✅ **Support-bot system prompt has no hardcoded secrets/other-customer
  data** — only generic product text + the requesting account's own scoped
  data. *(2026-08-26)*
- ✅ **User input into the LLM is validated first** — message count/role/
  length checks before the model ever sees it. *(2026-08-26)*
- ✅ **LLM output is never trusted for security-critical decisions** —
  `[[ACTION:...]]` tags are suggestions only; the real action still requires
  the customer's own authenticated click. Billing decisions come from
  HMAC-verified webhooks, never model output. *(2026-08-26)*
- ✅ **LLM cost/abuse controls**: daily message cap, 30s timeout,
  `max_tokens` cap, plus the route's own IP rate limit. *(2026-08-26)*
- — **No RAG in use** — the support bot is a static prompt + per-request
  account-scoped context fetch, not applicable.

## 10. Data Privacy & Retention

- ✅ **GDPR DPA** built 2026-08-11.
- ❌ **POPIA compliance** — Werner needs to personally register as
  Information Officer with South Africa's Information Regulator, and a real
  written operator agreement is needed. **Deliberately not AI-drafted** —
  Werner's call to use a real professional. Still open.
- ✅ **Account data deletion**: real, tested policy — 30 days post-
  cancellation, 7-day warning email, actually deletes posts/media.
  *(2026-08-15)*
- ✅ **Support-gap retention**: `support_knowledge_gaps` carries full
  transcripts + customer email — now purged 90 days after a gap reaches a
  terminal state (`rejected`/`applied`), via `purgeOldResolvedGaps()`
  (`ops/support/support_gaps.js`), run as part of the weekly digest task.
  *(2026-08-26 — fixed same night it was found)*

## 11. Incident Response

- ✅ **`INCIDENT_RESPONSE.md`** (repo root) — real, practical runbook: how
  incidents get detected, severity triage, first-15-minutes checklist, and
  8 playbooks for the scenarios that actually apply to this stack (leaked
  secret, data breach, compromised account, billing fraud, DDoS, vendor
  outage, data-loss restore, platform API revocation). Grounded in what's
  real today, not generic boilerplate — references the actual Slack
  channel, the actual restore-drill steps proven live, the actual admin-key
  auto-revoke mechanism. *(2026-08-26)*

## 12. Infrastructure

- — **No Infrastructure-as-Code** (Terraform/CloudFormation) — Render and
  Supabase are managed via their own dashboards, nothing to scan here.
- ✅ **Cloudflare is live and proxying** — verified 2026-09-01 by API and by
  a real request: `lazyrelay.com` returns `server: cloudflare` with a
  `cf-ray` header, and the HSTS header
  (`max-age=31536000; includeSubDomains`) is served. Zone plan: **Free
  Website**. First checked with a real API token this run (read-only,
  scoped to the `lazyrelay.com` zone alone, `Zone:Read` +
  `Zone Settings:Read`), stored as `cloudflareApiToken` in
  `ops/config/credentials.local.json`. *(2026-09-01)*
- ✅ **Page Shield enabled** — `GET /zones/{id}/page_shield` →
  `{"enabled":true,...,"updated_at":"2026-08-26T10:40:02Z"}`, matching the
  date it was originally switched on. *(2026-09-01)*
- ✅ **SSL mode is `strict`** with `automatic_https_rewrites = on` and
  `tls_1_3 = on`. *(2026-09-01)*
- ✅ **`min_tls_version` is `1.2`** — was `1.0` (Cloudflare's default, never
  changed) and **not on this checklist at all** until a real API token was
  added this run. TLS 1.0/1.1 are deprecated, prohibited under PCI DSS, and
  dropped by every major browser in 2020. Raised to `1.2` by Werner in the
  dashboard 2026-09-01; confirmed by `GET
  /zones/{id}/settings/min_tls_version` → `"1.2"`, with the site still
  serving HTTP 200 over TLS 1.2 and 1.3.
  **Evidence caveat, recorded deliberately:** an attempt to independently
  prove TLS 1.0 is now refused was **inconclusive** — this Windows machine's
  curl uses Schannel, which fails with `SEC_E_UNSUPPORTED_FUNCTION` before
  reaching Cloudflare, so the refusal came from the OS, not the edge. The
  Cloudflare API's own report of the zone config is the evidence here. A
  future run wanting true end-to-end proof needs a client that can still
  speak TLS 1.0, or an external scanner (e.g. SSL Labs). *(2026-09-01)*
- ✅ **`always_use_https` is `on`** — enabled 2026-09-01, so http→https is now
  turned around at the Cloudflare edge instead of travelling to the origin
  first. Cloudflare warns this can cause `ERR_TOO_MANY_REDIRECTS` when the
  origin *also* forces HTTPS, which this one does (`.htaccess` `mod_rewrite`
  301, §1) — **it does not here, and that was tested rather than assumed.**
  Because SSL mode is `strict`, Cloudflare reaches the origin over HTTPS, the
  origin sees HTTPS already on, and does not re-redirect. Verified against a
  pre-change baseline (1 hop, 200) and re-tested after on four paths — `/`,
  `/pricing/`, `/docs/`, and `www.` — all still **1 hop → 200**, with
  `https://` direct and the backend `/health` both 200. Config confirmed via
  API: `always_use_https = "on"`. *(2026-09-01)*
- ⚠️ **Bot Fight Mode stays OFF — deliberate business decision, not a gap.**
  Werner's call, 2026-09-01: it challenges non-browser traffic, which breaks
  the verification crawlers that directory and badge-exchange sites send to
  confirm a backlink is live (Startup Fame, Smol Launch, Turbo0, SaaS Cubes,
  ListMySaaS, Findly.tools, Fazier, Twelve Tools, Wired Business, SaaSHub —
  all added 2026-08-28→31, see the `.htaccess` CSP `img-src` list). Backlinks
  are an active growth channel; breaking them to satisfy a checklist item is
  the wrong trade. **This also corrects the 2026-08-26 entry**, which claimed
  Bot Fight Mode was *enabled* — that came from a dashboard glance, not a
  verified reading. **Compensating control:** the app's own tiered
  rate limiting plus the coarse IP limiter on pre-auth routes (§2) carry this
  load, and they are code-verified rather than edge-dependent. Do not enable
  Bot Fight Mode without checking the backlink-verification impact first.
  **Now confirmed by API** (token widened 2026-09-01):
  `GET /zones/{id}/bot_management` → `"fight_mode": false`, with
  `crawler_protection`, `ai_bots_protection` and `content_bots_protection`
  all `disabled` — consistent with keeping crawlers unblocked.
  *(2026-09-01)*
- ✅ **WAF and DDoS protection are genuinely deployed** — confirmed 2026-09-01
  via `GET /zones/{id}/rulesets` (after the token was widened). Three managed
  rulesets are live: **Cloudflare Managed Free Ruleset**
  (`http_request_firewall_managed` — the actual WAF), **DDoS L7 ruleset**
  (`ddos_l7`), and the **Normalization Ruleset** (`http_request_sanitize`).
  This settles the legacy `waf: off` zone setting above: it is indeed
  meaningless, and WAF coverage is present via the managed ruleset.
  *(2026-09-01)*
- ⚠️ **Cloudflare's leaked-credential detection is OFF**
  (`GET /zones/{id}/leaked-credential-checks` → `{"enabled": false}`).
  **This corrects the 2026-08-26 claim that it was enabled — it never was.**
  But turning it on would achieve little here, for an architectural reason:
  it works by inspecting login requests passing through the zone, and
  LazyRelay's auth does not pass through it — the browser calls Supabase
  directly (`AuthContext.tsx`; see the `connect-src` Supabase origin in the
  `.htaccess` CSP), so credentials never traverse `lazyrelay.com`'s
  Cloudflare proxy. **The equivalent protection is already in place one layer
  down**: Supabase's own `password_hibp_enabled` was switched on 2026-09-01
  (§1), which checks passwords against the same breach corpus at the point
  they are actually set. Left off deliberately as redundant-and-ineffective
  rather than pursued. *(2026-09-01)*
- ⚠️ **The zone-level `waf` setting reads `off`** — this is the *legacy* WAF
  toggle, largely meaningless on a Free plan (paid managed rulesets are not
  available; the free managed ruleset is applied automatically). Recorded so
  a future run doesn't misread it as a regression, but it is **not**
  independent evidence that WAF coverage is absent — `/rulesets` returned 403
  above, so the true state is genuinely unknown. *(2026-09-01)*

---

## Open Items (as of 2026-09-01)

1. **MFA not mandatory for account owners** — the blocker (no recovery path
   for a lost authenticator) is now closed as of `16c39f6` (2026-08-26).
   Making it actually mandatory is still a separate, deliberate product
   decision, not yet made.
2. **POPIA compliance** — Werner arranging a real professional, not AI-drafted.
3. **Storage backups are laptop-only**, no off-site copy — revisit at real
   customer volume.
4. **One unfixed `image-size` CVE**, low-risk given the upload allowlist —
   re-check when upstream ships a fix.
5. **Customer-communication plan for a real incident** — `INCIDENT_RESPONSE.md`
   deliberately defers this until there are real customers to notify; draft
   it when the first one signs up, not mid-incident.
6. ~~No session timeout~~ — **closed 2026-09-01**, 30-day timebox set.
7. ~~Weak password policy~~ — **closed 2026-09-01**: minimum raised to 10,
   leaked-password protection on, three security notification emails on.
   One loose end: the notification emails are enabled but have not been
   *received and read* end-to-end. Confirm on the next real password change.
8. ~~`/public/signup/check-business-name` full-table read~~ — **closed
   2026-09-01, fix deployed and proven live.** It read every non-null
   `business_name`
   into memory per call, on an unauthenticated route that fires on every
   keystroke batch during signup. Replaced with
   `check_business_name_available()` (migration 0077): at most 6 index hits
   on `accounts_lower_business_name_idx`, every candidate a bound value, no
   PostgREST filter string ever assembled — which answers the original
   author's objection rather than ignoring it. Migration **is applied to the
   database** (verified: function present, `security definer`, `search_path`
   locked, EXECUTE revoked from `anon`/`authenticated`, granted only to
   `service_role`); six live calls return the exact response contract the
   frontend expects, including the comma/paren name that motivated the old
   full-scan approach. Deployed in `ee2e639`. **Proven live, not assumed:**
   because the new code returns byte-identical responses to the old, the
   endpoint alone can't reveal which version is running — so the proof came
   from `pg_stat_statements` instead. Across three live production requests
   the RPC path went 2 → 5 (+3, exactly matching) while the old full-scan
   query stayed flat at 5. The old path is no longer called. *(2026-09-01)*
9. ~~Cloudflare `min_tls_version` is `1.0`~~ — **closed 2026-09-01**, raised
   to `1.2` the same day it was found. It had never been on the checklist;
   it surfaced only because a real Cloudflare API token was added this run,
   which is the argument for keeping the token.
10. ~~Cloudflare `always_use_https` is `off`~~ — **closed 2026-09-01,
   enabled and tested.** The dashboard's `ERR_TOO_MANY_REDIRECTS` warning
   does apply in principle (this origin does force HTTPS), so it was enabled
   against a captured baseline and immediately re-tested on four paths
   rather than assumed — no loop, 1 hop → 200 throughout. The reason it is
   safe is `ssl = strict`: Cloudflare reaches the origin over HTTPS, so the
   origin's own redirect never fires. **If SSL mode is ever changed to
   `Flexible`, this combination WILL loop and take the site down** — that
   dependency is the thing to remember here.
11. ~~Leaked-credentials mitigation + deployed WAF rulesets are unverified~~
   — **closed 2026-09-01.** Token widened (Bot Management:Read +
   Zone WAF:Read, still read-only, still one zone); all three previously-403
   endpoints now return 200. Results: WAF and DDoS L7 managed rulesets **are**
   deployed; Bot Fight Mode is **off** (deliberate, see §12); Cloudflare
   leaked-credential detection is **off** and left off as architecturally
   ineffective here — Supabase's `password_hibp_enabled` covers it at the
   right layer. **Two of August's §12 green ticks turned out to be false**
   (Bot Fight Mode, leaked credentials), both originally recorded from a
   dashboard glance rather than a verified read.

## Re-check log

- **2026-09-01** — monthly drift check. 43 ✅ items re-verified against live
  code/infra; 3 evidence lines corrected (§1 sessions, §2 pre-auth routes,
  §3 `ops` secrets grep), 3 new open items added (6–8 above). No item that
  genuinely passed on 2026-08-26 fails now. The whole new Google Calendar
  surface (6 migrations, 5 new routes, `backend/src/googleCalendar/`) was
  audited fresh and came back clean: RLS with `auth.uid()` policies, tokens
  in Supabase Vault, narrowed scopes, timing-safe webhook auth, no token
  logging, every route rate-limited. **Not re-checked this run, needs a
  human pass:** Cloudflare WAF / Bot Fight Mode / Page Shield (§12). **This
  run's claim that Render was equally uncheckable was wrong** — corrected
  later the same day: `ops/config/credentials.js` exposes
  `getRenderCredentials()` (`RENDER_API_KEY` / `RENDER_SERVICE_ID`), so §3's
  env-var separation *is* verifiable headlessly and was verified. A future
  run should reach for `ops/config/credentials.js` before declaring
  something uncheckable — it also holds the Supabase and npm tokens.
- **2026-09-01 (same day, follow-up with Werner)** — five Supabase Auth
  settings changed and verified live, closing open items 6 and 7 the same
  day they were opened: session timebox 0 → 720 hours (30 days), password
  minimum 6 → 10, leaked-password protection off → on (Werner, dashboard);
  password-changed and MFA-enrolled/unenrolled notification emails off → on
  (Management API PATCH, HTTP 200, re-read to confirm). Two things
  deliberately **not** done: `security_update_password_require_current_
  password` stays off (would risk breaking the forgot-password flow — see
  §1), and `password_required_characters` was set stricter than advised and
  left as Werner's call. Lesson banked for next time: the dashboard's
  **Time-box user sessions** field is in *hours*, not days — "30 days" must
  be entered as `720`.

## Full source list

- SecurityWall's 44-item checklist (`securitywall.co`)
- arjaythedev.com's 7-item checklist
- NxCode's 10-item checklist (`nxcode.io`)
- astoj/vibe-security's 17-category checklist (GitHub, MIT licensed)
- The original TikTok-sourced checklist that started the 2026-08-26 sweep

Full detail and evidence trail for everything above:
`03 - LazyRelay/project-pre-launch-hardening-2026-08-25.md` and the
2026-08-26 daily note (Sessions 15–22) in the vault.
