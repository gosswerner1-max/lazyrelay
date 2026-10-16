# WhatsApp broadcast sending and two-way chat (Phase 2): PR notes

Branch `feature/whatsapp-broadcast-send`, built on PR 139 (`feature/whatsapp-contacts-consent`, commit `821b315`). **Nothing is applied,
pushed, deployed or switched on.** No real Meta call was made, no network to Supabase, no real token or secret exists in any file. Every
flag defaults off. TDD evidence (RED then GREEN for every step) is in `docs/whatsapp-phase2-tdd-log.md`.

## What is built

| Area | Where | What it does |
|---|---|---|
| Migration 0129 | `backend/supabase/migrations/0129_whatsapp_templates_rate_cards.sql` | `whatsapp_message_templates` (copied from the customer's own Meta account, approved and supported only are sendable) and `whatsapp_rate_cards` (the customer's own prices, for a cost ESTIMATE). RLS on, browser roles read-only, service role writes. |
| Migration 0130 | `0130_whatsapp_broadcasts.sql` | `whatsapp_send_controls` (DB kill switch and caps, global row seeded STOPPED, **placeholder** caps 250 recipients per broadcast, 2 broadcasts per day, 250 messages per rolling 24 h), `whatsapp_connection_send_state` (per-number pause), `whatsapp_broadcasts`, `whatsapp_broadcast_recipients` (by contact id, no number, keyed hash of Meta's message id), append-only `whatsapp_broadcast_status_events`, and the plpgsql `claim_whatsapp_broadcast_recipients()` (claim and opt-out check in one statement, skip-locked). |
| Migration 0131 | `0131_whatsapp_chat.sql` | `whatsapp_conversations`, `whatsapp_chat_messages` (bodies AES-256-GCM encrypted), `whatsapp_approval_requests` (title encrypted), `whatsapp_audiences` and members, 30 day purge functions for chat and for broadcast delivery rows. Column-level grants hide every ciphertext column from browser roles. |
| Sender loop | `backend/src/whatsappBroadcast/sender.ts` | Separate from the post scheduler. Sweeps crashed claims, hands due broadcasts off, re-checks every gate each cycle, claims small batches, re-checks consent and opt-out immediately before each message, sends the approved template with the customer's own token. |
| Cloud API client | `whatsappBroadcast/cloudApi.ts` | `sendTemplate`, `sendText`, `sendInteractiveButtons`, `sendInteractiveList`, `listTemplates`. HTTP client is injected (tests never touch a network); the production client refuses any host but `graph.facebook.com` and never follows redirects. |
| BYOK gate | `whatsappBroadcast/byok.ts` | A send needs a paid plan (the repo's `checkWhatsappPlan` / `resolveTier`: free, lapsed or too-low plans are refused) AND the customer's own stored login (their token, WABA id and phone number id from Vault) AND a healthy, unpaused connection. There is no env token and no fallback. |
| Controls | `whatsappBroadcast/controls.ts` | Kill switches and caps read from the database; no row or a damaged row means no sending. One rolling daily cap counts broadcast and chat messages together. |
| Receipts and events | `whatsappBroadcast/statusWebhook.ts`, wired in `http/whatsappWebhooks.ts` | Verifies `X-Hub-Signature-256` with the connection's own app secret, idempotent on Meta's 7 day repeats, forward-only, a failure never overwrites a delivery. 131050 records a permanent opt-out; restriction and quality codes pause the number; quality and disabled account events pause it. Also applies to chat messages. |
| Two-way chat | `backend/src/whatsappChat/*` | Inbound messages (text, button and list taps, media placeholders) stored encrypted per conversation, idempotent, unknown numbers get a conversation but are never added as contacts; STOP-style text still opts out. Replies, templates, approval requests (reply buttons in the window, template outside it) and list messages through the same gates as a broadcast. Saved audiences and short update lines (max 25 people, placeholder). |
| Routes | `http/routes/whatsappBroadcasts.routes.ts`, `whatsappChat.routes.ts`, `whatsappRouteGate.ts` | Dashboard only. Three flags exactly "true", platform visible, signed-in HUMAN (an API key gets 403 on every route), paid plan. Mounted once in `http/routes.ts`. |
| Boot | `index.ts` | 30 second sender timer (inert while off), retention purge in the 6 hourly privacy sweep, `WHATSAPP_SEND_ENABLED` in the boot log. `startupConfigCheck.ts` flags the send flag without its prerequisites. |
| Frontend | `frontend/src/components/dashboard/WhatsApp*.tsx`, `pages/dashboard/WhatsAppTab.tsx`, `lib/whatsappSend.ts`, `styles/whatsapp-chat.css` | Templates and sync, the customer's rate card, broadcast composer (template, values, preview, schedule), broadcast list ("N delivered of M, confirmed by Meta", cost shown as an estimate), inbox and thread with the window state, approval requests, approvals view, audiences and update lines. Same theme tokens as `whatsapp-contacts.css`. Polls with `usePolling` (no websockets). |
| Setup guides | `lib/byokGuides.ts`, `ByokGuide.tsx` | Collapsible numbered guides: WhatsApp (in the WhatsApp tab) and X (inside the X card of Settings > Custom developer keys). |

The generic "post to WhatsApp" path is untouched: `whatsappSendingSupported()` is still `false`, and a test proves it stays false with
every new flag on. `noPublicPath.test.ts` proves only the dashboard routers, the webhook handler and `index.ts` import the sender and chat
modules, and that MCP, Zapier, n8n, the SDK, the browser extension and the OpenAPI document never mention the routes.

## Environment names

New: **`WHATSAPP_SEND_ENABLED`** (default off, must be exactly `true`). Already added by PR 139 and still needed: `WHATSAPP_BYOK_ENABLED`,
`WHATSAPP_BROADCASTS_ENABLED`, `WHATSAPP_CONTACT_HASH_KEY`, `WHATSAPP_CONTACT_ENC_KEY`, `WHATSAPP_CONTACT_ENC_KEY_ID`,
`WHATSAPP_CONTACT_ENC_KEY_PREV` (optional, rotation), `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. The same encryption key now also protects chat
bodies, approval titles and conversation numbers. **There is deliberately no Meta or X token variable anywhere**; a source scan test fails
if the broadcast or chat code reads a token, secret or key from the environment. None of these is set anywhere by this branch.

## Rules from Werner that are enforced in code

1. **BYOK is permanent and mandatory.** `checkSendEligibility` (`byok.ts`) is the only way the broadcast and chat code obtains a login. Tests:
   free plan refused (real `resolveTier`), lapsed plan refused, starter and pro refused, no stored login refused, damaged or id-mismatched
   login refused, another account's connection not found, env variables named like Meta tokens are ignored, and no token/secret/key env read
   exists in the code. X code is unchanged apart from showing the guide.
2. **Free-form messages only inside Meta's 24 hour window; outside it an approved template.** `window.ts`, enforced server side in
   `chatSend.ts` (the composer only reflects it). A template can only go to a saved contact who opted in; a person who messaged first can be
   answered in the window and is never sent a template, never added to the contact list, never in a broadcast audience.
3. **All sends use the same gates:** paid plan, own login, unpaused number, DB kill switch, shared rolling cap, opt-out and suppression, contact
   storage keys. No public API, MCP, Zapier, bulk or duplicate path.
4. Approvals are a convenience record, not legal consent; the screens say so.

## Meta and X rules relied on, with sources (read 2026-10-16)

| Rule | Source |
|---|---|
| The 24 hour customer-service window opens when the user messages or calls and resets on each new user message; free-form "service messages" (text, interactive reply buttons, lists, media) only inside it; outside it only approved templates; a send response only means "accepted", delivery comes from webhooks; opt-in required | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages |
| Reply buttons: up to 3, button id max 256, title max 20 and unique, body max 1024; a tap arrives as `interactive.button_reply` with `context.id` | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages |
| List messages: up to 10 sections and 10 rows in all, button label max 20, body max 4096, row title and section title max 24, row id max 200, row description max 72; selection arrives as `list_reply` | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages |
| Template quick-reply buttons (text only, 25 characters, usable in any template, so allowed outside the window) arrive as `type: "button"` with `button.text`/`payload` and `context.id` | https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components and https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/button |
| Incoming message and status webhook shapes (`messages[]`, `statuses[]`, `pricing`, `errors`) | https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages |
| Direct developers use a System User access token; system user steps; the three permissions `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`; assign the app (Manage app) and the WhatsApp account | https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens and https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started |
| Developer registration, creating the app with the "Connect with customers through WhatsApp" use case, API Setup, where the account id and phone number id appear | https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started |
| X Developer Console (console.x.com), Create App (name, description, use case), the permission levels Read only / Read and write / Read, write and DMs, API Key & Secret, Access Token & Secret, shown only once, set the permission before generating the access token | https://docs.x.com/resources/fundamentals/developer-apps |
| Marketing templates are not delivered to US (+1) numbers; messaging limit tiers; scheduled sends are outside the window; error 131050 | The 2026-10-15 board-pass plan note (`03 - LazyRelay/plan-whatsapp-broadcasts-2026-10-15.md`), not re-read in this build |
| "Meta bills the customer's own WhatsApp Business Account directly; LazyRelay never pays for it" and the X equivalent | Already in the product's own text (`CustomPlatformSettings.tsx`) and the plan note (Option B). The guides use exactly that wording and promise nothing more. |

**Not confirmed by those pages, so the guides say "Check Meta's current screen" / "Check X's current screen" instead of stating it:** the token
expiry options (the brief asked for a token that never expires; Meta's page only says to "choose a token expiration preference"), the name Meta
now uses for the WhatsApp Business account ("Messaging account" in its newer pages), whether X needs a developer sign-up or a project first,
where X's permission setting sits, and the exact Meta webhook button names.

## What is NOT proven by tests

* **Every SQL object.** The repo has no SQL harness. The migrations are checked only as text. Not executed: the RLS policies, the column-level
  grants that hide ciphertext columns, the append-only trigger on `whatsapp_broadcast_status_events` (including the "delete allowed only when the
  parent recipient is gone" cascade assumption), `claim_whatsapp_broadcast_recipients` (plpgsql syntax, `for update of r skip locked`, the
  `#variable_conflict use_column` directive, the locking against a concurrent opt-out), both purge functions, the on-delete cascades. The sender
  tests use a **TypeScript model** of the claim function (`testKit.ts`), which proves the application logic, not the SQL.
* **Anything against live Meta.** Error-code lists (131050, 131048, 368, 131031, 130497, 131042, 131037, 132000 to 132016 and the transient set),
  the account event names (`phone_number_quality_update` FLAGGED/DOWNGRADE, `account_update` DISABLED_UPDATE and friends), the exact webhook field
  names, whether a template quick-reply tap carries our button id or only its text, Meta's behaviour when a request times out. All from
  knowledge of Meta's reference, none exercised. Unknown codes fall to "that recipient failed, not retried", which is the safe side.
* The race where Meta's receipt arrives before our "handed off" update is written (the receipt is then unmatched and Meta does not repeat it).
* Rendering. The components were tested with Testing Library and type-checked; they were **not opened in a browser**, so layout and the CSS
  (`whatsapp-chat.css`) are unreviewed by eye. The Apple layout review is the code-level checklist in the CSS header.
* Throughput, large audiences (the 500 row page loops and the 1000 row API default are not stress tested), and clock skew at the window edge.

## Decisions defaulted (change any of them; nothing here was asked of Werner)

| Decision | Default and why |
|---|---|
| Plan caps (D4) | **PLACEHOLDERS**: 250 recipients per broadcast, 2 broadcasts per 24 h, 250 messages per rolling 24 h (Meta's lowest tier), 25 people per update line. Global row seeded with the kill switch ON. A contact-count cap was not built (Werner has given no number). |
| Kill switch | Leaves a sending broadcast as "sending" (it waits and resumes when switched off). Plan, own-login and template problems pause the broadcast instead. |
| Retries | Only transient errors, at most 3, delays 1, 5 and 15 minutes. A request with no answer is never retried (it may have been sent); a stuck claim is failed as "unconfirmed" after 10 minutes. Chat sends are never retried automatically. Failed receipts never re-queue. |
| Opted-out people | Blocked from free-form chat replies too, not just marketing (stricter than Meta requires). Any scope of opt-out blocks. |
| Unknown numbers | Conversation kept (encrypted number, name, bodies) so they can be answered inside the window; 30 days after the last message; never a contact. |
| Retention | 30 days (D3's default) for conversations and for delivery rows of finished broadcasts; broadcast totals stay; the opt-out list is never purged. |
| Inbound chat flag | Chat storage needs `WHATSAPP_SEND_ENABLED` (there is no receive-only stage). |
| Approvals outside the window | Sent as the chosen approved template; the client's tap is matched only if the template has quick-reply buttons whose id or text equals one of the three options, otherwise it shows in the thread and the request stays pending. |
| Cost | Estimate = (delivered + read) times the customer's own price for the template's category. Meta's receipts give a category, never money. |
| List messages | Supported in the backend and API (`/conversations/:id/list`); there is no list composer in the UI. |
| STOP handling | Recorded by the older inbound handler (when the broadcast flag is on) and again by the chat path; both are idempotent. |

## Unrelated things noticed, not changed

* `whatsapp_messages` (migration 0127) stores inbound text in PLAIN text for AI triage. With chat on, each inbound text is also stored encrypted,
  so plain and encrypted copies coexist. Decide whether the old table should stop storing text once chat is live.
* The WhatsApp card in Settings still says "Publishing to WhatsApp is not available yet, so nothing will be sent through it." That is wrong once
  sending is switched on; it needs a conditional line (public site copy was not touched).
* Disconnecting a WhatsApp connection: this branch relies on the foreign-key cascades (connection to contacts, conversations, broadcasts) and
  was not checked against how disconnect is implemented elsewhere (PR 139 notes say contacts are deleted at once).
* The repo's `backend/.env` is absent in the worktree. Tests need four throwaway variables (see the TDD log); the main checkout's `.env` was not copied.

## Pre-enable checklist (all of these are still open)

1. Meta terms (D2): may a customer paste their own system-user token into a multi-customer app, or must LazyRelay be a Tech Provider? Written answer first.
2. Apply 0128, 0129, 0130 and 0131 **on a throwaway Supabase branch** and run the checks the repo cannot: opt-out always wins in both trigger directions; a
   browser role cannot select any ciphertext column; the status events table refuses update, delete and truncate but allows the cascade; two concurrent
   `claim_whatsapp_broadcast_recipients` calls never return the same recipient and a concurrent opt-out is not sent; a cancelled broadcast hands out
   nothing; the purge functions delete what they say; RLS isolates two accounts.
3. Set the secrets (hash key, encryption key and id, webhook verify token), then the flags in order: `WHATSAPP_BYOK_ENABLED`, `WHATSAPP_BROADCASTS_ENABLED`,
   `WHATSAPP_SEND_ENABLED`. The global `whatsapp_send_controls` row is seeded stopped: set real caps (D4), then switch the kill switch off by hand.
4. Phase 0 spike on a Meta test number: one real template send, receipt, STOP reply, 131050, a window-open reply and a button tap. Confirm the code lists and
   event names above against what Meta actually sends.
5. Update the Privacy Policy, DPA, Terms and Data Deletion pages (they never mention WhatsApp); counsel on POPIA, the attestation wording and indemnity.
6. Staging run of the security checklist; confirm no API key, MCP or Zapier path can reach a send or a chat read.
7. Open the screens in a browser (dark theme, narrow width, reduced motion) and look.
8. Keep the public count at 18 until WhatsApp really sends.
