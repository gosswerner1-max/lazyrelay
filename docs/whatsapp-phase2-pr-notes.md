# WhatsApp broadcast sending and two-way chat (Phase 2): PR notes

Branch `feature/whatsapp-broadcast-send`, built on PR 139 (`feature/whatsapp-contacts-consent`, commit `821b315`). **Nothing is applied,
pushed, deployed or switched on.** No real Meta call was made, no network to Supabase, no real token or secret exists in any file. Every
flag defaults off. TDD evidence (RED then GREEN for every step) is in `docs/whatsapp-phase2-tdd-log.md`.

## UPDATE 2026-10-16 (branch `fix/whatsapp-byok-no-caps`): BYOK means LazyRelay puts no volume cap and no kill switch on WhatsApp or X

Werner's rule: WhatsApp and X are bring-your-own-key. The customer pays Meta and X directly with their own token, so **LazyRelay limits
nothing on these two platforms and has no switch of its own that stops them**. The only product restriction is the **plan gate**: any paid
plan (Starter, Pro, Business, Agency, Agency Plus), Free and lapsed refused. Everything below supersedes the older sections where they differ
(those sections are corrected in place, but read this one first). Step by step RED/GREEN evidence: `docs/whatsapp-nocaps-tdd-log.md`.

**Consequence to accept:** with our caps gone, a customer bug or abuse is stopped only by (1) Meta's and X's own limits and quality systems,
(2) the three env rollout flags, (3) the Meta-driven pause below, and (4) our HTTP abuse limiting (not a volume cap). There is no LazyRelay-side
brake on how many people a customer messages or how often.

### What was removed (exact list)

| Kind | Removed |
|---|---|
| Table | `whatsapp_send_controls` (migration 0130, never applied): the DB kill switch, the global row seeded STOPPED, per-account override rows, its two unique indexes, RLS, policy, revoke and grants |
| Columns (all lived in that table) | `scope`, `account_id`, `kill_switch`, `max_recipients_per_broadcast`, `max_broadcasts_per_day`, `max_messages_per_day`, `note`, `updated_at`, and its three check constraints |
| Seed | the row `('global', null, true, 250, 2, 250)` |
| Check values | `kill_switch`, `cap_reached`, `send_disabled` from `whatsapp_broadcasts.pause_reason` (it is now `connection_unavailable`, `connection_paused`, `template_unusable`, `plan`) |
| Functions and types | `loadControls`, `EffectiveControls`, `countMessagesAcceptedSince`, `countBroadcastsSince` (file `whatsappBroadcast/controls.ts` deleted; the Meta pause functions moved to `connectionPause.ts`: `getConnectionPause`, `pauseConnection`, `resumeConnection`); `MAX_UPDATE_RECIPIENTS` (the 25 person update line) |
| Rules in code | recipients per broadcast 250, broadcasts per day 2, rolling 24 h message cap 250 shared by broadcasts and chat, 25 people per update line, global and per-account kill switch in the sender, chat send, broadcast creation and the routes, the "10 batches per cycle" ceiling, the 500 member slice when adding to an audience |
| Refusal codes | `cap_recipients`, `cap_broadcasts`, `cap_messages`, `sending_stopped`, `controls_unavailable`, `audience_too_large`; the 503 and 429 cap answers of the route gate; `stopped` from `GET /whatsapp/send-capabilities` (now `{ sending }` only) |
| Frontend | every cap, limit, kill switch, "switched off", "up to 25" and `PLACEHOLDER` wording; the disabled state tied to them; the composer and update lines accept any audience size |
| Env names | **none existed** for caps or the kill switch (they were database rows), so no env name was removed. Still present and kept: the three rollout flags |
| Found in the final audit and also removed | the webhook readers silently **dropped** messages after the 200th in one delivery (`MAX_MESSAGES_PER_DELIVERY` in `whatsappWebhooks.ts`, `MAX_PER_DELIVERY` in `whatsappChat/inbound.ts`) and receipts after the 1,000th (`MAX_RECEIPTS_PER_DELIVERY` in `statusWebhook.ts`). Meta batches up to 1,000 updates per request (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/, read 2026-10-16), so up to 800 real customer messages per batch could be lost for good because we had already answered 200. Fixed test first |
| Also fixed so "any audience size" is true | audience members are read page by page (the API returns at most 1,000 rows a read), member counts use count queries, adding members works in chunks |

Tests: the cap tests were deleted; added `noCaps.test.ts` (source scan, fails if a cap or kill-switch table, column, seed, function or code returns),
`noCapsBehavior.test.ts` (1,000 recipients accepted, 12 broadcasts in a day, 600 messages in one cycle, 300 chat messages in 24 h, an update line to
100 contacts, a 1,500 member audience), `noPlatformCaps.test.ts` (final audit guard, see below), and frontend `noLimitWording.test.ts`.

### What was kept, and why (none of these is a LazyRelay cap)

| Kept | Why |
|---|---|
| Env rollout flags `WHATSAPP_BYOK_ENABLED`, `WHATSAPP_BROADCASTS_ENABLED`, `WHATSAPP_SEND_ENABLED` (exactly `true`, default off) | Rollout flags until the data-safety gates in the checklist are done. They switch the FEATURE on or off for everyone; they are not a limit on a customer's volume. Remove them when the gates are done |
| Plan gate and the BYOK-only rule | The one product restriction. Customer's own stored token required, no platform token, no fallback |
| Consent, opt-out, suppression, the 24 hour window | Law and Meta policy, not volume |
| Meta-driven protection | The customer's number is paused on a Meta restriction, ban, quality or rejected-credential code (`metaErrors.ts`, `connectionPause.ts`), never retried into a restriction, and the customer lifts the pause. Transient errors retry at most 3 times (1, 5, 15 minutes) |
| Meta's format limits | 3 reply buttons, list row sizes, template rules, text 4,096, and the +1 marketing block |

### Plan gate report (single checks)

The WhatsApp check is `checkWhatsappPlan` (`accountLimits.ts`) over `resolveTier` and `canUseWhatsappByok` (`tier.ts`); X own keys is
`canUseXByok` (`tier.ts`) used by the X routes and `GET /platforms`. The frontend never decides: every lock reads the backend's `allowed`.
`resolveTier` is Free when there is no subscription row or the status is not `active` or `trialing`, and fails closed when the plan cannot be read.

| Tier | X own keys | WhatsApp own token |
|---|---|---|
| Free | refused (HTTP 403 on X, 400 on WhatsApp, with the upgrade message) | refused |
| Lapsed (cancelled, canceled, past_due, paused, unpaid, incomplete, expired, empty) on any tier | refused | refused |
| Starter | allowed | allowed |
| Pro | allowed | allowed |
| Business | allowed | allowed |
| Agency | allowed | allowed |
| Agency Plus | allowed | allowed |

Proven by `backend/src/byokPlanGate.test.ts` (61 tests: every tier, every status, the SQL file), the X route matrix in `xByok.routes.test.ts`, the
WhatsApp matrices in `whatsappByok.routes.test.ts`, `whatsappWebhookInfo.routes.test.ts`, `whatsappBroadcast/byok.test.ts`, and loops over every route
by every paid tier and every lapsed status in `whatsappBroadcasts.routes.test.ts` and `whatsappChat.routes.test.ts`. Frontend: the lock note and the
tile read "Available on any paid plan." and "Upgrade to Starter" (`lib/byokPlanLock.test.ts`, the Settings and Social Platforms suites).

**New unapplied migration `0132_byok_paid_plan_gate.sql`** replaces the two database trigger functions (0125 WhatsApp, 0126 X) so the database
backstop lists the same five tiers. Until it is applied the database would still refuse Starter and Pro (and, for WhatsApp, Pro) even though the
backend allows them, so **apply 0132 with 0128 to 0131**. The backend recognises both the old and the new database messages.

### The disclaimer notice

A modal opens on every attempt to connect X keys or a WhatsApp token, before any request: on **Check my keys / Check my credentials** (they send the
credentials too) and on **Save and connect**, in Settings > Custom developer keys (X card, WhatsApp card) and on the `/connect/x` page. Continue runs
the request once; Cancel, Escape and a click on the backdrop do nothing and send nothing. The sentence is exactly:
"Please verify the limits, throttling constraints, and coverage of your respective Meta Developer or X Developer plans. LazyRelay does not control, limit, or throttle usage on these external platforms."
Files: `components/ByokDisclaimerModal.tsx` (reuses the app's dialog pattern from `MastodonServerModal`), `lib/byokDisclaimer.ts`,
`styles/byok-disclaimer.css`, test `components/dashboard/ByokDisclaimer.test.tsx` (22 tests). `vite.config.ts` lets that one stylesheet be read as text by its own test.
Opened in a browser on `/connect/x` (desktop and a 375 px phone): renders, dialog and focus correct, Escape closes it, focus returns to the button, no request
sent. **Not opened in a browser: the Settings cards (they need a signed-in dashboard), reduced-motion and reduced-transparency rendering.**

### Final audit: every remaining limit that touches X or WhatsApp

Proof there is no cap, throttle or kill switch of ours on X own-keys or WhatsApp use: `noPlatformCaps.test.ts` (X and WhatsApp have no entry in the rolling
24 hour post limits; every numeric limit constant in the X and WhatsApp code is on a fixed classified list, so a new one fails the test until classified; no
per-day, per-month, quota or throttle names anywhere in that code), plus `noCaps.test.ts` for the broadcast and chat code.

| Limit | Class |
|---|---|
| Template, text, button, list, approval and phone number lengths and counts; the 3 transient retries and delays (`cloudApi.ts`, `templates.ts`, `approvalOptions.ts`, `phone.ts`, `metaErrors.ts`) | (a) Meta protocol rule |
| X key and media rules, X's own 402 and 429 answers that we only report (`platforms/x*.ts`) | (a) X protocol rule |
| `WHATSAPP_WEBHOOK_PER_IP_PER_MINUTE` 600, `WHATSAPP_WEBHOOK_GLOBAL_PER_MINUTE` 6,000, `WHATSAPP_WEBHOOK_MAX_BYTES` 3 MB, `tieredRateLimit` on every route, the 5 per 15 minutes and 10 per 15 minutes limits on the save, check and remove routes, 15 failed credential checks a day per account (`X_BYOK_FAILED_VALIDATIONS_PER_DAY`, `WHATSAPP_BYOK_FAILED_VALIDATIONS_PER_DAY`: a guard against guessing keys, it counts only credentials the platform rejected), `MAX_IMPORT_ROWS` 5,000 and 2 MB per contact import request (a request size, the number of contacts in total is unlimited, import in several files) | (b) our HTTP abuse limiting. Note: the 6,000 a minute global webhook limit is above any realistic Meta delivery rate but is the one (b) item that could refuse legitimate inbound if a very large number of customers were connected; Meta retries |
| **Connected-account slots**: `ACCOUNT_LIMITS` free 3, starter 20, pro 30, business 50, agency 100, agency plus 150, plus the 30 day distinct-account limit (`accountLimits.ts`), checked by `checkAccountLimit` and `checkNewDistinctAccountLimit` in both the X and the WhatsApp save routes | (c) plan limit. **Connecting X or WhatsApp still consumes one connected-account slot of the plan. This was not changed.** It limits how many accounts are connected, not how much is sent through one |
| Schedule window 1 minute to 30 days, template paging 10, worker batch sizes (`DEFAULT_BATCH_SIZE` 20, `HAND_OFF_LIMIT`, `SENDING_LIMIT`: a cycle takes up to this many broadcasts and the rest wait for the next 30 second cycle, nothing is dropped and the loop claims until a broadcast is finished), field length limits, per-message AI text cut at 1,000 characters | (e) a format or input bound that is not a volume limit (added class, because it fits none of a to d) |
| `WHATSAPP_TRIAGE_DAILY_CAP` 200 AI triage runs per account per UTC day (`whatsappWebhooks.ts`) | **Kept on purpose, flagged for Werner.** It bounds LazyRelay's own Anthropic bill for an optional AI feature that is itself off unless `WHATSAPP_INBOUND_TRIAGE_ENABLED=true`. It does not limit WhatsApp use: the message is stored before the allowance is checked, so no message is ever refused or held because of it. Anyone can text a connected number, so without it a stranger could run up our AI bill. If Werner wants it removed it is one line, and then the AI cost has no brake. The notice sentence stays true either way (it is about the platforms, not our AI) |
| (d) real leftover caps | Three found and **deleted**: the per-delivery message and receipt drops described above. None remains. Nothing could not be removed |

### Public-facing files touched (smallest factual edit: "Pro and above" or "Business and above" became "any paid plan"; no new claims)

| File | Change |
|---|---|
| `frontend/public/guides/x-developer-keys/index.html` | Six places (meta description, og description, twitter description, JSON-LD description, page subtitle, the "available on" line): "on Pro, Business, Agency and Agency Plus" / "Pro and above" became "on any paid plan" |
| `backend/src/support/chatKnowledge.ts` (what the support chat tells customers) | X own keys: "Pro, Business, Agency and Agency Plus plans (not Free or Starter)" became "any paid plan (not on Free)"; one code comment |
| `backend/src/platformRules.ts` (feeds the public API and MCP docs page) | WhatsApp: "(Business plan and above)" became "(any paid plan)", and the plan note |
| In the product | tile title, lock note and upgrade label (`SocialPlatformsTab.tsx`, `lib/whatsappByok.ts`, `lib/xByok.ts`), server messages (`accountLimits.ts`, `xByok.routes.ts`, the WhatsApp route messages) |
| Internal, not public | `support/SUPPORT_KNOWLEDGE.md` (X row), `SERVICE_PROVIDERS.md` (X line), `backend/.env.example`, code comments |

Searched and **not** changed because they make no such claim: `llms.txt`, `frontend/public/pricing`, the comparison pages, `homeFaq.ts`, `Landing.tsx`, the Terms and
refund pages, the changelog. WhatsApp is not mentioned in `llms.txt`, the pricing page, `homeFaq.ts` or `Landing.tsx`; the support chat knowledge mentions it only as not released yet. Public copy was not otherwise touched.

## What is built (original Phase 2 description; where it mentions caps, a kill switch or a plan floor, the update above wins and the lines are corrected)

| Area | Where | What it does |
|---|---|---|
| Migration 0129 | `backend/supabase/migrations/0129_whatsapp_templates_rate_cards.sql` | `whatsapp_message_templates` (copied from the customer's own Meta account, approved and supported only are sendable) and `whatsapp_rate_cards` (the customer's own prices, for a cost ESTIMATE). RLS on, browser roles read-only, service role writes. |
| Migration 0130 | `0130_whatsapp_broadcasts.sql` | (no send controls table: there is no cap and no kill switch) `whatsapp_connection_send_state` (per-number pause), `whatsapp_broadcasts`, `whatsapp_broadcast_recipients` (by contact id, no number, keyed hash of Meta's message id), append-only `whatsapp_broadcast_status_events`, and the plpgsql `claim_whatsapp_broadcast_recipients()` (claim and opt-out check in one statement, skip-locked). |
| Migration 0131 | `0131_whatsapp_chat.sql` | `whatsapp_conversations`, `whatsapp_chat_messages` (bodies AES-256-GCM encrypted), `whatsapp_approval_requests` (title encrypted), `whatsapp_audiences` and members, 30 day purge functions for chat and for broadcast delivery rows. Column-level grants hide every ciphertext column from browser roles. |
| Sender loop | `backend/src/whatsappBroadcast/sender.ts` | Separate from the post scheduler. Sweeps crashed claims, hands due broadcasts off, re-checks every gate each cycle, claims small batches, re-checks consent and opt-out immediately before each message, sends the approved template with the customer's own token. |
| Cloud API client | `whatsappBroadcast/cloudApi.ts` | `sendTemplate`, `sendText`, `sendInteractiveButtons`, `sendInteractiveList`, `listTemplates`. HTTP client is injected (tests never touch a network); the production client refuses any host but `graph.facebook.com` and never follows redirects. |
| BYOK gate | `whatsappBroadcast/byok.ts` | A send needs a paid plan (the repo's `checkWhatsappPlan` / `resolveTier`: free and lapsed plans are refused; every paid tier is accepted) AND the customer's own stored login (their token, WABA id and phone number id from Vault) AND a healthy, unpaused connection. There is no env token and no fallback. |
| Meta pause | `whatsappBroadcast/connectionPause.ts` | Only the Meta-driven pause of one connection (restriction, quality, rejected credential, policy). No caps, no kill switch. |
| Receipts and events | `whatsappBroadcast/statusWebhook.ts`, wired in `http/whatsappWebhooks.ts` | Verifies `X-Hub-Signature-256` with the connection's own app secret, idempotent on Meta's 7 day repeats, forward-only, a failure never overwrites a delivery. 131050 records a permanent opt-out; restriction and quality codes pause the number; quality and disabled account events pause it. Also applies to chat messages. |
| Two-way chat | `backend/src/whatsappChat/*` | Inbound messages (text, button and list taps, media placeholders) stored encrypted per conversation, idempotent, unknown numbers get a conversation but are never added as contacts; STOP-style text still opts out. Replies, templates, approval requests (reply buttons in the window, template outside it) and list messages through the same gates as a broadcast. Saved audiences and short update lines (any audience size). |
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
   free plan refused (real `resolveTier`), lapsed plan refused, every paid tier accepted, no stored login refused, damaged or id-mismatched
   login refused, another account's connection not found, env variables named like Meta tokens are ignored, and no token/secret/key env read
   exists in the code. X code is unchanged apart from showing the guide.
2. **Free-form messages only inside Meta's 24 hour window; outside it an approved template.** `window.ts`, enforced server side in
   `chatSend.ts` (the composer only reflects it). A template can only go to a saved contact who opted in; a person who messaged first can be
   answered in the window and is never sent a template, never added to the contact list, never in a broadcast audience.
3. **All sends use the same gates:** paid plan, own login, number not paused by Meta, opt-out and suppression, contact
   storage keys. No cap and no kill switch of ours. No public API, MCP, Zapier, bulk or duplicate path.
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
| Plan caps (D4) | **Decided by Werner: there are none.** BYOK, so Meta's and X's own limits apply and LazyRelay adds none. The old placeholder numbers and the seeded kill switch row are gone. |
| Kill switch | **None.** A Meta pause leaves a sending broadcast waiting until the customer lifts it. Plan, own-login and template problems pause the broadcast instead. |
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
2. Apply 0128, 0129, 0130, 0131 and 0132 **on a throwaway Supabase branch** and run the checks the repo cannot: opt-out always wins in both trigger directions; a
   browser role cannot select any ciphertext column; the status events table refuses update, delete and truncate but allows the cascade; two concurrent
   `claim_whatsapp_broadcast_recipients` calls never return the same recipient and a concurrent opt-out is not sent; a cancelled broadcast hands out
   nothing; the purge functions delete what they say; RLS isolates two accounts.
3. Set the secrets (hash key, encryption key and id, webhook verify token), then the flags in order: `WHATSAPP_BYOK_ENABLED`, `WHATSAPP_BROADCASTS_ENABLED`,
   `WHATSAPP_SEND_ENABLED`. There is no controls row to set. Also apply `0132_byok_paid_plan_gate.sql` with 0128 to 0131 so the database gate matches the backend.
4. Phase 0 spike on a Meta test number: one real template send, receipt, STOP reply, 131050, a window-open reply and a button tap. Confirm the code lists and
   event names above against what Meta actually sends.
5. Update the Privacy Policy, DPA, Terms and Data Deletion pages (they never mention WhatsApp); counsel on POPIA, the attestation wording and indemnity.
6. Staging run of the security checklist; confirm no API key, MCP or Zapier path can reach a send or a chat read.
7. Open the screens in a browser (dark theme, narrow width, reduced motion) and look.
8. Keep the public count at 18 until WhatsApp really sends.
