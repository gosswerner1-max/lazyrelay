# LazyRelay Backend

Phase 1 foundation, per `project-social-automation-mvp-scope.md`. Connected to a live Supabase project (LazyRelay org, Free tier, eu-west-1). Security Advisor clean (0 errors, only Supabase's own managed `rls_auto_enable()` warnings remain, which are not ours to fix).

## What's built and verified working (not just written — actually run against the real database)

- **Schema** (`0001_init_schema.sql`): `accounts`, `subscriptions`, `social_accounts`, `scheduled_posts`, `post_results`. RLS on every table. OAuth tokens via Supabase Vault, never plaintext.
- **Grants fix** (`0002_grants.sql`): raw-SQL-created tables don't inherit Supabase's default role grants — fixed, applied.
- **Function-grant fix** (`0003_fix_function_grants.sql`): Security Advisor caught that the Vault helper functions were still callable by `anon`/`authenticated` despite an earlier revoke, because Postgres grants EXECUTE to the implicit `PUBLIC` role by default and both roles inherit through it. Fixed, applied, verified clean in Security Advisor.
- **Scheduling engine** (`src/scheduler.ts`): claim-before-act discipline (same pattern as the race-condition fix already proven necessary in Lazy Download's own social automation), dispatches to a pluggable platform adapter, treats `verifyPublished()` (Proof-of-Publish) as a separate mandatory step, never inferred from a successful post call.
- **Platform adapter interface** (`src/platforms/`): real Meta/TikTok/Pinterest integrations slot in later without scheduler changes. Stub adapter in use — Phase 0 (developer app registration) hasn't started.
- **Billing/cancellation logic** (`src/billing/`): MoR-agnostic adapter interface (Paddle vs Lemon Squeezy undecided). `cancelSubscription()` cancels with the MoR first, only marks locally cancelled on success — verified with both succeeding and **failing** mock adapters, confirming a failed MoR cancellation never silently shows as cancelled.
- **HTTP API** (`src/http/`): real Express app — `POST/GET /api/scheduled-posts`, `DELETE /api/scheduled-posts/:id`, `POST /api/subscription/cancel`, `GET /api/social-accounts`, `POST /api/webhooks/mor` (raw-body, signature-verified). `requireAuth` middleware verifies a real Supabase JWT per request, resolves the caller's `account_id` server-side — never trusts a client-supplied account id.
- **OAuth connect flow** (`src/platforms/connect.ts`, `0004_oauth_states.sql`): `GET /api/social-accounts/connect` (authed, returns the authorize URL) and `GET /api/social-accounts/callback` (unauthenticated by necessity — the platform redirects the browser here directly — identity instead comes from a one-time, 15-minute state token minted server-side per account). The `oauth_states` table has no client-facing RLS policies at all — fail-closed by omission, only the backend service ever touches it.

**All of the above was actually run and tested against the live database, not just compiled:**
- `src/test-e2e.ts` — scheduler end to end.
- `src/test-cancel.ts` — cancellation, success + failure paths.
- `src/test-http.ts` — full HTTP layer: health check, 401 on unauthenticated requests, authenticated create/list with a real JWT, scheduler processing an API-created post, clean 502 on cancel-with-no-subscription.
- `src/test-connect.ts` — OAuth connect flow end to end, including a real security check: replaying a used state token is correctly rejected, proving the one-time-use mechanism actually works, not just that the happy path does.

All four self-clean their test data (delete the test user at the end) and can be re-run any time.

**Real bug found and fixed during this testing** (worth knowing, not just historical): calling `supabase.auth.signInWithPassword()` on the shared service-role client mutates that client's session state, silently switching all its subsequent requests to run as the signed-in user instead of service_role — caused a real permission-denied failure in `test-http.ts`. Fixed by using a separate client instance for that sign-in step. The actual app code (`requireAuth` in `src/http/auth.ts`) is **not** affected — it calls `auth.getUser(explicitToken)`, which is stateless when a token is passed explicitly, unlike `signInWithPassword`. Worth remembering if any future code ever needs to sign in as a user for testing: always use a throwaway client, never the shared service-role one.

- `src/test-signup-trigger.ts` — proves the `0005_account_on_signup.sql` Postgres trigger actually fires: creates an auth user with no manual `accounts` insert (exactly how a real frontend signup works), confirms the row was created automatically.

## Frontend now exists and is verified working

`../frontend/` — Vite + React + TypeScript, Supabase browser client (anon key only), a typed `api` client wrapping every backend endpoint, `AuthProvider`/`useAuth` context, `Login` (sign in/up) and `Dashboard` (connected accounts, connect button, schedule form, post list with Proof-of-Publish status) pages, routed in `App.tsx` off session state.

**Real bug found and fixed via actual browser testing** (not just code review): the Express app had no CORS middleware, so the browser correctly blocked every request from the frontend's origin (`localhost:5173`) to the backend (`localhost:3000`) with "Failed to fetch." Fixed by adding the `cors` package, restricted to `FRONTEND_URL` (defaults to `http://localhost:5173`).

**Verified end to end through the real UI** (browser preview, not just test scripts): signed in with a confirmed test user → Dashboard loaded connected accounts + scheduled posts with no errors → clicked "Connect a social account," confirmed the backend correctly returned a real state-token-bound authorize URL (navigation to it correctly no-ops since the stub adapter points at the reserved `.invalid` TLD — expected until Phase 0's real Meta URL replaces it) → manually seeded a stub `social_accounts` row → scheduled a real post through the form → watched the backend scheduler's 30s poll claim it, stub-publish it, and run Proof-of-Publish verification → refreshed and confirmed the UI showed "posted" with "✓ Proof-of-Publish verified." All test data (user, account, post) cleaned up afterward.

## To run this yourself

1. `npm install`
2. `.env` already has real credentials for the live LazyRelay Supabase project.
3. `npm run dev` — connects, starts the HTTP API on :3000, and starts the scheduler polling loop (30s interval).

## Not yet built (next steps)

- Real Meta/TikTok/Pinterest adapters — blocked on Phase 0 (developer app registration, needs to happen directly in the Meta/TikTok/Pinterest developer dashboards). The connect flow, scheduler, and HTTP routes are all already written against the adapter interface, so swapping in the real Meta implementation shouldn't require touching them.
- Merchant-of-Record decision (Paddle vs Lemon Squeezy) and swapping the stub adapter for the real one.
- CIPC company registration (with the bookkeeper, separate track).
