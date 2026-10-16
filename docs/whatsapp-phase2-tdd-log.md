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

### 4. Cloud API client (send one template, list templates), injected HTTP
- RED: `vitest run src/whatsappBroadcast/cloudApi.test.ts` -> `Test Files 1 failed, no tests` (`cloudApi.js` did not exist).
- GREEN (after one fix): first run `19 tests | 1 failed` - my test fixture ended the paging with a cursor, which the code (rightly) kept following into an unmocked third call; Meta puts cursors on the last page too, so the implementation now continues only when `paging.next` is present (and uses only the cursor, never the link) and the fixture was corrected -> `Tests 19 passed (19)`. Covers: token only in the Authorization header, Meta's error text never returned (only code and HTTP status), no-answer and a 200 without a message id both reported as `noResponse`, recipient and template name validated before any request, production client refuses any host but graph.facebook.com and never follows redirects.

### 5. Send controls (kill switch, caps, connection pause) and the BYOK gate
- RED: `controls.test.ts` and `byok.test.ts` -> `no tests`, `Cannot find module './controls.js'` / `./byok.js`.
- GREEN: `controls.ts` -> `13 passed`. `byok.ts` -> first run `14 passed, 1 failed` (my "other account" fixture had no subscription so it hit the plan check first; fixture fixed) -> `15 passed`.
- Proven: free / lapsed / starter / pro plan refused (REAL `resolveTier`), no stored login refused, damaged or id-mismatched login refused, other account's connection not found, no fallback token (a source scan finds no token/secret/key env read in the broadcast code; env vars named like Meta tokens are ignored), no global row or a damaged one = no sending.

### 6. Templates (sync from the customer's own Meta account) and 7. Broadcast service (create, preview, list, cancel, counters)
- RED: `templates.test.ts` and `broadcasts.test.ts` -> `no tests`, `Cannot find module './templates.js'` / `./broadcasts.js`.
- GREEN: `templates.ts` -> `21 passed`; `broadcasts.ts` -> `36 passed`. Also changed the migration's PLACEHOLDER caps from 500/2/250 to 250/2/250 so the per-broadcast cap cannot exceed the daily message cap (migration test updated; `Test Files 7 passed, Tests 119 passed` for the folder + migration tests).
- Proven: refusals with stable codes for free plan, no own login, paused connection, kill switch, missing controls, wrong/pending/unsupported template, wrong variable count, bad schedule, bad name, empty audience, both caps; +1 numbers excluded from marketing audiences; dry run writes nothing; cost is an ESTIMATE and null without a rate card; cancel stops a sending broadcast and skips queued recipients.

