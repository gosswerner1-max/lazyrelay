# WhatsApp and X are BYOK: no volume caps, no kill switches (TDD log)

Branch `fix/whatsapp-byok-no-caps`, from `origin/main` at `bd7eac0` (PR 139 = 8812782, PR 141 = bd7eac0). Nothing is pushed, applied or
switched on. Test runs need the same throwaway env as before (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`MCP_RESOURCE_URL` for the backend; throwaway `VITE_*` for the build).

## Baseline (origin/main, before any change)

| Check | Result |
|---|---|
| backend `npx tsc --noEmit` | exit 0 |
| backend `npx vitest run` | 159 files, 2941 tests: 2940 passed, 1 failed (`app.test.ts > GET /health > returns 200`, the known 5 s timeout) |
| frontend `npx vitest run` | 74 files, 766 tests: 766 passed, 0 failed |

## Steps

### 1. RED: tests that prove the opposite of a cap
- New `backend/src/whatsappBroadcast/noCaps.test.ts` (source scan: no cap or kill-switch table, column, seed, function, setting or refusal code in the WhatsApp code or migrations 0128 to 0131) and `noCapsBehavior.test.ts` (1,000 recipients, 12 broadcasts in a day, 600 messages in one go, 300 chat messages in 24 h, an update line to 100 contacts).
- RED: `vitest run src/whatsappBroadcast/noCaps.test.ts src/whatsappBroadcast/noCapsBehavior.test.ts` -> `Test Files 2 failed, Tests 17 failed | 28 passed (45)`. Failing: the scan flagged `broadcasts.ts`, `controls.ts`, `sender.ts`, `chatSend.ts`, `conversations.ts`, `whatsappBroadcasts.routes.ts`, `whatsappRouteGate.ts` and `0130_whatsapp_broadcasts.sql`; the behaviours were refused by `cap_recipients`, `cap_broadcasts`, `cap_messages` and the 25 person limit.

### 2. GREEN: backend caps and kill switches removed
- Removed `whatsappBroadcast/controls.ts` (loadControls, EffectiveControls, countMessagesAcceptedSince, countBroadcastsSince); the Meta-driven pause functions moved to `connectionPause.ts` (git rename of `controls.ts` and its test). Removed every reader: `broadcasts.ts` (kill switch, recipient cap, broadcasts per day, the `limit` field of a refusal), `sender.ts` (global/per-account kill switch, rolling 24 h message cap, cap_reached pause, the 10-batch per-cycle ceiling), `chatSend.ts` (kill switch, shared daily cap and their messages), `conversations.ts` (`MAX_UPDATE_RECIPIENTS`, `audience_too_large`, the cap codes in the stop list), `whatsappBroadcasts.routes.ts` (capabilities is `{ sending }` only), `whatsappRouteGate.ts` (503 and 429 cap codes), test kit seeding. Migration 0130 edited in place (unapplied).
- Also fixed in passing so "any audience size" is true: audience members are read page by page (the API returns at most 1,000 rows per read), member counts use count queries, adding members works in chunks with no silent 500 slice.
- GREEN: `noCaps.test.ts` + `noCapsBehavior.test.ts` pass (45 tests); the WhatsApp backend suites, migration tests and `startupConfigCheck.test.ts`: `Test Files 31 passed, Tests 724 passed (724)`; `tsc --noEmit` exit 0. Old tests that asserted caps or the kill switch were deleted; tests that used the kill switch only as a way to hold a broadcast now use a Meta-style pause row instead.

### 3. Open to every paid tier (Starter and up): backend gate (RED then GREEN)
- RED: new `backend/src/byokPlanGate.test.ts` (real `resolveTier` / `checkWhatsappPlan` / `canUse*` over free + five paid tiers, every good-standing and lapsed status, and migration 0132) -> `Tests 10 failed | 51 passed (61)`.
- GREEN: `tier.ts` (both allow-lists now `starter, pro, business, agency, agency_plus`, required plan name = Starter), `accountLimits.ts` and `xByok.routes.ts` messages say "any paid plan", new unapplied migration `0132_byok_paid_plan_gate.sql` replaces the two database trigger functions (0125 WhatsApp, 0126 X) with the same list, the backend recognises both the old and the new DB messages. -> `Tests 61 passed (61)`.
- Existing tests that encoded "Pro and above" / "Business and above" were updated to the new rule (the X route matrix, the WhatsApp byok matrix, webhook-info, inbound webhook plan tests, the broadcast `byok.test.ts`), and both new route suites (`whatsappBroadcasts`, `whatsappChat`) now loop over every route x every paid tier x every lapsed status.
- Full backend run: `Test Files 1 failed | 161 passed (162), Tests 1 failed | 3021 passed (3022)` (the one failure is the known `/health` 5 s timeout).

