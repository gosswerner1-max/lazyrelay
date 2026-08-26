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
  shipped `f9118f4`. Not mandatory for owners yet — see Open Items.
  *(2026-08-26)*
- ✅ **Sessions actually revoke server-side on sign-out**, not just cleared
  client-side (`supabase.auth.signOut()`, default global scope).
  *(2026-08-26)*
- ✅ **Password reset uses Supabase's own time-limited, single-use tokens** —
  no custom reset-token logic in this codebase. *(2026-08-26)*
- ⚠️ **Session inactivity timeout lives in Supabase's dashboard config**, not
  in this repo — can't be verified from code alone. Check Supabase Auth →
  Sessions settings directly if this ever needs re-confirming. *(2026-08-26)*
- ✅ **HTTPS enforced everywhere**, not just login — real `mod_rewrite` 301,
  HSTS with `includeSubDomains`. *(2026-08-25)*
- ✅ **JWTs verified properly**: remote JWKS, `ES256` pinned (blocks
  alg-confusion), issuer/expiry/audience all checked
  (`backend/src/http/mcpAuth.ts`). No signing secret in source — asymmetric
  keys only. *(2026-08-26)*

## 2. API Security & Access Control

- ✅ **Every non-public route requires auth** (`requireAuth` on everything
  except `/public/*` and the OAuth callback). *(2026-08-26)*
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
  a key used outside both auto-revokes immediately. *(2026-08-26)*
- ✅ **Security-event alerting**: 401/403 spikes, 429 rate-limit spikes, and
  any admin-key auto-revoke page `#all-lazyrelay` in real time
  (`backend/src/http/securityAlerts.ts`, commit `5253a9b`). Proven against
  live production traffic, not just locally. *(2026-08-26)*

## 3. Secrets & Configuration

- ✅ **Nothing hardcoded** — zero literal `sk_live_`/`lzr_live_`/etc. matches
  anywhere in `backend/src`, `frontend/src`, or `ops`. *(2026-08-26)*
- ✅ **`.env` never committed** — checked full git history
  (`git log --all -p -- '*.env'`), only `.env.example` files were ever
  tracked. *(2026-08-26)*
- ✅ **Dev/staging vs. production secrets are genuinely separate**
  (`PADDLE_ENVIRONMENT`, separately cut-over Render env vars). *(2026-08-26)*
- ✅ **Third-party keys are least-privilege** — every platform OAuth adapter
  requests only the named scopes it needs, checked adapter-by-adapter.
  *(2026-08-26)*
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

- ✅ **RLS enabled with real per-row policies** (see §2). *(2026-08-26)*
- ✅ **Service-role key is server-only.** *(2026-08-26)*
- ✅ **Storage buckets**: `post-media` is deliberately public (social
  platforms must fetch media directly to publish it) — the one bucket in use,
  confirmed by grep, not an oversight. *(2026-08-26)*
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
  Re-check when a fix ships. *(2026-08-26)*
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

- ❌ **No written incident response plan.** For a pre-revenue, single-founder
  product, a full IR plan is overkill, but a short runbook (who does what,
  in what order, for a breach/leak/outage) is cheap insurance. **Open —
  not yet written.**

## 12. Infrastructure

- — **No Infrastructure-as-Code** (Terraform/CloudFormation) — Render and
  Supabase are managed via their own dashboards, nothing to scan here.
- ✅ **Cloudflare CDN/WAF live** — DDoS protection, Bot Fight Mode, leaked-
  credentials mitigation, Client-side security (Page Shield) all enabled.
  *(2026-08-26)*

---

## Open Items (as of 2026-08-26)

1. **MFA not mandatory for account owners** — deliberately deferred; needs a
   real recovery-code sub-system before it's safe to require. Own future task.
2. **POPIA compliance** — Werner arranging a real professional, not AI-drafted.
3. **No written incident response runbook.**
4. **Storage backups are laptop-only**, no off-site copy — revisit at real
   customer volume.
5. **One unfixed `image-size` CVE**, low-risk given the upload allowlist —
   re-check when upstream ships a fix.

## Full source list

- SecurityWall's 44-item checklist (`securitywall.co`)
- arjaythedev.com's 7-item checklist
- NxCode's 10-item checklist (`nxcode.io`)
- astoj/vibe-security's 17-category checklist (GitHub, MIT licensed)
- The original TikTok-sourced checklist that started the 2026-08-26 sweep

Full detail and evidence trail for everything above:
`03 - LazyRelay/project-pre-launch-hardening-2026-08-25.md` and the
2026-08-26 daily note (Sessions 15–22) in the vault.
