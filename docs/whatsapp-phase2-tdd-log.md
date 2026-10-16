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

### 8. Opt-out recording and the sender loop
- RED: `optOuts.test.ts` and `sender.test.ts` -> `no tests`, `Cannot find module './optOuts.js'` / `./sender.js`.
- GREEN: `optOuts.ts` -> `10 passed`; `sender.ts` -> `Tests 34 passed (34)`.
- Mutation check on the second opt-out layer (removed the consent / suppression check immediately before the send in `sender.ts`): `Tests 2 failed | 32 passed (34)`; restored -> `34 passed`. So those tests do bite.
- Proven (with a TypeScript MODEL of the SQL claim function): flags off = nothing; hand-off is conditional and resumable; US numbers never get a marketing template; consent and opt-out re-checked right before each message (an opt-out landing between claim and send is honoured; a failing opt-out lookup sends nothing); kill switch / no controls / free plan / no own login / paused connection / unapproved template / rolling daily cap all stop sending; 131050 records a permanent opt-out; restriction, quality and credential codes pause the connection and put the unsent batch back untouched; template errors pause the broadcast; transient errors retry at most 3 times with growing delay; a no-answer request is never retried; a crashed claim is failed as unconfirmed after 10 minutes and never resent; two concurrent loops never double-send; no number, token or Meta error text in any log or row.

### 9. Delivery receipts, account events, and the webhook wiring (receipts + inbound STOP)
- RED: `statusWebhook.test.ts` -> `no tests`, `Cannot find module './statusWebhook.js'`. Wiring: with `http/whatsappWebhooks.ts` reverted to the PR 139 version, `webhookWiring.test.ts` -> `Tests 2 failed | 3 passed (5)`.
- GREEN: `statusWebhook.ts` -> `Tests 24 passed (24)`. After wiring `handleWhatsAppWebhookEvent` (receipts after the 200; STOP-style inbound replies recorded as opt-outs once the delivery is verified, gated by the broadcast flags) -> `Test Files 2 passed, Tests 60 passed (60)` together with the existing `whatsappWebhooks.test.ts` (no regression). One hiccup: my first scripted edit missed the handler because the file uses CRLF line endings; caught by the test, re-applied.
- Proven: per-connection app-secret signature gate (wrong, missing, other secret, no saved secret all store nothing), idempotent on Meta's 7 day repeats, monotonic against out-of-order receipts, failure never overwrites delivery, 131050 receipt records a permanent opt-out, restriction/quality codes and quality/disabled account events pause the number, template errors pause the broadcast, no number or message id or Meta text stored, flags off = nothing.

### 10. Scope addition: two-way chat. Meta rules verified first, then migration 0131
- Verified against Meta's CURRENT docs (read 2026-10-16, URLs in `docs/whatsapp-phase2-pr-notes.md`): the 24 hour customer-service window opens when the user messages (or calls) and resets on each new user message; free-form "service messages" (text, interactive reply buttons, lists, media) only inside it, approved templates only outside it; reply buttons: up to 3, id max 256, title max 20 and unique, body max 1024; list messages: up to 10 rows, button label max 20, body max 4096; a tap arrives in the `messages` webhook as `interactive.button_reply` / `list_reply` with `context.id` = the message it answers; template quick-reply buttons (text only, 25 chars) ARE sendable outside the window (they are template components) and arrive as `type: "button"` with `button.text` and `context.id`.
- RED: `whatsappChatMigration.test.ts` -> `Tests 17 failed (17)` (file did not exist). GREEN: wrote `0131_whatsapp_chat.sql` (conversations, encrypted chat messages, approval requests, saved audiences, 30 day purge functions) -> `Test Files 2 passed, Tests 19 passed (19)` with `migrationNumbers.test.ts`. Column-level grants exclude every ciphertext column; not executed in Postgres.
- Refactor under test: shared signature / connection lookup moved to `whatsappBroadcast/webhookAuth.ts`; the 24 receipt tests and 5 wiring tests stayed green.

### 11. Two-way chat, inbound: vault, 24h window, extraction and storage, webhook path
- RED: `chatVault.test.ts` (window + vault), `inbound.test.ts`, `inboundWebhook.test.ts` -> `no tests`, `Cannot find module` each; wiring: `webhookWiring.test.ts` with the new chat cases -> `Tests 2 failed | 6 passed (8)` before wiring the handler.
- GREEN: `chatVault.ts` + `window.ts` -> `10 passed`; `approvalOptions.ts` + `inbound.ts` -> `26 passed`; `inboundWebhook.ts` -> `10 passed`; after wiring `handleWhatsAppWebhookEvent` -> `Test Files 2 passed, Tests 63 passed (63)` with the old `whatsappWebhooks.test.ts`.
- Proven: bodies and numbers only as envelopes bound to account and conversation; Meta message id only as a keyed hash; repeated delivery is a no-op; an unknown number gets a conversation but is never added to contacts or given consent; STOP-style text still opts out; a button/list/quick-reply tap answers exactly its own approval request (same account only), unknown ids become `other_reply`; the 24h window helper fails closed; signature, plan, flags and keys all gate the path.

### 12. Chat sending and chat delivery receipts
- RED: `chatSend.test.ts` -> `no tests`, `Cannot find module './chatSend.js'`; `cloudApiChat.test.ts` -> `Tests 25 failed (25)`; combined daily-cap test in `controls.test.ts` -> `1 failed | 13 passed`; chat receipts in `statusWebhook.test.ts` -> `Tests 4 failed | 25 passed (29)`.
- GREEN: `cloudApi.ts` (sendText, sendInteractiveButtons, sendInteractiveList, shared postMessage) -> `44 passed` with the old client tests; `chatSend.ts` -> `38 passed` (plus a type-narrowing fix flagged by `tsc`); `controls.ts` now counts broadcast AND chat messages in one daily cap; `statusWebhook.ts` applies receipts to chat messages -> `29 passed`.
- Proven: free-form only inside the 24h window (window_closed otherwise, no request made); templates only to a stored, opted-in contact (a person who messaged first can be answered in the window, never sent a template); marketing +1 blocked; plan, own login, pause, kill switch, shared cap, opt-out, suppression and missing keys all refuse before any request; 131050 opts out (by contact or by hash alone), restriction codes pause the connection, transient errors are NOT retried and show as failed, no-answer shows as unconfirmed; approval requests send 3 reply buttons in the window (template outside it) and leave no pending approval after a failed send; Meta's limits for buttons (3, id 256, title 20, unique, body 1024) and lists (10 rows, 20/24/72/200/4096) enforced before any request.

### 13. Conversations service: inbox, thread, start-from-contact, approvals list, saved audiences, update lines
- RED: `conversations.test.ts` -> `no tests`, `Cannot find module './conversations.js'`. GREEN: `conversations.ts` -> `Tests 21 passed (21)`.
- Proven: everything scoped to one account; nothing returned holds a number (mask only); bodies and approval titles decrypted only in the thread/approval read, an unreadable one shows a placeholder; a saved contact's own encrypted number is reused when a conversation is started (window starts closed); an opted-out or foreign contact cannot be started; audiences take only opted-in contacts of the same connection; an update line sends free-form text where the window is open and the approved template where it is closed, skips the rest, never attempts past a gate that applies to everyone (kill switch, pause, cap, plan), and is limited to 25 people (PLACEHOLDER).

