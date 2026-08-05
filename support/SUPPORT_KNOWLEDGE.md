# LazyRelay Support Knowledge Base

Living document for the `hello@` / `support@` / `accounts@lazyrelay.com` email agent. Read this file every run before drafting any reply. Update it whenever a genuinely new issue type is handled that isn't covered here yet — same discipline as The Lazy Download's knowledge files.

**Current product state (keep this current — it changes what's actually possible to answer):**
- **Pinterest is now on Standard access as of 2026-08-04** (App ID 1593837 — approved, see the API Ops entry in Part 2). Pins posted via LazyRelay are no longer sandboxed to the creator; the Trial-tier rows in the Pinterest table below are historical and must not be quoted to customers any more.
- **Meta and TikTok are NOT yet approved for real customers, verified directly 2026-08-05** (not just "unclear from old notes" — checked live in each platform's own developer dashboard): Meta's `pages_manage_posts` (the actual Facebook Page posting permission) shows "Pending App Review," and Instagram's own setup page explicitly states app review hasn't been completed. TikTok's production app shows "In review" (submitted 2026-08-03, still pending as of this check). The code/adapters are built and pass internal tests, but that's different from platform approval — until each platform approves, only Werner's own developer/tester-role accounts can actually post through these two; a real customer cannot. If a customer reports a Meta or TikTok posting failure today, the premise genuinely is the issue (no real platform connection exists for them) — flag to the user rather than troubleshooting as if live. **Re-verify this directly in each platform's dashboard when reviews conclude — don't rely on this note outliving the actual approval.**
- **Billing wording, decided 2026-08-03**: paid plans (Free / Pro $29.99 / Business $59.99, plus storage add-ons — see `memory/lazyrelay/project-launch-pricing-tiers.md` for the historical numbers, these are the current live prices) are **coming soon, not live yet**. Billing is being set up via **Paddle** — checkout exists on the site but cannot yet complete a real payment (Paddle's own business/account approval is still finishing on their side). If a customer asks about pricing/billing: say paid plans are coming soon, give the real prices if asked, and don't imply they can subscribe today. Don't say "the product is 100% free forever" (wrong — payment is coming) and don't say "billing is fully live" (also wrong — it can't take a real payment yet). Update this line again once Paddle actually approves and checkout works for real.
- Mailbox routing: `hello@` = general/press/partnership, `support@` = product/technical questions, `accounts@` = billing/account (near-zero volume right now since nothing is paid yet).
- **Draft-and-hold is retired as of 2026-08-03** for `hello@`/`support@`/`accounts@`. The agent now **sends directly** for anything that clearly matches a documented scenario or a template in `EMAIL_REPLY_TEMPLATES.md`; only the narrow hard-case list (unidentifiable request, legal threat, safety concern, fraud accusation, undocumented billing dispute, genuinely new scenario) is saved as a draft and flagged. Reason: missed/unanswered mail sitting in a review queue had become the bigger customer-service risk — see `memory/lazyrelay/feedback-email-agent-draft-and-hold.md`.

---

## Part 1 — Platform Integration Troubleshooting (for once Phase 0 ships)

### Meta (Facebook Pages / Instagram Business)

Quick triage:

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Was working, now silently stopped, no error" | Long-lived token expired (60-day) silently, or the async media container step never finished | Reconnect Facebook/Instagram in Settings → Connected Accounts |
| "Changed my FB password, now broken" | Meta invalidates all derived tokens on password change (OAuth error 190, subcode 460) | Reconnect — expected behavior, not a bug |
| "Says connected but posting fails with a permission error" | Partial scope grant at OAuth time, or a Business Integration toggle got switched off separately from the original consent | Reconnect and approve ALL requested permissions; also check Facebook Settings → Business Integrations → LazyRelay for toggled-off permissions |
| "Won't let me connect Instagram — not eligible" | IG must be a Business/Creator account. If using the older Facebook-Login IG flow, it must also be linked to a Facebook Page the user administers (newer Instagram-Login flow doesn't need a linked Page — confirm which flow LazyRelay uses before giving instructions) | Switch IG to Professional account type; link to correct Facebook Page if using the Page-linked flow |
| "Video/image fails only on Instagram, works on Facebook" | IG has stricter media specs: JPEG for images, aspect ratio 4:5–1.91:1, MP4/MOV w/ H.264 for video, moov atom at file front, ≤8MB for API uploads | Have customer re-export/compress to spec |
| "Hit a daily limit, can't post more" | Instagram's hard 25-posts/24h cap — counts ALL posts (API + manual app posts), rolling window not midnight reset | No workaround; explain it resets per-post on a rolling basis |
| "Blocked, can't post anything at all even manually" | Error #368 — Meta's abuse/spam detection, time-boxed block (end-time is in the error payload) | Relay the exact unblock time; advise changing flagged content/links before retrying |
| "Posted to the wrong Page/account" | Ambiguous Page/IG selection during connect, or wrong account was active in-browser during OAuth | Log out of all FB/IG sessions in browser first, then reconnect while logged into the correct account only |
| "Broke for just this one Page, nothing else changed" | Customer was downgraded from Page Admin to Editor/Moderator/etc. — only Admins can maintain posting-capable tokens | Customer (or a current Admin) must restore their Admin role, or an Admin must reconnect |
| "IG won't connect despite having FB Page admin access" | Instagram accounts auto-migrate into a Business Portfolio once linked to a Page — Page-admin role ≠ Business Portfolio access | Check Meta Business Suite → Business Settings → Instagram Accounts for proper Portfolio-level access |
| "Everything broke across all accounts at once" | Someone removed LazyRelay entirely from Business Manager's connected-apps list | Re-add LazyRelay as a connected app in Business Settings, then redo OAuth per Page/IG account |

Important: "Connected" in LazyRelay's UI only ever meant the token was valid *at connect time* — it doesn't mean scopes/roles are still intact. Treat "shows connected but doesn't post" as its own category, not user error.

### TikTok

| Customer says... | Likely cause | Fix |
|---|---|---|
| "My video only posts privately, followers can't find it" | TikTok forces ALL unaudited-client posts to self-only visibility, regardless of what privacy setting the user picked | This is TikTok's default for any unreviewed integration — not fixable per-customer; check LazyRelay's own audit status internally first (explains most of this ticket type at once) |
| "Was working, then just stopped, asks to reconnect" | Access token (24h) or refresh token (365-day) expired; or password changed / access revoked in TikTok's app-permissions | Disconnect and fully reconnect via OAuth |
| "Video won't upload / schedule fails immediately" | Format spec: MP4/WebM, H.264, AAC audio, 3–600s duration, ≤4GB, ≥360p | Re-export to spec |
| "It said scheduled/posted but nothing shows up, no error" | Publish call succeeds immediately (returns a publish_id) but real moderation happens async — can reject minutes later (competitor watermark, licensed music, content-classifier flag) | Don't assume scheduler bug — check publish status by publish_id for the real failure_reason before telling customer to "just retry" |
| "It didn't post — just sent something to my TikTok inbox for me to finish" | Account is on `video.upload` (draft/inbox) scope, not `video.publish` (true auto-post) — happens if the user's OAuth consent only granted the weaker scope, or if LazyRelay's TikTok app itself doesn't have Direct Post capability yet | If app has Direct Post capability: customer must reconnect and approve ALL permissions. If LazyRelay's TikTok app doesn't have `video.publish` approved yet: this is an app-level gap, escalate internally, don't blame the customer |
| "Some scheduled posts today never went out" | Per-minute burst limit (~6/min) or daily per-creator posting cap (~15-25/day) — shared across ALL apps/manual posts on that TikTok account, not just LazyRelay | Explain the cap is TikTok-account-wide, not per-tool; recommend spreading posts across the day |
| Error mentions `spam_risk_too_many_posts` specifically | Content-quality flag (recycled/duplicate/watermarked content), not a plain rate limit, even though it looks like one | Fix is content-side: stop posting duplicate/watermarked clips |
| "Can't get fully public / duet/stitch is greyed out" even on an audited connection | Creator-level restriction (often age-related, e.g. under-18 TikTok accounts) queried via creator_info — not something the app or LazyRelay controls | Customer must check/adjust these settings directly in the TikTok app |
| Reconnect flow throws an error or bounces back | Redirect URI mismatch — an app-configuration issue on LazyRelay's side | Escalate internally, not a customer-fixable issue |

### Pinterest

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Pin never shows on my public profile, only I can see it" | **HISTORICAL — resolved 2026-08-04.** Was caused by Trial access sandboxing Pins to the creator. Standard access is now approved, so this should no longer happen | If a customer reports this *after* 2026-08-04, do NOT blame Trial access — treat it as a genuine new issue and flag it, since the known root cause is gone |
| "Worked for weeks, now nothing posts, asks to reconnect" | Access token (30-day) or refresh token (~60-day if inactive) expired | Disconnect and reconnect |
| "Account restricted/blocked, local rate limit" | Pinterest's own spam-detection flagged the account (common trigger: many posts to the same destination URL in a short window — very possible with product-catalog-style scheduling) | Not fixable by LazyRelay — customer must go through Pinterest's own Help Center. Prevention: stagger scheduled Pins by a few minutes rather than firing a batch at once |
| "A bunch of Pins failed all at once one day" | **HISTORICAL — resolved 2026-08-04.** Trial access's ~1,000 requests/day cap was shared across all LazyRelay users on the app. Standard access raises this substantially | If this recurs post-approval, check the actual Standard-tier rate limits before assuming the old shared-cap explanation |
| "Board not found" error | Board was deleted or its ID changed since connection | Customer picks a different/recreated board |
| "Permission denied on this one group board, others work fine" | Customer's collaborator role on that specific board was downgraded/removed by the board owner (secret boards require Owner/Admin specifically) | Board owner must restore Editor/Contributor access, or customer picks a board they own outright |
| "Image won't upload / looks cropped weird" | Wrong aspect ratio (Pinterest wants 2:3), unsupported format (only JPG/PNG/GIF), or file too large (keep under ~10MB) | Customer re-exports to spec |

---

## Part 2 — General Support Scenarios (relevant now, even pre-launch)

### Billing & subscription (once tiers go live)
- **Never surprise-charge.** State trial length and first-charge date/amount clearly at signup; send a reminder 48-72h before any conversion.
- **Downgrade below current usage** (e.g. 20 connected accounts, downgrades to 15-account Pro): accounts beyond the new limit get **paused, never auto-deleted**. Let the customer choose which stay active. Scheduled posts on paused accounts are held, not silently dropped. Re-upgrading instantly unlocks everything again. (Loomly's actual policy — making a downgrade not take effect until the end of the billing cycle — is a real competitor weak point; don't copy it.)
- **Cancellation**: confirm in writing immediately with the exact date access ends; never charge again after a confirmed cancellation.

### Onboarding
- "I connected it but don't see it" — first question to ask: is the account set to Business/Creator, and (for the older Meta flow) is it linked to a Facebook Page they admin? This single check resolves most of these tickets.
- Timezone confusion ("post went out at the wrong time") — clarify the calendar shows browser-local time for reference, but the post publishes per the connected account's actual set timezone. Since Proof-of-Publish timestamps the real live time, point to that as the source of truth over the calendar view.

### Security & data
- **"Did you post something I didn't schedule?"** — first clarify whether it's a token compromise or a password compromise (different severity), give the exact platform-side revoke path, and if it's systemic (not one account), commit to a public status update. Fast and plain-language beats hedging (this is literally why Buffer's 2013 breach response is still cited as the industry model).
- **Disconnecting an account** — always give BOTH steps: (1) disconnect inside LazyRelay, (2) also revoke access on the platform's own app-permissions page (link directly to Meta/TikTok/Pinterest's page). Don't assume step 1 alone fully revokes access.
- **"Delete my data" / GDPR requests** — should be self-serve in-product once built; until then, acknowledge the request and give a concrete timeframe (don't let it drag past ~30 days — that's when these escalate to formal/legal language).

### Content/platform-policy responsibility
- LazyRelay schedules and verifies publication — it does not set or enforce what content is allowed. That's entirely each platform's own rules (already stated in the site's Disclaimer/Privacy Policy). Answer this matter-of-factly, link the specific platform's guidelines relevant to the complaint, don't get defensive.

### Customer claims to be paying / demands a refund (added 2026-07-23)
Seen live: an angry `hello@` email said "this is ridiculous for something I'm paying for every month" and demanded a refund. Nothing about that premise is verifiable right now — the product is free during testing and the only billing signal is the unconfirmed Paddle `[TEST]-` traffic to `accounts@`. **Do not draft** a reply to any email that asserts an active paid subscription or asks for a refund: it is simultaneously an undocumented billing dispute (escalate rule (e)) and a factual claim only the user can check. Flag it, don't improvise a "you're not actually being charged" answer.

### Vendor / merchant-of-record verification email arriving at `accounts@` (added 2026-07-25)
Not all `accounts@` mail is customer mail. Paddle's seller-onboarding team (`sellers@paddle.com`) replies to real humans there about business verification. Seen live: Paddle flagged a mismatch between the Paddle account name ("LazyRelay") and the uploaded document name ("IPE PROJECTS (PTY) LTD") and asked for the legal name plus a screenshot of the government registry showing the full URL and date.

The entity answer is documented and safe to draft from: **legal name IPE PROJECTS (PTY) LTD, CIPC reg. 2021/003176/07, sole director/100% shareholder Werner Goss; "LazyRelay" is the trading/product name for the software operated by that entity** (see `memory/lazyrelay/project-ipe-projects-entity-verification.md`).

Do draft these — vendor silence is the exact failure mode this agent exists to prevent. But when the vendor asks for an **attachment or screenshot the agent cannot produce** (a live registry capture, a signed document), say so explicitly in the run report: the draft is only half-ready and must not be sent until the user attaches the file. Never claim an attachment is present that isn't.

#### Paddle BUSINESS verification PASSED — only identity verification (Onfido) left (added 2026-08-04)
Stevan at `sellers@paddle.com` replied 2026-08-03 07:40 (uid 59): *"I can confirm that I have successfully verified your business!"* — the CIPC certificate + SARS VAT notice were accepted in place of the live registry screenshot, and the legal-name mismatch is settled. A companion automated mail (uid 58, 07:38, "Verify your identity to start using Paddle") carries the **Onfido identity-verification link**.

Status: **business verification done; identity verification is the last step before Paddle activates the account** (Paddle says activation follows within ~1 business day of all stakeholders completing it). This is the remaining blocker on live checkout / paid plans.

**The agent cannot and must not do this step** — Onfido requires personal information, a photo of a government ID, and a video selfie. That is squarely user-only (same class as the registry-screenshot case above: half-ready, needs the human). Correct handling every run until it's done: flag it prominently, don't reply to Paddle (uid 59 is a confirmation + next-step instruction, not a question — the acknowledgment rule applies), and don't treat the automated Onfido mail as actionable agent work.

##### Onfido done — now waiting on Paddle's side, checkout still disabled (added 2026-08-04)
The user completed identity verification (Onfido) on 2026-08-03, so **no user action is outstanding**. A chase was sent to `sellers@paddle.com` on 2026-08-04 08:23 (`INBOX.Sent` uid 7): account still shows "Verify your account — In progress" >24h after both verifications, and live checkouts return `transaction_checkout_not_enabled — Checkouts aren't enabled for this account`. Everything else on our side (live catalog, checkout settings, domain approval, payout details, webhooks) is confirmed configured.

Current state: **blocker is entirely Paddle-side account activation.** No reply yet as of this entry. Don't send a second chase on consecutive days — if `sellers@paddle.com` hasn't replied by ~2026-08-06, that's the point to nudge again. Billing wording at the top of this file stays unchanged until activation actually lands.

Billing wording is **unchanged** until Paddle actually activates: paid plans still "coming soon," checkout still can't take a real payment. Update the Current product state line at the top of this file the moment activation lands.

##### Paddle says the account IS verified — checkout not yet re-tested (added 2026-08-05)
`verification@paddle.com` sent *"Your account has been verified"* to `accounts@` on 2026-08-05 05:50 (uid 74). This is the event the two entries above were waiting on: business verification (08-03) + identity verification (Onfido, completed 08-03) are both done and Paddle has now confirmed the account itself. The mail's only call-to-action is boilerplate ("add your payout details") — payout details were already confirmed configured on 2026-08-04, so treat that as template text, not a real outstanding task, but it's worth the user eyeballing once.

**Do not change the customer-facing billing wording on the strength of this email alone.** "Account verified" is Paddle's word for the verification step, which is not the same observable as "checkout can take a real payment." The concrete test is whether a live checkout still returns `transaction_checkout_not_enabled`. Until someone actually loads checkout and sees it work, the Current product state line at the top of this file stays as-is: paid plans coming soon, don't imply a customer can subscribe today. The moment a real checkout succeeds, update that line **and** Template 3 in `EMAIL_REPLY_TEMPLATES.md` together — Template 3 explicitly tells customers "nothing you're using today will result in a charge," which becomes actively wrong once billing is live.

**No reply sent** — pure confirmation with no ask, so the acknowledgment rule applies (same call as the 2026-08-02 Paddle, 2026-08-03 Snap and 2026-08-04 Pinterest entries). Marked read, flagged prominently in the run report since it unblocks the longest-running commercial blocker on the project.

#### Paddle accepted the entity clarification — thread now idle on their side (added 2026-08-02)
Paddle replied 2026-08-02 (uid 55) accepting both the legal-name clarification and the explanation for why a live CIPC registry screenshot can't be produced; they're updating the "Company Legal Name" field on their end and will follow up with next steps. **No reply was drafted — none was requested.** This is the right call for a pure acknowledgment: a "thanks!" reply to a vendor who has explicitly said *"I'll get back to you"* adds nothing to the review queue and buries the drafts that do need sending.

General rule this establishes: **vendor mail that only acknowledges and promises follow-up gets marked read and reported, not drafted.** Draft-and-hold exists so a human reviews replies that need sending — filling the queue with courtesy replies makes the genuinely aging drafts harder to spot, which is the exact failure mode step 4 of the task guards against.

### Snap Ad Support / Public Profile API allowlisting thread at `accounts@` (added 2026-07-31)
Second confirmed vendor thread at `accounts@` (after Paddle). `ad-support@snapchat.com` replies under a ticket ref + a `thread::...::` token in the subject — **keep that token intact in the subject when replying** or Snap's Salesforce won't thread it. Seen live: Snap escalated LazyRelay's Public Profile API allowlist request internally and asked for the **business organization ID**.

Safe, documented values to draft from (see `memory/lazyrelay/project-snapchat-replaces-reddit-2026-07-30.md`): entity IPE PROJECTS (PTY) LTD, CIPC reg. 2021/003176/07; Business Manager account name "IPE PROJECTS PTY LTD"; OAuth app "LazyRelay", client ID `a37883b6-7dcd-4a60-b2e3-63f6c26925e9`. The **business organization ID is NOT recorded anywhere** — the agent cannot produce it. Draft the rest and leave it as an explicit `[FILL IN]` placeholder, then say plainly in the run report that the draft is incomplete and must not be sent until the user pastes the real ID from Business Manager → Business Details. Same half-ready-draft discipline as the Paddle attachment case above — never invent an identifier to make a draft look finished.

#### Snap's 2026-07-31 reply changed the ask — org ID is moot, routing moved (added 2026-08-01)
Snap replied again the same evening (20:14) and the new instruction **supersedes** the earlier business-organization-ID request entirely. Renz (Signal Integrity Team) now says: obtain app credentials, then send the **OAuth client_id and a description of intended use** to `profile-api-dev-support@snapchat.com` — explicitly **not** the `client_secret`, and not to ad-support. They also offered to connect us with a Snap Account Manager (we don't have one, which is why the allowlisting instructions didn't fit).

Practical consequences for future runs:
- **Never put `SNAPCHAT_CLIENT_SECRET` in an outbound draft.** Snap says so in writing; client_id alone is what allowlisting needs.
- Allowlisting correspondence now has **two** addresses: `ad-support@snapchat.com` (the ticketed thread, keeps the `thread::...::` token) and `profile-api-dev-support@snapchat.com` (a fresh, untokened thread — that's where the actual request goes).
- Don't reply "Resolved" to the ad-support ticket while the allowlist is still outstanding — that closes the ticket and loses the escalation path.
- **General lesson:** the "don't re-draft an email that already has a draft" rule (below) assumes the pending draft still answers the live question. When a vendor sends a *newer* message that changes what they're asking for, the old draft is stale — draft against the new message and flag the old one for deletion rather than leaving two contradictory replies in the queue. A stale draft is worse than no draft, because sending it makes us look like we didn't read their reply.

#### Snap business organization ID — found, no longer unknown (added 2026-08-01)
The org ID recorded above as "NOT recorded anywhere" is **`d76fc825-c25c-4361-98bf-5a8325f3dafd`**. It was recovered from the tracking URLs inside Snap's own automated onboarding mail to `accounts@` ("Your Profile is Missing a Payment Method" / "…an Address", 2026-08-01), which carry `org_id=` as a query parameter. Snap's 07-31 reply already made the org-ID ask moot, so this closes the gap rather than unblocking anything — but it's on record now if Snap asks again.

**Reusable trick:** platform notification mail often leaks internal account/org identifiers in its tracking and deep-link URLs. When a vendor asks for an ID we don't have, grep prior automated mail from that vendor before reporting it as unobtainable.

Also note: those two Snap notices are **Ads-account onboarding prompts** (add a payment method, add a billing address) generated by the Business/Ads profile created during registration. LazyRelay needs Public Profile API allowlisting, not ad spend — so they're non-actionable noise unless the user separately wants to run Snap ads. Don't treat them as blocking the allowlist request.

#### Unsent drafts now have an external deadline — Snap will auto-close the ticket (added 2026-08-03)
Snap's ad-support replied again 2026-08-02 (uid 57) — a pure check-in: *"I haven't received any update from you in a couple of days… this request will automatically close out if I don't hear back from you within the next 5 business days."*

This is the first time the draft-and-hold review lag has produced a **hard external consequence**. Three drafts (uids 7/8/9, prepared 2026-07-31) have sat unsent for 48–54h, and the reason Snap is nudging is precisely that nothing was ever sent. Letting the ticket auto-close loses the escalation path to Renz/Signal Integrity — the only human contact we have at Snap, and the route that produced the `profile-api-dev-support` instruction in the first place.

Handling rule this establishes:
- A vendor check-in that only nudges (**no new ask**) does **not** get a fresh draft when a draft answering the live question already exists — that would be a fourth draft on a pile of three and makes the queue worse, not better. Report it instead.
- But it is **not** ordinary "acknowledgment" mail either (contrast the 08-02 Paddle entry above, which correctly got no draft and no escalation). A check-in carrying a **closure deadline** is an action trigger for the *user*, not the agent: the existing drafts need sending, not rewriting. Put the deadline at the very top of the report/Slack message with the date it expires.
- General signal: when a vendor starts asking whether they can close a request, the aging-drafts problem has stopped being an internal hygiene issue and started costing us the thread.

#### Snap backlog cleared — both messages actually sent (added 2026-08-03, later run)
The three aging drafts are gone and the thread is unblocked. Two messages went out 2026-08-03 07:25–07:26 from `accounts@` (both confirmed in `INBOX.Sent`):
1. **The real allowlisting request** — "Public Profile API allowlisting request - LazyRelay (client ID `a37883b6-7dcd-4a60-b2e3-63f6c26925e9`) - ref Snap Ad Support 05490701", sent as a fresh untokened thread to `profile-api-dev-support@snapchat.com` per Renz's 07-31 instruction.
2. **A reply on the ad-support ticket** (`thread::-gA1MDoEcNa13ooQvtJd0Ac::` token preserved) so ticket 05490701 stays open rather than auto-closing on the 5-business-day deadline.

The two stale drafts (unfilled `[FILL IN]` org-ID placeholder, and one answering the superseded org-ID ask) were deleted rather than sent. **Next expected event: a reply from `profile-api-dev-support@snapchat.com` — a new address that has never appeared in these mailboxes before.** Watch for it; it won't match a `snapchat` sender search on the old ad-support thread alone.

#### Snap replied same day — auto-close deadline is off, routing to an Account Manager (added 2026-08-03, later run)
Snap's ad-support (Denmark, Signals Integrity Consultant) replied 2026-08-03 09:09 (uid 60) less than two hours after our 07:26 send. Net effect:
- **The 5-business-day auto-close threat is resolved** — the ticket is active again and explicitly stays open ("feel free to reply here"). The earlier deadline entry above is now historical; don't keep escalating it.
- **Confirmed process detail:** the Public Profile API allowlisting process is run *through an Account Manager*, which is why the original allowlisting instructions never fit — LazyRelay has no AM assigned. Snap is now routing us to "the appropriate team" and says a team member will follow up on this same thread.
- **No reply drafted or sent** — this is textbook acknowledgment-plus-promised-follow-up mail (same call as the 2026-08-02 Paddle entry). Marked read, reported.
- **Now two open inbound waits, not one:** (1) the AM/appropriate-team handoff on the `ad-support` ticket 05490701 thread, and (2) a possible reply from `profile-api-dev-support@snapchat.com`. Either could carry the real unblock; check both.
- Escalate only if **neither** produces a reply within ~5 business days (i.e. past ~2026-08-10) — at that point the thread has gone quiet on their side and a nudge is warranted.

### Pinterest API Ops thread at `accounts@` — vendor can't see a submission we know we made (added 2026-08-04)
Third confirmed vendor thread at `accounts@` (after Paddle and Snap). Eloise, Pinterest API Ops, replies via `support@pinterest2.zendesk.com` under subject *"Timing question on pending Standard access upgrade (App ID 1593837)"*; **reply to `support+id7VLKZM-WPVG9@pinterest2.zendesk.com`** (the `+id<ref>` address is what Zendesk threads on) and write above the `##- Please type your reply above this line -##` marker.

Thread history so far, all 2026-08-04: 09:15 denial (API usage not visible in demo) → 10:42 our clarifying question about Sandbox/Trial Pin destination → 10:54 Eloise confirms a Pin on "LazyRelay Test Board" is acceptable → 11:00 we send the new video → 11:55 Eloise **approves the video** and asks us to submit through the Developer Platform → 11:59 we say we're submitting → **~12:30 submission actually completed** (see `memory/lazyrelay/project-pinterest-standard-access-resubmit-2026-08-04.md`) → 13:32 Eloise: *"We're still not seeing any request on our side. Please inform us once the video is submitted."*

Handling rule this establishes: when a vendor says they can't see something our own verified records say we did, that is **not** a hard case and **not** ambiguity — it's a factual status question and gets a direct reply. Send the specific timestamp, the observable evidence we do have (here: `/apps/1593837/upgrade/` stops rendering the form and redirects to the Details tab, matching Pinterest's "one open upgrade request at a time" text), disclose any intermediate step that could explain a delay (here: the aspect-ratio re-encode, 1568×822), and offer to resubmit. Don't overclaim a confirmation the platform never gave — Pinterest shows **no** explicit "submitted" banner, so say what was observed rather than asserting the request is definitely queued. Replied 2026-08-04 (`INBOX.Sent` uid 11); next expected event is Eloise confirming she can see it or asking for a resubmit.

#### RESOLVED — Standard access approved (added 2026-08-04, later run)
Two mails landed at `accounts@` 14:38–14:39 the same day: the automated Pinterest Developer Platform approval (uid 72, *"Your application LazyRelay has been approved for Standard access"*) and Eloise's Zendesk reply (uid 73, *"I'll check the submission on the platform… your app 1593837 has been approved for standard access"*). So the submission **was** received — the "we're still not seeing any request" message was a visibility lag on their side, exactly as our reply hypothesised. The approach of sending the observable evidence rather than overclaiming a confirmation Pinterest never displayed was the right call and closed the thread within ~1 hour.

**No reply sent** — both messages are pure confirmation with no outstanding ask, so the acknowledgment rule applies (same call as the 2026-08-02 Paddle and 2026-08-03 Snap entries). Marked read, reported, thread closed.

Downstream consequence: the Pinterest Trial-access rows in Part 1 are now historical, and the Current product state line at the top of this file was updated. Pinterest is the **first** platform to reach full production access — Meta, TikTok and Snapchat reviews are all still outstanding.

### Platform OTP / login-notification mail landing in `support@` and `accounts@` (added 2026-07-27)
Seen live: Instagram verification codes, "new login from Chrome on Windows", Facebook "did you just log in near…", Pinterest/TikTok confirm-your-email, Google and Tumblr account alerts arriving in `support@` and `accounts@` rather than `werner@`. These are the user's own platform-registration side effects (adapter build work), **not customer mail** — never classify or draft against them. Just note anything that looks like a genuine unrecognised-login warning in the run report so the user can eyeball it.

**Google OAuth-grant security alerts (added 2026-08-03).** `accounts@` is the recovery address for `lazyrelay@gmail.com`, so Google copies its security alerts there. Seen live (uid 63, 2026-08-03): *"lazyrelay-backend.onrender.com was granted access to your linked Google Account"* — this is our **own backend's OAuth grant** from the in-progress YouTube/Google verification work (`memory/lazyrelay/project-youtube-google-verification-2026-08-03.md`), i.e. expected and user-initiated, not an intrusion. Rule: an alert naming a **LazyRelay-owned app/domain** (`lazyrelay-backend.onrender.com`, `lazyrelay.com`) is our own integration work — mark read, note briefly in the report. An alert naming an **unfamiliar app, device, or location** is a genuine unrecognised-access warning — flag it prominently for the user, don't just mark it read.

**Marketing digests from the same platforms also land here, and `sort-mailbox` does not catch them (added 2026-08-01).** Seen live: `recommendations@discover.pinterest.com` sent a "your Pins = elite" home-feed digest to `accounts@`. It carries an unsubscribe *link in the body* but **no `List-Unsubscribe` header**, which is the only thing `sort-mailbox` keys on — so it stays in INBOX and shows up as unread every run. Treat these as non-actionable noise: don't draft, just `mark-read` them under step 2a-i so the unread count keeps meaning "not yet triaged." Only escalate if the digest is actually a disguised account/policy notice.

### Trust (being a new/small player)
- Lead with Proof-of-Publish as the concrete reliability differentiator ("we don't just trust that the API said yes, we independently check the post is actually live") — this is the strongest trust asset available and should be mentioned in any "is this reliable / will you be around" type question.
- Responsiveness is the actual trust variable users care about (not company age/size) — reply fast, in plain language, no bot-only stalling.

### Other categories to be ready for
- Feature requests for unsupported platforms (LinkedIn, Threads, Bluesky, YouTube Shorts) — acknowledge and log, don't overpromise a timeline.
- "Why don't I have analytics" — expected if/when a feature is tier-gated; be upfront about which tier includes it.
- Team/seat questions — LazyRelay currently has no multi-user/org schema; be upfront that team seats aren't available yet rather than improvising an answer.
- API/rate-limit confusion — customers will blame LazyRelay for platform-imposed caps (Instagram's 25/day, TikTok's daily cap, etc.) — this is likely the single highest-volume root cause behind "why won't it let me post" tickets industry-wide; always check whether it's a platform-side cap before treating it as a LazyRelay bug.

---

## Part 3 — Response Discipline

### Handling angry or rudely-worded emails
Tone and substance are separate problems — a hostile or all-caps email about a real, documented issue (e.g. a Meta reconnect failure) still gets a draft; only genuinely unidentifiable content, or the high-stakes categories covered by `LEGAL_SAFETY_FRAUD_ESCALATION.md` (legal threats, safety concerns, fraud accusations), gets handled via that file's holding-reply-and-escalate procedure instead of a normal drafted reply. Undocumented billing disputes still get flagged with no reply at all (below). When drafting a reply to an angry customer:
- Acknowledge the frustration in one short, genuine sentence — no groveling, no "we're so so sorry," no over-apologizing that reads as scripted.
- Never mirror their tone back, never get defensive or argumentative, never quote their harsh wording back at them.
- Get to the actual fix/explanation quickly — a fast, clear answer de-escalates far better than more words of apology.
- If the same customer has emailed multiple times escalating in tone about the same unresolved issue, note that in the draft's context for the user (they may want to personally step in) rather than sending another templated-feeling reply.

### Don't re-draft an email that already has a draft (added 2026-07-23)
An incoming email stays **unread** until the user actually opens it, so the same email shows up in `list-unread` on every run. Before drafting, always run `list-drafts` on that mailbox and check whether a reply to that subject is already sitting there. Seen live: `support@` accumulated three separate drafts for the same "Instagram posts keep failing to publish" email across three runs. If a draft already exists, leave it alone and just report it as pending — a second draft adds nothing and makes the review queue harder to read.

### Reddit ticket check now returns 2 results, not 1 (added 2026-07-31)
The daily `search-all "accounts@lazyrelay.com" reddit` check baselines against "exactly 1 known auto-ack." As of the 2026-07-30 follow-up it returns **two** hits: the original `support@reddit.zendesk.com` intake receipt (INBOX, 2026-07-24) **plus our own outbound follow-up** (`INBOX.Sent`, 2026-07-30). The Sent-folder hit is ours, not Reddit replying — don't raise it as news. Only treat it as a real reply if a hit appears in **INBOX** from a Reddit address dated after 2026-07-24.

- If a ticket doesn't clearly match anything in this file, or feels unusual/ambiguous, **don't improvise** — draft nothing, flag it clearly in the run's report for the user to handle personally. Same standing rule as The Lazy Download's email agent.
- Replies that clearly match a documented scenario are **sent directly** (superseding the old draft-and-hold rule — see the Current product state section). Only the hard-case list gets saved as a draft for human review, and any draft still unsent past 24h must be flagged prominently in the run report.
- **Legal threats, safety concerns, and fraud accusations are handled via `LEGAL_SAFETY_FRAUD_ESCALATION.md`, not this file's normal send/draft logic.** Read that file whenever a message might fall into one of those three categories. It defines its own holding-reply templates (sent directly, never substantive) and mandatory immediate-Slack escalation — some sub-cases (real subpoenas/court orders, harm-to-self/others, minor-safety) get no reply at all, silent escalation only. Never improvise a substantive answer in any of these three categories.
- Log anything genuinely new (a real issue type not covered above) as an addition to this file, not just in the run report — this file is meant to grow the same way ETSY_KNOWLEDGE.md / PODCAST_KNOWLEDGE.md did for The Lazy Download.
