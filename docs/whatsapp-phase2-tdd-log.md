# WhatsApp broadcast sending (Phase 2): TDD log

Branch `feature/whatsapp-broadcast-send`, built from PR 139 (`821b315`). Nothing here is applied, pushed or switched on. No real
Meta call, no network to Supabase, no real token: every test uses in-memory fakes and an injected HTTP client.

Test runs need four throwaway environment variables or most files fail to import (they are not secrets and never leave the
shell): `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=test-service-role-key-not-real SUPABASE_ANON_KEY=test-anon-key-not-real MCP_RESOURCE_URL=http://127.0.0.1:9/mcp`.
The worktree has no `backend/.env`; the main checkout's was deliberately not copied.

## Baseline (before any change, branch tip 821b315)

| Suite | Result |
|---|---|
| backend `npx tsc --noEmit` | exit 0 |
| backend `npx vitest run` (with the throwaway env above) | 136 files, 2379 tests: 2378 passed, 1 failed (`src/http/app.test.ts > GET /health > returns 200`, 5 s timeout, the known flaky one) |
| frontend `npx vitest run` | 67 files, 657 tests: 657 passed, 0 failed |

Without the throwaway env the backend run shows 16 files failing to import (`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set`); that is a missing-env artefact, not a code failure.

## Steps (RED then GREEN)

### 1. Migration 0129 (templates, rate cards): static checks
- RED: `vitest run src/whatsappBroadcastMigrations.test.ts` -> `Tests 7 failed (7)`, first error `table whatsapp_message_templates not found` (file did not exist).
- GREEN: wrote `0129_whatsapp_templates_rate_cards.sql` -> `Test Files 2 passed, Tests 9 passed` (with `migrationNumbers.test.ts`).

### 2. Migration 0130 (broadcasts, recipients, status events, send controls, pause state, claim function): static checks
- RED: added the 0130 `describe` to `src/whatsappBroadcastMigrations.test.ts` -> `Tests 18 failed | 7 passed (25)` (file did not exist).
- GREEN: wrote `0130_whatsapp_broadcasts.sql` -> `Test Files 1 passed, Tests 25 passed (25)`.
- NOT proven by this step: the triggers, policies, grants and the plpgsql `claim_whatsapp_broadcast_recipients` function were never executed (no SQL harness).

### 3. Flags and Meta error classification
- RED: `vitest run src/whatsappBroadcast/` -> `Test Files 2 failed`, `Cannot find module './metaErrors.js'` (and `./flags.js`).
- GREEN: `flags.ts`, `metaErrors.ts` -> `Test Files 2 passed, Tests 26 passed (26)`. Includes: `whatsappSendingSupported()` stays false with both new flags on; 131050 is an opt-out; 131048/368/131031/401 pause the connection even when the HTTP status looks transient; no-answer is never retried.

