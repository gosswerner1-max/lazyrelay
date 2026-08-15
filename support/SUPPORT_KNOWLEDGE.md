# LazyRelay Support Knowledge Base

Living document for the `hello@` / `support@` / `accounts@lazyrelay.com` email agent. Read this file every run before drafting any reply. Update it whenever a genuinely new issue type is handled that isn't covered here yet — same discipline as The Lazy Download's knowledge files.

**Current product state (keep this current — it changes what's actually possible to answer):**
- **Pinterest is now on Standard access as of 2026-08-04** (App ID 1593837 — approved, see the API Ops entry in Part 2). Pins posted via LazyRelay are no longer sandboxed to the creator; the Trial-tier rows in the Pinterest table below are historical and must not be quoted to customers any more.
- **Meta and TikTok are NOT approved for real customers** (state below verified 2026-08-12 evening against the day's own vault record, superseding the "outcome unknown" wording this line carried earlier the same day):
  - **Meta — RESUBMITTED 2026-08-13, in review.** The 08-12 rejection (6 of 7 permissions, all citing *"Screencast Not Aligned with Use Case Details"*) has been actioned: the missing Page/IG picker was built and shipped 08-12, the demo video was re-recorded, and all six permissions were resubmitted 2026-08-13 (submission ID 1665142864580358, portal shows "Review in progress"; Meta says most reviews finish within 20 days). So Meta is **no longer "rejected, not resubmitted"** — it's awaiting a verdict, same state as TikTok. Don't promise a timeline.
  - **TikTok — APPROVED 2026-08-14, posting is live.** `noreply@dev.tiktok.com` sent *"Your app is approved!"* to `accounts@` at 10:14 UTC (uid 116), closing the third submission (08-12). App ID 7666018240841254930. The app requests `video.publish` (Direct Post) and Direct Post was already proven working end-to-end during the 08-12 demo recording, so **treat TikTok as live for customers** — troubleshoot reported failures against the Part 1 table rather than the "not live yet" premise-mismatch reply. See the 08-14 entry in Part 2 for the full evidence chain and the one remaining confirmation (a real post from a non-developer account).
- **YouTube — Google OAuth verification APPROVED 2026-08-14.** `api-oauth-dev-verification-reply+15csgvdem6kka1d@google.com` wrote to `accounts@` at 14:27 UTC (uid 117): *"We've approved your OAuth App Verification request for project 978463501573 (Project ID: lazyrelay)"* for exactly `.../auth/youtube.readonly` and `.../auth/youtube.upload` — the two scopes the adapter actually requests. **This is the third platform to production approval, after Pinterest and TikTok**, and it arrived ~1 day after the 08-13 T&S reply rather than the 4-6 weeks Google's own panel predicted. Practical effect: the *"Google hasn't verified this app"* interstitial that every connect flow hit should now be gone for real customers, and the adapter itself was already proven end-to-end on 08-13 (real upload → confirmed live → channel name read back via `youtube.readonly`). **Treat YouTube as live for customers.** Two cheap confirmations still worth having, neither a blocker: one real connect+post from an *ordinary* (non-developer) account, and one glance at the OAuth consent screen showing the verified state. See the 08-14 entry in Part 2.
  Meta's code/adapters are built and pass internal tests, but that's different from platform approval — until Meta approves, only Werner's own developer/tester-role accounts can actually post through it; a real customer cannot. If a customer reports a Meta posting failure today, the premise genuinely is the issue (no real platform connection exists for them) — flag to the user rather than troubleshooting as if live. **Re-verify this directly in each platform's dashboard when reviews conclude — don't rely on this note outliving the actual approval.**
- **BILLING IS LIVE as of 2026-08-11** (superseding every "coming soon" instruction previously on this line). A real checkout completed at **2026-08-11 07:31 UTC** — Paddle sent both a receipt (uid 99) and a subscription confirmation (uid 100) from `help@paddle.com` to `accounts@`, for a live Mastercard-backed subscription renewing 2026-09-11. That is the concrete observable the 08-05/08-07 entries were waiting on: checkout no longer returns `transaction_checkout_not_enabled`. Customers **can** subscribe today and **can** be charged.
- **Current live tiers and prices (verified 2026-08-11 against `frontend/src/pages/Landing.tsx` and `backend/src/tier.ts`, not from memory):** Free $0 / **Starter $29.99** / **Pro $59.99** / **Business $99.99** per month, plus storage add-ons. **The old "Pro $29.99 / Business $59.99" wording that used to sit on this line was stale** — tier naming was restructured 2026-07-23 (Free/Pro/Business → Free/Starter/Pro/Business) and prices rose 2026-07-31, so quoting the old pair got both the names and the Business price wrong. Note the DB values lag the display names on purpose: DB `pro` displays as **Starter**, DB `business` displays as **Pro**, DB `enterprise` displays as **Business** (see the comment block at the top of `backend/src/tier.ts`). Always quote the **display** names to customers.
- Because billing is live, a customer claiming to have been charged is now **plausible and verifiable** — see the updated "Customer claims to be paying" guidance in Part 2, which changed materially on 2026-08-11.
- Mailbox routing: `hello@` = general/press/partnership, `support@` = product/technical questions, `accounts@` = billing/account (near-zero volume right now since nothing is paid yet).
- **Draft-and-hold is retired as of 2026-08-03** for `hello@`/`support@`/`accounts@`. The agent now **sends directly** for anything that clearly matches a documented scenario or a template in `EMAIL_REPLY_TEMPLATES.md`; only the narrow hard-case list (unidentifiable request, legal threat, safety concern, fraud accusation, undocumented billing dispute, genuinely new scenario) is saved as a draft and flagged. Reason: missed/unanswered mail sitting in a review queue had become the bigger customer-service risk — see `memory/lazyrelay/feedback-email-agent-draft-and-hold.md`.

---

## Part 1 — Platform Integration Troubleshooting (for once Phase 0 ships)

### Meta (Facebook Pages / Instagram Business)

Quick triage:

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Was working, now silently stopped, no error" | Long-lived token expired (60-day) silently, or the async media container step never finished | Reconnect Facebook/Instagram from the **Accounts** tab (always visible in the top nav, no menu needed — NOT "Settings", that tab doesn't exist) |
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

### Billing & subscription (billing live as of 2026-08-11)
- **Never surprise-charge.** State trial length and first-charge date/amount clearly at signup; send a reminder 48-72h before any conversion.
- **Downgrade below current usage** (e.g. 20 connected accounts, downgrades to 15-account Pro): accounts beyond the new limit get **paused, never auto-deleted**. Let the customer choose which stay active. Scheduled posts on paused accounts are held, not silently dropped. Re-upgrading instantly unlocks everything again. (Loomly's actual policy — making a downgrade not take effect until the end of the billing cycle — is a real competitor weak point; don't copy it.)
- **Cancellation (real mechanics as of migration `0043_cancel_at_period_end.sql`, 2026-08-11): access does NOT end immediately.** Cancelling sets a pending-cancellation flag — the subscription stays fully `active` and access continues until the real, current paid period ends, at which point it drops to Free automatically once the genuine `subscription.canceled` webhook lands. No further charge happens after cancelling. Cancelling is self-serve from the dashboard's Billing tab (real-time, no agent involved) — never quote a specific end date yourself in an email, since this file/agent has no live database access; point the customer to their own Billing tab, which shows the real date live. Use Template 14 in `EMAIL_REPLY_TEMPLATES.md` for any cancellation-related email.

### Onboarding
- "I connected it but don't see it" — first question to ask: is the account set to Business/Creator, and (for the older Meta flow) is it linked to a Facebook Page they admin? This single check resolves most of these tickets.
- Timezone confusion ("post went out at the wrong time") — clarify the calendar shows browser-local time for reference, but the post publishes per the connected account's actual set timezone. Since Proof-of-Publish timestamps the real live time, point to that as the source of truth over the calendar view.

### Proof-of-Publish sharing (shipped 2026-08-08)
Any scheduled post that has been independently verified live now has a **public share link** — a "Share proof" button on the post in the dashboard generates a link to `lazyrelay.com/verify/:id`, a no-login page showing the post genuinely went live (this is the same Proof-of-Publish check, just made shareable). Good answer for "how do I prove to a client/boss this actually posted."

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Share proof button is greyed out / missing" | Post hasn't been verified live yet (still scheduled, still verifying, or verification failed) | Only verified-live posts can be shared — check the post's own status first |
| "Can my Zapier/agent/API integration generate these links automatically?" | By design, API keys **cannot** generate share links unless that specific key has "Allow this key to generate public proof-sharing links" checked — off by default | Customer creates a new API key (or the existing one, if they still have the secret) with that box checked on the **API Keys** tab (click **More** in the top nav first — it's inside that menu, not always visible). Logged-in dashboard use is never gated by this — only programmatic/API-key access is |
| "I shared a link and it 404s" | Either the post ID is wrong, or it wasn't actually verified live (link only ever renders for verified-live posts — this is intentional, not a bug) | Confirm the post shows "verified live" in the dashboard before troubleshooting further |
| Anything about what the verify page *shows* | It's read-only, public, and only ever shows verification status + timestamp — never account details, platform post IDs, or error messages | No action needed, that's the intended design (safe to share externally) |

### Failure alerts / email notifications (shipped 2026-08-08)
Opt-in email notifications when a scheduled post fails for good (all retries exhausted) or when an account gets auto-paused. **Off by default** — customer must turn it on themselves on the **Account** tab (click **More** in the top nav first — Account is inside that menu, not one of the always-visible tabs), checkbox: "Email me if a scheduled post fails". Sent from `noreply@mail.lazyrelay.com`.

**Careful**: "Account" (the customer's own profile/settings, behind More) and "Accounts" (their connected social platforms, always visible) are two different tabs with near-identical names — always say which one you mean, don't just say "the Account(s) tab".

| Customer says... | Likely cause | Fix |
|---|---|---|
| "I didn't get an email when my post failed" | Setting is off by default — most customers haven't turned it on yet | Point them to the **Account** tab (under **More**) → "Failure alerts" |
| "I turned it on but got nothing" | Alerts only fire on a *terminal* failure (retries exhausted) or an account-pause event — a single retry attempt failing doesn't trigger one (by design, to avoid noise) | Confirm the post actually reached final-failed state, not just "retrying" |
| "Can I turn this off" | Yes, same toggle, un-check it | — |

### Sign-up/login CAPTCHA — Cloudflare Turnstile (shipped 2026-08-08)
Turnstile runs in managed/invisible mode on sign-up and sign-in — most real users never see a visible checkbox or challenge at all, it just runs silently in the background. This is expected, not broken.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "I don't see any captcha, is it working?" | Normal — Turnstile's managed mode only shows a visible challenge to suspicious traffic; invisible pass-through is the common case | Reassure it's working as intended |
| "Says success/nothing happened when I click login, no error" | This is very likely the browser's own native "Please fill out this field" validation on an empty email/password box, not a Turnstile failure — confirmed while testing this feature live | Have them check they actually filled in both fields before submitting |
| "Captcha error / verification failed" at submit | Genuine Turnstile failure (stale token, ad blocker/privacy extension interfering, or the token expired from sitting on the page too long) | Refresh the page and retry; if using a strict privacy/ad-blocking extension, try disabling it for lazyrelay.com |

### Comment/DM triage — "needs attention" filter (shipped 2026-08-08)
On top of the existing Mentions and DMs tabs, each comment/conversation now gets an AI badge (Angry customer / Sales question / Question) when it looks like it genuinely needs a reply, plus a "Show only the N that need attention" checkbox above each list. Off by default (unchecked) — the full list still shows everything, exactly as before, unless the customer turns the filter on themselves.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Why isn't every comment flagged?" | Working as intended — routine content (praise, emojis, spam, bot replies) is deliberately left unflagged so only real "needs a human" items stand out | Explain it's a filter for genuine questions/complaints/leads, not a moderation or spam tool |
| "A comment I care about wasn't flagged" | AI classification isn't perfect, and it only ever looks at the single comment/DM text shown, not the surrounding thread | The comment still shows in the normal (unfiltered) list, nothing is hidden or deleted, only the badge/filter is a suggestion |
| "The badge/count didn't update after I opened the tab" | Classification runs once per comment/conversation and is cached — it only re-classifies a DM conversation when a new message actually arrives (existing comment text never changes, so comments classify once for good) | Refresh the tab; if a genuinely new message still isn't reflected, escalate as a real bug |
| "Is this reading/storing what my customers say to me?" | Only the comment/DM text itself is sent to the AI for classification (via Anthropic), and only the classification result (flag + one-line reason) is stored — not the original comment/message content | Safe, factual answer if asked about data handling here |

### Proof-of-Publish webhook (shipped 2026-08-08)
A technical customer can set a webhook URL on the **Account** tab (click **More** in the top nav first — Account is inside that menu). LazyRelay POSTs a signed event to it the moment a post's Proof-of-Publish check confirms it's genuinely live (success only, not on failure). Aimed at customers wiring LazyRelay into their own systems, or a tool like Zapier/n8n/Make.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "How do I verify the webhook is really from LazyRelay?" | Every delivery is signed (HMAC-SHA256 of the raw JSON body, in the X-LazyRelay-Signature header) using the secret shown once when the webhook was set up | Recompute the HMAC on their end with their stored secret and compare; if they lost the secret, they can generate a new one from the same Account page (this invalidates the old one) |
| "I didn't get a webhook for a post that failed" | Working as intended, this webhook only fires on success (verified live), never on failure — failure has its own separate opt-in email alert | Point them to the Failure alerts toggle if they also want failure notifications |
| "I didn't get a webhook even though the post succeeded" | Delivery is a single fire-and-forget attempt with no retry, so a receiving endpoint that was down/erroring at that exact moment genuinely misses it | Confirm the post is actually marked verified/live in the dashboard first; if it is and the endpoint was up, that's worth escalating as a real bug |
| "Can I get more than one webhook, or webhook on failure too?" | Not currently, one webhook URL per account, success-only | Log as a feature request, don't overpromise a timeline |
| "I lost my secret / need to rotate it" | The secret is only ever shown once at creation, by design | They can regenerate it themselves from the same Account page, no need to also change the URL |

### Content coach / "Get ideas" button (shipped 2026-08-08)
In the compose form, a "Not sure what to post? Get ideas" button (above the existing topic field) generates 5 AI post ideas, grounded in the account's business name and its own recent posts. Clicking an idea just fills the topic field, it doesn't post anything or write the final caption by itself.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "The ideas aren't relevant to my business" | Ideas are grounded only in the business name field and recent post history, there's no separate industry/niche field today | Suggest they fill in Business Name in Account settings if it's blank or vague; otherwise this is a known current limitation, log as feedback |
| "It gave me the same ideas as before" | Ideas are freshly generated each click, not cached, but if the account has few/no recent posts there's less signal to vary against | Not a bug, more post history naturally improves variety over time |
| "Clicking an idea didn't create a post" | Working as intended, an idea only fills the topic field, the customer still reviews/generates a caption and hits Schedule themselves | Explain the flow: idea -> topic field -> Generate with AI (optional) -> review -> schedule |
| "Does this count against my AI generation limit?" | Yes, same daily quota as caption/hashtag generation, since it's a customer-initiated generate action | Point to the same daily-limit messaging used for captions/hashtags if they hit it |

### Multi-brand support (shipped 2026-08-08)
A customer running more than one business through LazyRelay can label each connected account with a brand name (Dashboard → Accounts → the text field next to each account, then Save). A "Brand" filter dropdown then appears on Overview, Posts, Calendar, Analytics, Mentions, and DMs to narrow each view to just one brand. This is a label and filter only, one login, one subscription, exactly as before, not a separate workspace or separate billing per brand.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Can I get a separate login/subscription per brand?" | Not what this feature is, it's a filter on the existing single account, not multi-tenant workspaces | Explain clearly so they don't expect separate billing or separate team access per brand, that's a bigger ask, log as feedback |
| "I don't see the brand filter dropdown" | The filter only appears once at least one connected account has a brand label set | Have them label at least one account first, in Accounts |
| "I labeled an account but posts aren't showing up filtered" | The filter is opt-in per view; each tab has its own dropdown defaulting to "All brands" | Check the dropdown at the top of that specific tab is actually set to the brand they expect |
| "What happens to an account I haven't labeled yet?" | It shows under the "Unbranded" option in the filter, and always shows under "All brands" | Reassure nothing is hidden or lost, just uncategorized until labeled |
| "Does labeling an account change what it can post to / connect to?" | No, brand_label is purely organizational metadata, doesn't affect posting, connections, or permissions at all | Safe to reassure this is cosmetic/organizational only |

### "Why this worked" AI insight (shipped 2026-08-08)
On the Analytics tab, a "Get AI insight: why this worked" button compares the customer's best- and worst-performing posts in the currently selected date range/brand and generates a short note on what differs plus one concrete suggestion for the next post.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "It says not enough data yet" | Needs at least 4 posts with real engagement numbers in the selected range, posts too fresh haven't collected engagement yet | Explain the threshold, suggest widening the date range (7/30/90 day picker) or checking back after more posts have had time to collect metrics |
| "The insight seems vague / says the pattern isn't clear" | Working as intended, the AI is instructed to be honest rather than force a pattern that isn't really there in a mixed or low-signal sample | Not a bug, this is deliberate honesty over a confident-sounding guess |
| "Does this run automatically / will I get spammed with insights?" | No, on-demand only, click the button each time, never runs automatically per post | Reassure it's opt-in each time, not a background feature |
| "Does this count against my AI generation limit?" | Yes, same daily quota as captions/hashtags/content ideas | Point to the same daily-limit messaging if they hit it |
| "Does it respect my brand filter?" | Yes, whatever brand filter is set on the Analytics tab when they click the button is what the insight is generated from | Confirm the right brand is selected before generating if they expected a different result |

### Security & data
- **"Did you post something I didn't schedule?"** — first clarify whether it's a token compromise or a password compromise (different severity), give the exact platform-side revoke path, and if it's systemic (not one account), commit to a public status update. Fast and plain-language beats hedging (this is literally why Buffer's 2013 breach response is still cited as the industry model).
- **Disconnecting an account** — always give BOTH steps: (1) disconnect inside LazyRelay, (2) also revoke access on the platform's own app-permissions page (link directly to Meta/TikTok/Pinterest's page). Don't assume step 1 alone fully revokes access.
- **"Delete my data" / GDPR requests** — should be self-serve in-product once built; until then, acknowledge the request and give a concrete timeframe (don't let it drag past ~30 days — that's when these escalate to formal/legal language).
- **"What happens to my data if I cancel?" (added 2026-08-15)** — real, live policy: cancelling does NOT delete anything immediately. Access continues until the end of the paid period, then **30 days after that**, posts and uploaded media are permanently deleted (reminder email sent 7 days before, at the 23-day mark). Resubscribing before the 30 days are up cancels the deletion — nothing is lost. This is the one place in the whole product data ever gets deleted automatically; hitting a storage quota while still subscribed still just blocks new uploads, never deletes anything. See Terms of Service ("Cancellations and refunds") and the Data Deletion page for the exact customer-facing wording — answer from those, don't paraphrase differently.

### Content/platform-policy responsibility
- LazyRelay schedules and verifies publication — it does not set or enforce what content is allowed. That's entirely each platform's own rules (already stated in the site's Disclaimer/Privacy Policy). Answer this matter-of-factly, link the specific platform's guidelines relevant to the complaint, don't get defensive.

### Customer claims to be paying / demands a refund (added 2026-07-23)
Seen live: an angry `hello@` email said "this is ridiculous for something I'm paying for every month" and demanded a refund. Nothing about that premise is verifiable right now — the product is free during testing and the only billing signal is the unconfirmed Paddle `[TEST]-` traffic to `accounts@`. **Do not draft** a reply to any email that asserts an active paid subscription or asks for a refund: it is simultaneously an undocumented billing dispute (escalate rule (e)) and a factual claim only the user can check. Flag it, don't improvise a "you're not actually being charged" answer.

### AI support-widget escalations arriving at `accounts@` (added 2026-08-10)
New inbound channel, first seen live 2026-08-10 17:51 (uid 97). The on-site AI support widget hands off conversations it can't resolve by emailing `accounts@` from **`"LazyRelay Support Widget" <noreply@mail.lazyrelay.com>`**, subject **"Support widget escalation"**, body containing the verbatim user/assistant transcript. Three things future runs must know:

1. **It arrives already marked read** — it did not appear in `list-unread`. Fourth confirmed instance of that process gap (after Reddit anticipated, Snap uid 95, TikTok uid 96). The `search-all <mailbox> "@"` date sweep is what catches it. Do not drop the sweep.
2. **It carries NO customer email address** — not in the headers, not in the body (verified by extracting every address in the message: only the SES message-ID, `accounts@`, and `noreply@`). So the escalation is **unreplyable as delivered**: nobody, agent or human, can answer the customer from this mail alone. The customer must be identified from the app's own support-widget/conversation records. Treat this as a product gap worth fixing, not an agent limitation to work around.
3. **The footer is wrong** — it ends with *"You're getting this because you turned on failure alerts in your LazyRelay dashboard's Account settings."* That's the failure-alert footer (see the Failure alerts section above) pasted onto an internal escalation mail. Cosmetic, but it makes an internal mail look like a customer notification.

**Classification rule:** classify by the escalated conversation's *content*, exactly as if the customer had emailed directly — the widget wrapper changes nothing. A widget escalation whose content is a documented scenario is still a documented scenario; one whose content is a hard case is still a hard case. Never reply to `noreply@mail.lazyrelay.com` — it's an unmonitored sender.

**First live instance was a hard case and got no reply:** the escalated conversation was a customer stating *"I was charged twice this month and I want a refund immediately, this is unacceptable"* — the exact "customer claims to be paying / demands a refund" case below, i.e. undocumented billing dispute (escalate rule (e)), no reply, flag to the user. See the 2026-08-10 note appended to that section for why this one is more serious than the 07-23 original.

#### Widget escalations also land at `support@`, not just `accounts@` (added 2026-08-11)
The 08-10 entry above was written from a single instance that arrived at `accounts@`. The second instance (2026-08-11 10:30, `support@` uid 23) landed at **`support@`** instead — same sender, same subject, same wrong failure-alert footer. So the widget routes by the conversation's own topic, not to one fixed mailbox. **Check every customer-facing mailbox for `"LazyRelay Support Widget" <noreply@mail.lazyrelay.com>`, not just `accounts@`.** Everything else in the 08-10 entry held exactly: it arrived unread this time, but still carried **no customer email address** (verified again by extracting every address in the message — only the SES message-ID, `support@`, and `noreply@`), so it is still unreplyable as delivered.

#### Widget escalations reach `hello@` too, and now DO carry a customer email (added 2026-08-11, later run)
Four more escalations landed within ~25 minutes (`hello@` uid 3, `support@` uids 24/25, `accounts@` uid 105), and they change two things the 08-10 and 08-11 entries above state as fact:

1. **All three customer-facing mailboxes are confirmed destinations.** The 08-11 entry added `support@` to `accounts@`; `hello@` uid 3 completes the set. Sweep all three for `"LazyRelay Support Widget" <noreply@mail.lazyrelay.com>` — routing follows the conversation's topic, so no mailbox is exempt.
2. **"Unreplyable as delivered" is no longer universally true.** The body now opens with an explicit `Customer:` identity line, and in three shapes seen live:
   - **Logged in** — `support-esctest-...@lazyrelay.invalid (logged in, account 89467935-e86f-4baa-ac2c-74f7d8783f3d)`: address *and* account UUID.
   - **Anonymous but self-reported** — the widget asks for name/email and the customer gives it, so it appears in the transcript (`hello@` uid 3 "Marcus Webb", `accounts@` uid 105 "Priya Nair"). The header flags it as unverified: *"no verified session, but self-reported … read the full transcript to confirm name/email before replying."*
   - **Anonymous, nothing captured** — the original 08-10/08-11 case, still occurs (`support@` uid 25).

   So the product gap is **partially closed**, not closed: treat a self-reported address as a lead to verify, never as an authenticated identity, and never send account-specific or billing information to one.

**Recognising the user's own test traffic.** All four of these were Werner verifying the escalation path, and the markers are worth knowing because a *real* one is commercially significant (see the vendor-security-review note below): two carried a literal `[TEST - James verification, please ignore]` prefix, and every address used an RFC 2606 reserved TLD — `.invalid` and `.example` (`marcus.webb@northgate-test.example`, `priya.nair@acmecorp-test.example`). Those TLDs are **non-routable by definition**, so a reply could never be delivered regardless. Handle test traffic exactly like the real thing — the compliance rule below doesn't bend — but don't report it as an inbound buying signal.

**The wrong footer is still unfixed** — all four again end with the failure-alert line ("You're getting this because you turned on failure alerts…"). Six confirmed instances now, still cosmetic, still makes internal mail look like a customer notification.

### Security / compliance questionnaires (SOC 2, HIPAA, GDPR DPA, pen-test reports) — hard case, never answer (added 2026-08-11)
First seen live 2026-08-11 via a widget escalation to `support@` (uid 23): *"Are you SOC 2 certified and HIPAA compliant? We need this for our vendor security review."*

**This is a hard case under rule (c), and it is not a close call.** A compliance answer is a **binding representation about the business**, not a support fact — an incorrect "yes" is a misrepresentation a buyer's security team will rely on contractually, and even an incorrect "no" can lose a deal that a real answer (e.g. "not certified, here's our actual security posture") would have won. Nothing in these support docs establishes LazyRelay's certification status, and **the agent must not infer it from company size or from the absence of a note.** Do not answer, do not hedge, do not improvise a "we take security seriously" reply — that reads as a dodge to exactly the audience asking.

Handling: **no reply, escalate to Werner via Slack, flag in the report.** Applies to every variant — SOC 2 Type I/II, ISO 27001, HIPAA/BAA, PCI, a GDPR Data Processing Agreement request, a completed security questionnaire (VSAQ/CAIQ/SIG), or a request for pen-test results or a subprocessor list. Route it to Werner even when the answer looks obvious.

**The widget itself handled this correctly** — it declined to speak to compliance with authority and said the team would follow up by email. That's the right behaviour and shouldn't be "fixed." The gap is downstream: it promised an email follow-up on a channel that captures no email address, so the promise cannot be kept from the mail alone. Until the widget captures an address, these must be answered from the app's own conversation records.

**Worth noting for the user, not for a customer:** a vendor security review means someone is evaluating LazyRelay as a business supplier — a buying signal, and the first one of its kind. Losing it to an unanswerable escalation is a real commercial cost, which is what makes the missing-address gap urgent rather than cosmetic.

### Customer claims to be paying — RESOLVED, charges are now real (added 2026-08-11)
The two entries below (07-23, 08-10) were both written while billing was not live, so a payment claim was an unverifiable or untested premise. **That gap is now closed: billing went live 2026-08-11 and real charges exist.** A customer saying they were charged is now most likely simply telling the truth.

What changes, and what doesn't:
- **Never again tell a customer they cannot have been charged.** The 08-10 entry already flagged that wording as an overclaim; it is now flatly wrong. Also check whether the on-site widget still says it — that string is driven by the `BILLING_LIVE` flag in `backend/src/support/chatKnowledge.ts`, which was still `false` as of 2026-08-10 and should be flipped now that checkout is confirmed. **Verify the flag's current value before assuming either way.**
- **A refund or double-charge dispute is still a no-reply hard case**, for a different reason than before: it's no longer "the premise is unverifiable," it's "a real money dispute needs the user's own decision and a look at the actual Paddle transaction record." Escalate rule (e) still applies.
- **A plain pricing/plan question is now ordinary work** — use Template 3, which was rewritten 2026-08-11 for live billing.

### Customer claims to be paying — now materially more plausible than in July (added 2026-08-10, superseded 2026-08-11)
The 2026-07-23 entry below was written when the only billing signal was unconfirmed Paddle `[TEST]-` traffic, so "you can't be being charged" was a near-certain premise. **That is no longer a safe assumption.** Paddle stated in writing on 2026-08-06 that the account is live and checkouts are enabled (see the 08-07 entry), and **nobody has yet run the live-checkout test that would confirm or refute it**. A double-charge claim arriving now sits precisely in that untested gap.

Consequences:
- **Still no reply, still escalate** — the handling is unchanged, and if anything the case for not improvising is stronger.
- **Never tell a customer they can't have been charged.** The widget's own auto-reply on 2026-08-10 said *"there's no way to be charged"* — that was true under the documented state but is now an overclaim, since the state is untested. That wording is driven by the `BILLING_LIVE` flag in `backend/src/support/chatKnowledge.ts` (still `false`); flipping it is already on the user's list for 2026-08-11 once checkout is confirmed. Until then the widget will keep asserting this to customers.
- This raises the priority of the outstanding live-checkout test sitting with the user: it now determines whether a customer billing complaint is a misunderstanding or a real charge.

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

##### Paddle states in writing that checkouts ARE enabled — needs one live test to confirm (added 2026-08-07)
Rita at `sellers@paddle.com` replied 2026-08-06 13:52 (uid 82), answering our 08-04 chase directly: *"I've just double-checked, and, on our end, your account is live and checkouts are enabled."* She also apologised for the delay (unusually high request volume on their side).

This is a materially stronger statement than the 08-05 *"Your account has been verified"* mail — it names the exact observable we've been blocked on rather than the verification step. But it is still **Paddle's assertion, not our observation**, and the 08-05 entry's rule stands unchanged: the concrete test is whether a live checkout still returns `transaction_checkout_not_enabled`. The agent cannot run that test (it's a product/browser check, not an email action), so the billing wording at the top of this file and Template 3 in `EMAIL_REPLY_TEMPLATES.md` **stay as-is until a real checkout is loaded and seen to work**.

**Action sitting with the user:** load a live checkout once. If it completes, update the Current product state billing line **and** Template 3 together in the same pass — Template 3 currently tells customers "nothing you're using today will result in a charge," which becomes actively wrong the moment billing is live. If it still errors, reply to this thread (uid 82) with the exact error string and timestamp — the same evidence-not-overclaim approach that closed the Pinterest thread in ~1 hour.

**No reply sent** — Rita's message answers our question and carries no ask, so the acknowledgment rule applies. Replying before we've actually tested checkout would just be a courtesy mail; replying *after* a failed test carries real information. Marked read, escalated to Slack as a vendor status change needing the user's decision.

##### CONFIRMED — a live checkout completed, billing is genuinely live (added 2026-08-11)
The test that every entry since 08-05 has been waiting on has now happened, and it worked. Two mails from `help@paddle.com` landed at `accounts@` at **2026-08-11 07:31 UTC**: a **receipt** ("Your receipt from IPE PROJECTS (PTY) LTD", uid 99) and a **subscription confirmation** ("Your subscription to IPE PROJECTS (PTY) LTD", uid 100). This ran on Paddle's **Live** environment, not sandbox — no `[TEST]-` prefix, real tax breakdown, real customer-portal tokens, `sub_01kzqvqxqk2deab5x80sfmx5ma`, Mastercard ending 8192, renewing 2026-09-11 07:31 UTC.

**Precision that matters: no money actually moved.** This was a **$0 checkout** run by the user personally on `werner@lazyrelay.com` using a `LIVETEST100` 100%-discount code (see `Active Priorities.md` in the vault, which tracks the full cutover). The `$29.99 / $26.08 + $3.91 VAT` figures in the mail are the **next** payment — Paddle's "Summary of your next payment" block — not a charge that was captured today. Don't describe this to anyone as a completed sale. What it proves is the thing that was actually in doubt: **a live checkout completes end-to-end** (Paddle Live → checkout → webhook → our DB → dashboard), so the `transaction_checkout_not_enabled` blocker is genuinely gone and a paying customer can now subscribe and be charged for real.

Corroborating context from the same morning, all consistent with the user running the end-to-end test himself: `werner@` received LazyRelay's own "Confirm your email address" signup mail at 07:25 (uid 36), and `accounts@` sent a message to `sellers@paddle.com` at 08:00 (`INBOX.Sent` uid 17) that opens *"Our account just went live"* and asks whether the locked **Company Display Name** field can be changed from "IPE PROJECTS (PTY) LTD" to "LazyRelay" without triggering a new review cycle. So the receipt was already seen and acted on by the user before this run.

**Actions taken this run, per the standing instruction on the Current product state line:** that line was rewritten (billing live, correct tiers), and **Template 3 in `EMAIL_REPLY_TEMPLATES.md` was rewritten in the same pass** — it previously told customers *"nothing you're using today will result in a charge,"* which became actively false at 07:31 this morning. That paired update was pre-authorised by the 08-05 entry precisely so this wouldn't lag.

**Stale-pricing trap this exposed, worth generalising:** the billing line and Template 3 both still quoted *"Pro $29.99 / Business $59.99"* — wording frozen from before the 2026-07-23 tier restructure and the 2026-07-31 price increase. Both the **names and the Business price** were wrong (real: Free $0 / Starter $29.99 / Pro $59.99 / Business $99.99). It read plausibly because $29.99 and $59.99 are both still live prices — just attached to different tiers now. **Rule: never quote a price or tier name to a customer from these support docs alone. Verify against `frontend/src/pages/Landing.tsx` (display prices) and `backend/src/tier.ts` (name mapping) first** — the DB values deliberately don't match the display names, so a plausible-looking tier name in a doc is not evidence.

**The AI support widget is already correct — checked, not assumed.** `BILLING_LIVE` in `backend/src/support/chatKnowledge.ts` now reads `true` (verified 2026-08-11), so the widget serves *"PLANS (live, customers can subscribe today)"* and no longer tells customers there's no way to be charged. The user flipped it as part of this morning's go-live. Nothing outstanding here.

**Still open:** Paddle's answer on the Company Display Name question (our thread sent 08:00 today) — receipts currently show the legal name "IPE PROJECTS (PTY) LTD" rather than "LazyRelay", which is a real customer-recognition risk on card statements and receipts (an unrecognised name on a statement is a classic chargeback trigger). Watch `accounts@` for `sellers@paddle.com`'s reply.

###### Second checkout run, then both test subscriptions cancelled — the cancel path is confirmed too (added 2026-08-11, later run)
Four more `help@paddle.com` mails landed at `accounts@` after the 07:31 pair, all the user's own go-live testing continuing:
- **08:35–08:36** — a *second* live checkout, this time on the **LazyRelay Storage Add-on** ($2.99/mo, `sub_01kzqzd17sf61sc3qbs0y1xcdy`, same Mastercard ending 8192): subscription confirmation (uid 101) + receipt (uid 102).
- **08:46–08:47** — **both** test subscriptions cancelled: LazyRelay Starter $29.99 (uid 103, `txn_01kzqvhj8t4dvz1znna13t2t99` — the 07:31 one) and the Storage Add-on $2.99 (uid 104, `txn_01kzqz9sjt2ze0sm0hjgfadxxd` — the 08:35 one). Both cancelled **immediately**, not at period end ("no longer have access… as your billing cycle ended on Aug 11, 2026 8:46 am UTC").

**What this adds beyond the 07:31 entry:** that entry proved checkout completes. This proves the **add-on purchase path and the cancellation path also work end-to-end on Paddle Live**, and that the account is now back to a clean state with no live test subscription running. Same caveat as before — **no money moved**, these were $0/discounted tests run by the user on his own account. Don't describe any of it as a sale.

**No reply, none possible** — `help@paddle.com` is Paddle's transactional sender, not the seller-support thread (`sellers@paddle.com`). Marked read, reported, no Slack: this is the user's own testing, not a vendor status change needing a decision.

Unchanged and still open: Paddle's answer on the **Company Display Name** question (our 08:00 send, `INBOX.Sent` uid 17) — receipts still show "IPE PROJECTS (PTY) LTD" rather than "LazyRelay". All four mails above confirm it, so the customer-recognition/chargeback risk noted this morning is real and still live.

###### Company Display Name — Paddle confirmed it's safe, change requested (added 2026-08-12)
Diana at `sellers@paddle.com` replied 2026-08-12 02:52 (uid 106), answering the 08-11 08:00 question. Her answer: **Company Display Name is a buyer-facing branding field, separate from Company Legal Name.** Changing it "should not, by itself, change your legal entity, account ownership, or verification status" and "should not trigger a new verification cycle, provided we are only updating the display/trading name and not changing the legal company name, ownership, registered business details, or product/domain setup." She then asked whether we'd like it set to **LazyRelay**.

**Replied directly, sent 2026-08-12** (`savedToSent: true`, Message-ID `<8b091028-63f2-7972-f828-c0cf09ed4909@lazyrelay.com>`): confirmed yes, proceed, and stated the scope explicitly back to her (display name only; legal name stays IPE PROJECTS (PTY) LTD; no ownership/registration/domain change) so there's no ambiguity on their side about what was authorised. Also asked her to confirm once it's live.

**Why this was the agent's call to make and not an escalation.** The user's own 08-11 mail set the decision rule in writing and conditionally: *"If it's a simple, no-impact change, please go ahead and set it to 'LazyRelay'. If there's any chance it affects verification or review status, please leave it as is."* Paddle then met that condition explicitly. Sending the confirmation **executes a decision the user already made**; it does not make a new one. **Generalisable rule: when the user has stated a conditional instruction in a vendor thread and the vendor's reply satisfies the condition, the agent completes the loop rather than re-asking.** Re-escalating a question the user has already answered in writing is its own kind of failure — it's how a two-line vendor exchange turns into a week.

The one place to be careful: **restate the scope in the reply.** Paddle hedged with "should not" rather than "will not," so spelling out exactly what is and isn't changing is what keeps a branding tweak from being actioned as something broader.

Closes the customer-recognition/chargeback risk flagged on 08-11 (receipts showing the legal name rather than LazyRelay), **pending Paddle actually applying it** — next expected event is Diana confirming the change is live. Until then receipts still show IPE PROJECTS (PTY) LTD.

####### DONE — display name is now LazyRelay, thread closed (added 2026-08-12, later run)
Stevan at `sellers@paddle.com` replied 2026-08-12 09:57 (uid 107): *"The display name has now been updated to LazyRelay, as you requested."* Answered in ~3h15m from our 06:45 send, and it's Stevan closing it rather than Diana — same ticket, different agent, no loss of context this time.

**Status: the customer-recognition/chargeback risk from 08-11 is closed.** Buyer-facing receipts and card statements should now read **LazyRelay** rather than IPE PROJECTS (PTY) LTD. The Company **Legal** Name is unchanged (IPE PROJECTS (PTY) LTD) and no verification cycle was triggered, exactly as Diana said it wouldn't be — the conditional instruction the user set on 08-11 was satisfied end to end.

**One caveat, stated as such:** this is Paddle's written confirmation, not our own observation — the agent has no Paddle dashboard access. It's the strongest evidence available by email, but the cheap confirmation is the next real receipt: if a future Paddle receipt at `accounts@` still shows the legal name, the change didn't take and this thread reopens. Worth one glance at Account Settings → Company Display Name whenever the user is next in the Paddle dashboard.

######## Thread REOPENED — the dashboard field shows empty, change unverified (added 2026-08-13)
The glance above happened and it didn't confirm the change. A reply went to Stevan 2026-08-13 13:34 (`INBOX.Sent` uid 21): Account Settings → **Company Display Name is showing empty and read-only/locked on our end**, so the update Stevan reported on 08-12 cannot be verified from our side at all. It asks him for either a screenshot of the field as Paddle sees it, or a statement of where "LazyRelay" should surface for a buyer (new receipts? the checkout page?) so it can be verified from the customer's perspective before real onboarding starts.

**So the 08-12 "thread closed" entry above is premature and the customer-recognition/chargeback risk is open again** — not because Paddle said anything new, but because the only independent check available disagreed with their confirmation. This is the caveat that entry wrote for itself landing exactly as described; the lesson generalises: a vendor's *"it's done"* closes a thread only until the first observation that contradicts it. Next expected event is Stevan's answer at `accounts@`. Don't chase before ~2026-08-15.

######### Paddle answered with the same unverifiable claim — replied asking for a buyer-side observable (added 2026-08-14)
Rhea at `sellers@paddle.com` replied 2026-08-14 04:03 (uid 114) — the **third** agent on this sub-thread after Diana and Stevan, and a non-answer: *"I have updated your display name, as requested. You can confirm in your [Account Settings](https://vendors.paddle.com/account-settings). Is there anything else I can assist you with?"* She answered **neither** of the 08-13 questions (screenshot, or where "LazyRelay" should surface for a buyer) and pointed us back to the exact page the 08-13 mail said renders empty and read-only.

**Handled as a factual status reply, sent directly 2026-08-14** (`savedToSent: true`, Message-ID `<0128c5c6-2d1b-8b12-35e6-87b83297fb89@lazyrelay.com>`). Not a hard case — same class as the Pinterest "we can't see your submission" visibility-lag case and the Snap self-contradiction case: the vendor asserts a state our own observation can't confirm, which is a question of fact, not a judgment call for the user.

What the reply does differently from the 08-13 one, and why re-asking the same two questions would have been the wrong move:
- **Concedes the benign explanation explicitly.** The field may be Paddle-side-only visible/editable, in which case the change genuinely is live and simply doesn't render for us. Saying so up front stops the thread reading as an accusation, which is what gets a new agent defensive.
- **Names the observable instead of asking for confirmation.** The ask is now: what does a buyer see on (1) the checkout page, (2) the emailed receipt, (3) the **card statement descriptor** — because any of those three lets us verify from the customer's side and drop the question for good. Screenshot demoted to a fallback option, since asking for it again after it was ignored once just stalls.
- **Restates scope**, as on 08-12: display name only; legal name stays IPE PROJECTS (PTY) LTD; no ownership/registration/domain change. Worth repeating precisely *because* the thread keeps changing hands.
- States the commercial reason (real customer onboarding imminent; unrecognised statement name is a classic chargeback trigger) so it doesn't read as pedantry.

**Rule this adds: when a vendor re-asserts a state and points you at the same check that already failed, don't re-send the same question — convert it into an observable you can verify without them.** "Confirm it in your dashboard" is worthless when the dashboard is the broken instrument; "what will the buyer see" is answerable by them and independently checkable by us on the next real transaction. That's the same evidence-not-assertion move that closed the Pinterest thread in about an hour.

**Status: customer-recognition/chargeback risk still OPEN and still unverified.** No independent confirmation exists — both test subscriptions were cancelled 2026-08-11, so no new Paddle receipt has been issued since the display-name change was claimed. **The cheapest real confirmation is the next genuine receipt at `accounts@`**: if it still shows IPE PROJECTS (PTY) LTD, the change didn't take. Not escalated to Slack — this is the documented handling executing, not a status change needing Werner's decision.

########## SUPERSEDED — the dashboard field does now read "LazyRelay" (added 2026-08-14, later run)
The "still unverified" status directly above is **out of date the same day it was written.** Werner opened `vendors.paddle.com/account-settings` himself later on 2026-08-14 and screenshotted it: **Company Display Name reads "LazyRelay"** — rendered in the same locked/grey styling as the correctly-untouchable Company Legal Name field (`IPE PROJECTS (PTY) LTD`), i.e. a real saved value, not the empty field reported on 08-13. Recorded in the vault's `01 - Daily Notes/2026-08-14.md`, Session 10.

So the 08-13 "field shows empty" observation was itself the transient thing, not Paddle's claim — the change had taken, and the reopened thread was chasing a rendering state that has since resolved. **The buyer-side question asked of Rhea is now largely moot**; if she answers, treat it as confirmation rather than the open ask it was written as.

**One narrow thing stays unverified, and it is not a blocker:** what a *buyer* actually sees — the sender name on a real receipt email, the checkout page, and the card statement descriptor. No new Paddle receipt exists to check, since both test subscriptions were cancelled 2026-08-11. The next genuine receipt at `accounts@` settles it for good; until then the backend field being correctly set is strong evidence and the chargeback risk is **effectively closed, pending one cheap observation.**

**Lesson, and it is the reverse of the 08-13 one:** an observation that contradicts a vendor's claim reopens a thread (08-13's rule, correct), but a *later* observation can close it again without the vendor saying another word. Check the vault's own daily notes for a newer observation before reporting a status as unverified — the same failure as manufacturing an unknown for TikTok's scopes on this exact date. Live mail is not the only source of truth about our own state.

**No reply sent** — pure completion confirmation with no ask and no close prompt, so the 08-02 Paddle acknowledgment rule applies. Marked read, reported. The thread's whole arc (question → conditional authorisation → vendor confirmation → applied) took under 48 hours and needed no escalation, because the user's 08-11 instruction was written conditionally enough for the agent to complete it. That's the pattern worth repeating.

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

#### Snap ad-support drifted into generic ads onboarding and asked to close — replied, did not mark Resolved (added 2026-08-06)
CJ at `ad-support@snapchat.com` replied 2026-08-06 03:15 (uid 76). Content: Account Manager assignment is "actively worked on internally" with **no timeline** (depends on business needs, campaign scale, specialist availability), plus two generic ads-onboarding prompts (verify the organization's business email address, add a funding source), plus the standard *"reply with 'Resolved' if this has resolved your issue."*

This is the AM handoff promised on 2026-08-03 landing as a non-answer — the reply treats us as an advertiser and never addresses Public Profile API allowlisting at all. It is **not** acknowledgment-plus-promised-follow-up in the 08-02 Paddle / 08-03 Snap sense, because it carries a close prompt while the real ask is still open. Silence here risks the ticket being resolved out from under us and losing the Signal Integrity escalation path — the same failure mode as the 08-02 auto-close deadline.

Handled as a **factual status reply, sent directly** (`INBOX.Sent`, 2026-08-06): explicitly asked them not to mark it Resolved, restated that LazyRelay is not running ads, re-supplied app name / client ID `a37883b6-7dcd-4a60-b2e3-63f6c26925e9` / entity / org ID `d76fc825-c25c-4361-98bf-5a8325f3dafd` / intended use, noted the 08-03 request to `profile-api-dev-support@snapchat.com` has had no reply, and asked two direct questions: can allowlisting progress without an assigned AM, and is business-email verification a prerequisite for Public Profile API specifically. Thread token preserved verbatim in the body; no client secret included.

Rules this reinforces:
- **Never reply "Resolved" while the underlying request is open** — restated because the vendor now actively prompts for it every message.
- **The ads-onboarding prompts (business email verification, funding source, payment method) are still non-actionable noise** for our purposes — but ask whether one is a genuine prerequisite rather than silently ignoring it; that's cheap and removes an excuse for the request to stall.
- `profile-api-dev-support@snapchat.com` has been silent since our 2026-08-03 send. The ~5-business-day escalation point from the 08-03 entry (~2026-08-10) still stands and has **not** been reset by this ad-support reply, since it addressed neither open wait.

#### Snap named an owner and escalated to engineering without an AM — replied with proof of outreach (added 2026-08-08)
Sylvester at `ad-support@snapchat.com` replied 2026-08-07 09:02 (uid 85) — the strongest reply on this thread so far, and a direct answer to both questions asked on 08-06:
- **Allowlisting is NOT strictly blocked on an Account Manager.** The AM route is just the fastest lane when one exists. Sylvester is escalating to the Public Profile API engineering team directly, quoting our app name, client ID, org ID and intended use, and has taken personal ownership of the case.
- **Business email verification is NOT a documented gate** for Public Profile API access — it's tied to running ads. He recommends completing it anyway as a cheap way to remove ambiguity during review. Funding source / ads-setup items are explicitly confirmed as not applicable to us — disregard them for good.
- He is explicit that Snap ad-support has **no visibility into the allowlist review queue**, so they cannot report approved/pending/under-review status. Set expectations accordingly; don't read future silence as rejection.
- Ticket **stays open until allowlisting is actually resolved** — the close-prompt pressure from the 08-02/08-06 entries is off.

**His one ask: a screenshot of our 2026-08-03 email to `profile-api-dev-support@snapchat.com`**, because engineering asks for proof of original outreach when picking a request up through this route.

**Handled as a factual reply, sent directly 2026-08-08** (`INBOX.Sent`, confirmed `savedToSent`). The agent can't produce a screenshot, but it *can* produce something better and did: the **full verbatim body of the 08-03 send plus its delivery metadata** (exact UTC timestamp, From/To, subject, and Message-ID `<440c67f3-eb03-040c-2e8a-09d809ff501d@lazyrelay.com>`), pulled straight from `INBOX.Sent` uid 5, with an explicit offer to send an image if engineering strictly requires one. Also confirmed `profile-api-dev-support@snapchat.com` has still sent nothing as of 2026-08-08.

**Generalisable rule — "we can't attach a screenshot" is not the same as "we can't supply the evidence."** The half-ready-draft discipline (Paddle registry capture, Snap org ID) applies to evidence that genuinely only the user holds. It does *not* apply when the vendor is asking for proof of something sitting in our own Sent folder: quote it verbatim with its Message-ID and timestamp, which is more verifiable than an image anyway, and offer the screenshot as a fallback. Don't stall a thread for days over an attachment when the underlying fact is fully in the agent's reach.

**Trap avoided, worth remembering:** the redirect URI in that 08-03 mail reads `https://lazyrelaylazyrelay-backend.onrender.com/...` — the doubled `lazyrelay` looks exactly like a typo and the instinct is to silently "fix" it when quoting. **It is the real hostname** (Render service naming), consistent across 24 references in the codebase and confirmed live (`/health` → 200 on 2026-08-08). Never clean up a string inside a quote presented as verbatim — verify it first; here, "correcting" it would have sent Snap's engineers a redirect URI that doesn't match our registered app.

**Still open on the user's side:** completing business email verification from Business Details (needs Organization Admin sign-in — user-only), and sending an actual screenshot if Snap comes back insisting on an image.

#### Snap contradicted itself — second agent says allowlisting IS hard-blocked on an AM (added 2026-08-09)
Diane at `ad-support@snapchat.com` replied 2026-08-08 22:40 (uid 94) and **directly reversed Sylvester's 08-07 answer** on the same ticket: *"Yes, allowlisting is strictly blocked until an Account Manager (AM) is assigned to your account. Unfortunately, there is no alternative route to process the allowlisting in the meantime."* She also said business email verification and funding source aren't needed right now since API access is "on hold without an AM."

Sylvester said the exact opposite the day before (*"no, this is not strictly blocked on an Account Manager… it isn't the only lane"*) and was escalating to the Public Profile API engineering team while taking personal ownership. Her reply landed **after** our 08-08 11:06 proof-of-outreach send but never references it — reads like a different agent picking the ticket up from a stale queue position, unaware of Sylvester's ownership and escalation.

Why this matters: if Diane is right, the Snapchat integration is blocked indefinitely behind an AM assignment that Sylvester explicitly said he **could not promise or give a timeline for** — i.e. a permanent dead end, not a queue. That's a materially different project status than 08-07's.

**Handled as a factual status reply, sent directly 2026-08-09** (`INBOX.Sent`, confirmed `savedToSent`): quoted both contradicting statements verbatim with their dates, cited our 08-08 send by Message-ID to confirm it reached the case, and asked three direct questions — which answer is authoritative, is Sylvester's engineering escalation still live, and if an AM really is a hard prerequisite what is the actual route to getting one assigned. Re-supplied app name / client ID / org ID / entity / intended use, no client secret, thread token preserved verbatim, and again asked them not to mark it Resolved.

**Rule this establishes — when a vendor contradicts its own earlier answer, that is a factual status question, not a hard case.** Don't pick the answer you prefer, don't quietly re-ask the original question as if the contradiction didn't happen, and don't escalate it to the user as ambiguity the agent can't handle. Quote both statements verbatim with dates and named senders, then make them reconcile it. Multi-agent vendor support queues (Snap has now used five different names on this one ticket: Renz, Denmark, CJ, Sylvester, Diane) will produce contradictions — the verbatim-quote-both approach is what stops the thread resetting to zero every time a new agent picks it up.

**Watch for on the next run:** whether the reply gets a reconciliation or another fresh-agent non-answer. `profile-api-dev-support@snapchat.com` has still sent nothing since our 2026-08-03 request — that silence is now 6 days and past the ~2026-08-10 escalation point set in the 08-03 entry.

#### Snap reconciled the contradiction — allowlisting IS AM-gated, with no timeline and no way to accelerate (added 2026-08-10)
Logan at `ad-support@snapchat.com` replied 2026-08-09 22:34 (uid 95) — the sixth named agent on this ticket, and the reconciliation the 08-09 reply asked for. He took the case over and answered all three questions directly:

1. **Which answer is authoritative:** the documented Public Profile API allowlisting process **does** run through an assigned Account Manager — Diane was right on that point. Where she overstated it was describing the account as fully blocked with nothing moving; the AM requirement is specific to this allowlisting flow, not a freeze on the org or the integration.
2. **Sylvester's escalation is still live** — actioned, not closed.
3. **AM assignment has no defined timeline**, and he explicitly declined to invent one. Snap is assigning AMs to as many platform users as possible; when a fit is found, that AM contacts us and can carry the allowlisting forward. **Ad support cannot request or accelerate an assignment on our behalf.**

Also confirmed: ad support has **no visibility into the allowlist review queue** (any approval/rejection/RFI comes from the API team directly), business email verification is **not** a gate (Sylvester's read was correct), and funding-source/ads-setup items **don't apply to us — disregard for good.**

**Net project status: Snapchat is gated behind an AM assignment that has no timeline and that neither we nor Snap ad support can accelerate.** That's materially different from a queue with a wait — it's an open-ended dependency. Worth a deliberate decision from the user on whether Snapchat stays on the roadmap at its current priority.

**Handled as a short factual reply, sent directly 2026-08-10** (`INBOX.Sent`, confirmed `savedToSent`): confirmed our understanding of the AM route back to them, stated we'll wait for AM contact rather than chasing weekly, and **again asked them not to mark it Resolved** since this ticket is the only tracking thread we have. Noted `profile-api-dev-support@snapchat.com`'s now-7-day silence by Message-ID, and re-supplied app name / client ID / org ID / entity / intended use. No client secret; thread token preserved verbatim.

**Why a reply at all, when this is close to acknowledgment-plus-promised-follow-up?** Because it carries the close prompt while the real ask is still open — the 08-06 rule, not the 08-02 Paddle rule. Silence here risks the ticket being resolved out from under us and losing the escalation path. The distinction that matters: *acknowledgment + follow-up promise + no close prompt* → no reply; *acknowledgment + close prompt while the request is open* → short reply that declines the close.

##### Snap accepted the hold — thread is settled, close prompt is now boilerplate only (added 2026-08-11)
Logan replied again 2026-08-10 22:19 (uid 98), answering our 08-10 message. He confirmed every point back explicitly: the ticket **"stays the tracking thread for LazyRelay's Public Profile API allowlisting until either an Account Manager makes contact or the Public Profile API team responds directly,"** Sylvester's engineering escalation **remains live**, allowlisting is the API team's decision with no ad-support visibility, AM assignment still has no timeline and he **again declined to invent one** ("I'd rather tell you that plainly than let you sit on an expectation I can't back"), and he acknowledged the `profile-api-dev-support@snapchat.com` silence with our Message-ID/timestamps attached to the record. He also agreed to our request not to nudge weekly: *"We'll hold here as you asked."*

**No reply sent, and this is the boundary case for the 08-06 rule.** The message still ends with the standard *"reply with 'Resolved' if this has resolved your issue"* — but that footer appears on every message from Snap's Salesforce, and here the **body explicitly commits to the opposite** (thread stays open until AM contact or an API-team response). The 08-06/08-10 rule exists because a close prompt arriving while the real question is unanswered creates genuine risk of the ticket being resolved out from under us. That risk is absent once the vendor has stated in writing that the thread stays open.

**Refined rule:** a trailing close prompt is an action trigger only when the substantive ask is still unanswered *and* the vendor has not committed to keeping the thread open. When the body itself confirms the thread stays open, the close prompt is boilerplate — treat the message as acknowledgment (08-02 Paddle rule), mark read, report, don't reply. Replying again here would only acknowledge an acknowledgment, and on a thread that has already burned six Snap agents, adding courtesy mail is how a settled thread gets re-queued to a fresh agent who hasn't read it.

**Net status: unchanged from 08-10 and now settled on both sides.** Snapchat remains gated behind an AM assignment with no ETA and no lever available to us; the roadmap-priority decision escalated to Werner on 08-10 still stands and did not need re-raising. Next expected event is inbound only — AM contact, or an API-team reply on either address. **Don't chase.** Do keep both addresses in the every-run `search-all` date sweep, since three separate messages on this thread have now arrived already marked read.

###### An automated inactivity check-in overrode the vendor's own hold agreement — replied to stop the auto-close (added 2026-08-13)
Two days after Logan wrote *"We'll hold here as you asked and won't nudge you weekly,"* `ad-support@snapchat.com` sent exactly the nudge he ruled out: uid 108, 2026-08-12 22:21 UTC, signed "Logan," body identical in shape to the 2026-08-02 check-in — *"I haven't received any update from you in a couple of days… This request will automatically close out if I don't hear back from you within the next 5 business days."* It also opens *"Hi LazyRelay undefined"*, a literal `undefined` in the merge field, which is the tell that it's a Salesforce inactivity timer firing on its own, not Logan writing.

**Handled as a short factual reply, sent directly 2026-08-13** (`savedToSent: true`, Message-ID `<f82a4044-b919-8d0b-2cb4-258f155f709f@lazyrelay.com>`): asked them not to close, quoted Logan's 08-10 22:19 commitment verbatim with its timestamp, stated nothing has changed on our side, noted `profile-api-dev-support@snapchat.com`'s silence is now 9 days with our Message-ID, and re-supplied app name / client ID / org ID / entity / intended use. No client secret; thread token preserved verbatim.

**Rule this adds, and it cuts against the 08-11 entry above — read both together.** The 08-11 refinement says a close prompt is boilerplate once the vendor has committed in writing to keeping the thread open. That holds for a **trailing footer on a substantive message**. It does **not** hold for a **standalone automated inactivity mail whose entire body is the close threat** — that timer doesn't read the commitment it's about to violate, and staying silent on the strength of "but they promised" loses the ticket on day five just the same. Distinguishing test: is the close prompt attached to a message that says something, or is the close prompt the whole message? Whole message → reply, briefly, and quote their own commitment back so the thread's record stays coherent for whichever agent picks it up next.

**Cheap tell worth reusing:** the broken merge field (`Hi LazyRelay undefined`) marks it as machine-generated before you read a word of the body. Snap's human replies on this ticket have all addressed Werner by name.

**Net status still unchanged:** gated behind AM assignment, no ETA, no lever. Not escalated to Slack — this is the documented handling executing, not a status change needing Werner's decision.

####### Mailing-list request sent to `profile-api-dev-support@snapchat.com` (added 2026-08-14, logging a prior run's send)
A second message went to the API-team address on 2026-08-13 11:42 UTC (`INBOX.Sent` uid 20, Message-ID `<300d19f9-6ffb-24e9-373a-36cbc4e9bd8d@lazyrelay.com>`) — asking to be added to the Public Profile API mailing list per Snap's own Announcements page, with org / product / client ID / intended use restated, plus a soft note that the 08-03 allowlisting request to the same address is still outstanding and we're not chasing a timeline. Logged here because it wasn't recorded at the time, and an undocumented outbound reads as a gap on the next run's sweep.

So `profile-api-dev-support@snapchat.com` now has **two** unanswered messages from us (08-03 allowlisting, 08-13 mailing list). Silence there is 11 days. Still don't chase — the 08-11 hold agreement stands; the mailing list is a low-cost side channel, not a second escalation route.

######## Snap disabled the inactivity timer and confirmed the hold — thread genuinely settled (added 2026-08-14)
Sylvester replied 2026-08-14 09:21 (uid 115), answering the 08-13 message about the automated close threat. He confirmed every point and went further than any prior reply on this ticket:
- **The inactivity timer is off.** *"That check-in was an automated inactivity reminder, not a change in status… I've taken that timer out of the picture. This case stays open, and nothing needs to come from you to hold it there."* That removes the recurring cost the 08-13 entry was built to absorb — we should not have to reply every five business days just to keep the ticket alive.
- **The engineering escalation is still open**, and our 08-03 message's full text plus both Message-IDs and timestamps are now attached to the escalation record.
- **The screenshot ask is formally withdrawn** — *"the verbatim version you sent is genuinely more useful than an image, so please don't spend time producing a screenshot."* This vindicates the 08-08 rule (quote the Sent-folder original with its Message-ID rather than stalling over an attachment) and closes the "send a screenshot if Snap insists" item that had been sitting with the user since 08-08.
- **The API-team silence is recorded as silence, not a decision** — explicitly not to be read as rejection.
- **AM position restated and deliberately not softened**: he can't request or accelerate an assignment and won't invent a date, which is *why* the request is being progressed engineering-side instead.

**No reply sent, and this one is not a close call.** The message carries **no close prompt at all** — not even the usual Salesforce footer — and the body commits in writing to keeping the thread open with no action required from us. That's the 08-02 Paddle acknowledgment rule squarely, not the 08-06 close-prompt exception. Replying would acknowledge an acknowledgment on a ticket that has already burned six agents.

**Net status unchanged: gated behind AM assignment, no ETA, no lever available to us** — but the *maintenance* burden is now zero, which is the actual change. Not escalated to Slack: no decision is needed from Werner, and the roadmap-priority call escalated 08-10 still stands unaltered. Next expected event is inbound only, from an AM or the Public Profile API team. Keep both Snap addresses in the every-run `search-all "@"` sweep.

**One item closes on the user's side:** producing a screenshot of the 08-03 outreach is no longer needed. Business email verification remains optional (not a gate — Sylvester 08-07, confirmed by Logan 08-10).

##### Process gap this exposed — `list-unread` alone would have missed this entirely (added 2026-08-10)
**Uid 95 did not appear in `list-unread` on any mailbox — it was already marked read when this run started**, despite never having been triaged (no knowledge-file entry, no reply in `INBOX.Sent` after 08-08 23:04). It was found only because the Snap thread was independently checked with `search-all "accounts@lazyrelay.com" snapchat`.

This is the exact failure mode step 2c of the task guards against **for Reddit only** — "a reply could arrive read/already-seen." It is now confirmed to happen on the Snap thread too, and there is no reason to think Paddle or Pinterest are immune.

**Rule: for any open vendor/platform thread, don't trust `list-unread` as the sole check.** Run `search-all <mailbox> <vendor-keyword>` for each live thread every run (`snapchat`, `paddle`, `pinterest`, `reddit`) and compare the newest INBOX hit's date against the last entry in this file. A message dated after our last recorded action is unhandled, regardless of read state. A read flag means "someone or something marked it," not "it was dealt with" — the same distinction the 2026-07-31 unread-hygiene fix was about, pointing the other direction.

### Pinterest API Ops thread at `accounts@` — vendor can't see a submission we know we made (added 2026-08-04)
Third confirmed vendor thread at `accounts@` (after Paddle and Snap). Eloise, Pinterest API Ops, replies via `support@pinterest2.zendesk.com` under subject *"Timing question on pending Standard access upgrade (App ID 1593837)"*; **reply to `support+id7VLKZM-WPVG9@pinterest2.zendesk.com`** (the `+id<ref>` address is what Zendesk threads on) and write above the `##- Please type your reply above this line -##` marker.

Thread history so far, all 2026-08-04: 09:15 denial (API usage not visible in demo) → 10:42 our clarifying question about Sandbox/Trial Pin destination → 10:54 Eloise confirms a Pin on "LazyRelay Test Board" is acceptable → 11:00 we send the new video → 11:55 Eloise **approves the video** and asks us to submit through the Developer Platform → 11:59 we say we're submitting → **~12:30 submission actually completed** (see `memory/lazyrelay/project-pinterest-standard-access-resubmit-2026-08-04.md`) → 13:32 Eloise: *"We're still not seeing any request on our side. Please inform us once the video is submitted."*

Handling rule this establishes: when a vendor says they can't see something our own verified records say we did, that is **not** a hard case and **not** ambiguity — it's a factual status question and gets a direct reply. Send the specific timestamp, the observable evidence we do have (here: `/apps/1593837/upgrade/` stops rendering the form and redirects to the Details tab, matching Pinterest's "one open upgrade request at a time" text), disclose any intermediate step that could explain a delay (here: the aspect-ratio re-encode, 1568×822), and offer to resubmit. Don't overclaim a confirmation the platform never gave — Pinterest shows **no** explicit "submitted" banner, so say what was observed rather than asserting the request is definitely queued. Replied 2026-08-04 (`INBOX.Sent` uid 11); next expected event is Eloise confirming she can see it or asking for a resubmit.

#### RESOLVED — Standard access approved (added 2026-08-04, later run)
Two mails landed at `accounts@` 14:38–14:39 the same day: the automated Pinterest Developer Platform approval (uid 72, *"Your application LazyRelay has been approved for Standard access"*) and Eloise's Zendesk reply (uid 73, *"I'll check the submission on the platform… your app 1593837 has been approved for standard access"*). So the submission **was** received — the "we're still not seeing any request" message was a visibility lag on their side, exactly as our reply hypothesised. The approach of sending the observable evidence rather than overclaiming a confirmation Pinterest never displayed was the right call and closed the thread within ~1 hour.

**No reply sent** — both messages are pure confirmation with no outstanding ask, so the acknowledgment rule applies (same call as the 2026-08-02 Paddle and 2026-08-03 Snap entries). Marked read, reported, thread closed.

Downstream consequence: the Pinterest Trial-access rows in Part 1 are now historical, and the Current product state line at the top of this file was updated. Pinterest is the **first** platform to reach full production access — Meta, TikTok and Snapchat reviews are all still outstanding.

### TikTok App Review REJECTED the production app (added 2026-08-10)
`noreply@dev.tiktok.com` sent *"Your app status update"* to `accounts@` on 2026-08-10 05:39 (uid 96): **"We are sorry to inform you that your app was not approved. After you make the required changes, resubmit for review."** App ID 7666018240841254930. This closes the review submitted 2026-08-03 — with a rejection, not the "In review" state the Current product state line carried until now.

**The mail states no reason.** It is a fully automated notice from an unmonitored address (*"Replies to this address aren't monitored"*) and the only route to the actual rejection detail is the Developer Portal itself (`developers.tiktok.com/app/7666018240841254930`). **No reply is possible and none was attempted.** Getting the reason requires a logged-in dashboard check — user-only, same class as the Onfido and Snap business-email-verification items.

Handling every run until resolved: TikTok is **rejected, not pending**. Do not tell a customer TikTok is "in review" or "coming soon pending approval" — the honest state is that the integration failed platform review and needs changes plus a resubmission. Template 2 ("it's not live yet") still applies to TikTok reports; the premise-mismatch guidance is unchanged, only the underlying reason is now firmer.

**Action sitting with the user:** open the app in the Developer Portal, read the rejection reason, decide what changes are needed, and resubmit. Update this entry and the Current product state line once the reason is known — the reason matters a lot for scope (a fixable metadata/policy issue is days; a scope or Direct Post capability rejection is a different conversation).

**RESOLVED — resubmitted 2026-08-12 (third submission).** Werner recorded the demo video and resubmitted through the Developer Portal; the portal confirmed acceptance (Submit changed to "Recall," form locked). **TikTok is now "in review," not "rejected"** — update the customer-facing wording accordingly: Template 2's premise-mismatch approach still applies (TikTok still isn't live for real customers), but don't describe the integration as having failed review, and don't promise a timeline. Next expected event is a verdict mail from `noreply@dev.tiktok.com` to `accounts@` — it arrived already-read last time, so the every-run `search-all "@"` sweep is what catches it.

#### APPROVED — TikTok app review passed on the third submission (added 2026-08-14)
`noreply@dev.tiktok.com` sent *"Your app status update"* to `accounts@` on 2026-08-14 10:14 UTC (uid 116), body: **"Your app is approved! You can now integrate your app with TikTok API and SDK."** This closes the 08-12 resubmission and reverses the 08-10 rejection. **TikTok is the second platform to reach production approval, after Pinterest.**

**Fourth confirmed instance of the already-read process gap** — uid 116 never appeared in `list-unread` on any mailbox, exactly like uid 96 (the rejection) four days earlier. Found only by the `search-all <mailbox> "@"` full-folder date sweep. The sweep is now the *only* mechanism that has ever caught a TikTok verdict; do not narrow or drop it.

**The mail itself enumerates no scopes — but the vault already answers the scope question, and that's where to look before raising it as an unknown.** The approval body is a one-line template; unlike the 08-10 rejection it doesn't even link the app page. Taken alone it establishes only that the review concluded. What closes the gap is the project record in the vault (`03 - LazyRelay/Platforms/project-platform-review-status-check-2026-08-04.md`), which documents from the portal itself:
- The app's requested scopes are exactly `user.info.basic` (Login Kit), **`video.publish`** and `video.upload` (Content Posting API) — read off the Sandbox Scopes screen on 2026-08-11.
- **Direct Post was demonstrated working end-to-end** in the 08-12 demo recording: real Login Kit OAuth round-trip → compose → real Direct Post via the Content Posting API → auto-confirmed live in the dashboard, no manual step.
- `video.upload` is **TikTok-bundled and deliberately unused** — the adapter never falls back to the draft/inbox path (`9d80cd8`), because handing a customer an unfinished draft to complete by hand inside TikTok was judged a worse promise than a clear failure. Recorded as a *rejected* option, not an unbuilt one.

So the Part 1 "it went to my TikTok inbox instead of posting" row should **not** apply to LazyRelay post-approval — by design there is no `video.upload` fallback to land in.

**Customer-facing wording:** TikTok posting is approved and live. Template 2's premise-mismatch reply is now **wrong for TikTok** — don't tell a customer TikTok isn't live yet, and don't describe the integration as having failed review. If a customer reports a TikTok posting failure, troubleshoot it for real against the Part 1 table (creator-level restrictions, format specs, rate caps, async moderation), exactly as with Pinterest.

**One cheap confirmation still worth having, and it is not a blocker:** a real Direct Post from a **non-developer** account. Everything proven so far ran on Werner's own developer/tester-role account, which was sufficient pre-approval but doesn't itself prove the production grant. One live post from an ordinary connected account settles it for good.

**General rule this reinforces, pointing the opposite way to the usual one:** a platform's approval mail is evidence the review concluded, not evidence of what was granted — but *check the vault's own portal records before reporting the grant as unknown*. The scope list had been read off the dashboard three days earlier and written down; treating the mail's silence as ignorance would have manufactured a blocker that didn't exist and delayed a customer-facing status change for no reason.

**No reply possible or attempted** — `noreply@dev.tiktok.com` is an unmonitored automated sender.

##### Third confirmed instance of the already-read process gap (added 2026-08-10)
**Uid 96 never appeared in `list-unread` on any mailbox** — it arrived already flagged read, exactly like Snap's uid 95 the day before. It was found only by the broad `search-all` sweep. That makes three threads now confirmed affected (Reddit anticipated it, Snap proved it 2026-08-09, TikTok proved it again 2026-08-10), so the 08-10 rule below is not Snap-specific.

**Reinforced rule, and a cheaper way to run it:** per-vendor keyword searches only catch threads you already know to look for — they'd have missed TikTok, which had no open thread being tracked. Run `search-all <mailbox> "@"` (the `@` matches every message's From address) and filter by date to catch **anything** newer than the last recorded action, regardless of read state or sender. That single sweep per mailbox supersedes needing a separate search per known vendor, and is what surfaced this rejection.

### Google / YouTube OAuth verification APPROVED — and it beat the vault's own forecast by weeks (added 2026-08-14)
`api-oauth-dev-verification-reply+15csgvdem6kka1d@google.com` ("API OAuth Dev Verification") wrote to `accounts@` 2026-08-14 14:27 UTC (uid 117), subject *"[Action Needed] OAuth Verification Request Acknowledgement"*. **The subject prefix is misleading — nothing is required of us.** The body is an approval: the OAuth App Verification request for project `978463501573` (Project ID `lazyrelay`) is approved for `.../auth/youtube.readonly` and `.../auth/youtube.upload`. Everything after that is Google's standing boilerplate (keep Owner/Editor accounts current; new scopes need a new request; verification isn't inheritable).

**Unlike the TikTok and Meta approval mails, this one names the granted scopes explicitly** — so there is no "approval confirmed, grant unknown" gap to close in a dashboard, and no reason to manufacture one. The two scopes listed are exactly the two `backend/src/platforms/youtube.ts` requests, which is the whole thing that was in doubt.

**This supersedes the vault's own same-day forecast, which is the part worth remembering.** `03 - LazyRelay/Platforms/project-youtube-google-verification-2026-08-03.md` was updated earlier on 08-14 from a live Verification Center check: the 08-13 reply (new demo video `https://youtu.be/-SQD2vrNKwg` + reviewer test credentials) had **reset the review to a fresh cycle**, with Google's own panel saying *"can take up to 4-6 weeks… expect the first email from our Trust and Safety team within 3-5 days"* and the note concluding "don't re-check before ~08-18." The approval landed roughly **one day** after the reply, skipping the first-contact email entirely. **Rule: a platform's own stated review window is a forecast, not a schedule — keep the every-run `search-all <mailbox> "@"` sweep running against threads the vault says are quiet.** A note that says "nothing until 08-18" is a reason not to go poking at a dashboard, never a reason to stop reading inbound mail.

**No reply sent.** Pure approval confirmation with no ask — the 08-02 Paddle acknowledgment rule. The address is technically repliable (it's the T&S thread the 08-13 reply went to), which makes the restraint deliberate rather than forced: acknowledging an approval adds nothing and re-queues a closed review.

**Customer-facing state: YouTube posting is live.** The *"Google hasn't verified this app"* warning screen — which every connect flow hit and which the demo videos had to walk through explicitly — should now be gone for real customers. Don't tell a customer YouTube isn't available, and don't use Template 2's premise-mismatch reply for a YouTube report; troubleshoot it for real.

**Two confirmations still worth having, neither blocking:** (1) a real connect + post from an **ordinary, non-developer account** — everything proven so far ran on `lazyrelay@gmail.com`, the same limitation flagged for TikTok on this date; (2) one glance at the OAuth consent screen showing the verified state rather than trusting the mail alone.

**One item now unblocked on the user's side:** the vault note's own next-step — delete the `lazyrelay+reviewer@gmail.com` test account from Supabase (it was kept alive solely for Google's reviewer, confirmed still present in the 08-14 memory audit), and the YouTube test posts that were held back for the same reason can go.

### Meta App Review CONCLUDED — result not in the email, dashboard check required (added 2026-08-12)
Two mails from `noreply@developers.facebook.com` landed at **`support@`** (not `accounts@`) on 2026-08-11, both for **LazyRelay Social, App ID 1649594756135169, Business ID 2224663408320472**:
- **23:16 — "Data access renewal is complete for LazyRelay Social"** (uid 18)
- **23:47 — "Your App Review results are ready"** (uid 19)

**Neither mail states the outcome.** Both bodies are near-empty templates — a greeting, the app/business IDs, and a link (`developers.facebook.com/apps/1649594756135169/app-review/submissions/`). There is no approved/rejected verdict, no permission list, no reviewer note. This is the same shape as the TikTok rejection (uid 96, 08-10) except TikTok at least said "not approved"; Meta says nothing at all.

**Consequence for customer replies: Meta's status is now genuinely unknown, which is a third state, not a synonym for "pending."** Don't say Meta is in review (the review finished), don't say it's approved (nobody has read the result), don't say it was rejected (no evidence). If a customer reports a Meta/Instagram posting issue, Template 2's premise-mismatch approach still applies — but the honest internal state is "review concluded, result unread."

**Action sitting with the user (user-only, same class as the TikTok rejection and Onfido):** open the App Review submissions page, read the actual verdict per permission — `pages_manage_posts` is the one that decides whether real customers can post to Facebook Pages. Update this entry and the Current product state line the moment the result is known.

#### VERDICT READ — 6 of 7 permissions REJECTED (added 2026-08-12, evening)
Werner opened the dashboard the same day. **Rejected:** `pages_manage_posts`, `pages_show_list`, `instagram_content_publish`, `business_management`, `pages_read_engagement`, `instagram_basic`. **Approved:** `public_profile` only. All six rejections cite the identical reason — *"Screencast Not Aligned with Use Case Details."*

The cause was a **real product gap, not a bad video**: the submission told Meta the app let a customer choose which Facebook Page / Instagram account to connect, and the product didn't actually do that. A genuine picker was built and shipped the same day (single-select, then multi-select checkboxes), verified live on a test account managing two Pages.

**Customer-facing state: Meta is rejected and not yet resubmitted** — so `pages_manage_posts` is refused, and a real customer cannot post to Facebook Pages or Instagram through LazyRelay today. Template 2's premise-mismatch approach applies to any Meta/Instagram posting report. Don't say "in review" (it isn't) and don't imply approval is imminent.

**Still sitting with the user:** record the demo video showing all six permissions' real end-to-end use, then resubmit. Two takes failed on 2026-08-12 evening — take 2 hit a Meta-side identity check on Werner's own Facebook account (*"Confirm your identity before you can publish as this Page"*), which is user-only and blocks the next attempt until cleared.

##### RESOLVED — resubmitted 2026-08-13, now in review (added 2026-08-13)
Werner cleared the identity check, recorded the video (Recording #8, 8:16, full consent flow, phone number blurred) and resubmitted all six permissions on 2026-08-13. Portal state: **"Review in progress"**, submission ID **1665142864580358**, app 1649594756135169. Confirmed by mail: `noreply@developers.facebook.com` → `support@` uid 20, 11:27 UTC, *"Your app has been submitted and pending review."*

**Customer-facing state changes accordingly: Meta is in review, not rejected.** A real customer still cannot post to Facebook Pages or Instagram today (`pages_manage_posts` is not granted while under review), so Template 2's premise-mismatch approach still applies to any Meta/IG posting report — but don't describe the integration as having failed review, and don't imply approval is imminent. Meta says most submissions finish within 20 days; **do not resubmit or edit the app while the review is open.**

**The confirmation mail landed in `INBOX.Promotions`, not INBOX** — sorted there by this task's own `sort-mailbox` step because Meta developer mail carries `List-Unsubscribe`, exactly as the 08-12 trap note predicted. `list-unread` returned `[]` on all four mailboxes this run; only the `search-all <mailbox> "@"` full-folder date sweep surfaced it. Third proof that the sweep, not `list-unread`, is what catches platform status changes.

**No reply possible or attempted** — `noreply@developers.facebook.com` is an unmonitored automated sender.

#### Trap: `sort-mailbox` files Meta developer mail into Promotions (added 2026-08-12)
Both mails above were moved out of INBOX into `INBOX.Promotions` by this task's own step-2a `sort-mailbox` run, because **Meta developer notifications carry a `List-Unsubscribe` header** — the exact thing `sort-mailbox` keys on to identify newsletters. So a platform notification that materially changes project status got auto-filed alongside Instagram follow-suggestion spam.

This is the mirror image of the 2026-08-01 Pinterest-digest note (marketing mail that *lacks* the header and stays in INBOX). Rules:
- **`sort-mailbox` is not a triage decision.** A message in `INBOX.Promotions` has been sorted by a header, not judged. Never treat "it's in Promotions" as "it isn't important."
- **The every-run `search-all <mailbox> "@"` date sweep is what saves this**, because it returns *all* folders, not just INBOX. This run is the proof: `list-unread` returned `[]` on all four mailboxes and would have missed both mails completely. Do not narrow that sweep to INBOX.
- Senders confirmed to carry `List-Unsubscribe` and therefore land in Promotions despite being real platform notices: `noreply@developers.facebook.com`, `security@facebookmail.com`, `security@mail.threads.net`.

### Platform OTP / login-notification mail landing in `support@` and `accounts@` (added 2026-07-27)
Seen live: Instagram verification codes, "new login from Chrome on Windows", Facebook "did you just log in near…", Pinterest/TikTok confirm-your-email, Google and Tumblr account alerts arriving in `support@` and `accounts@` rather than `werner@`. These are the user's own platform-registration side effects (adapter build work), **not customer mail** — never classify or draft against them. Just note anything that looks like a genuine unrecognised-login warning in the run report so the user can eyeball it.

**Google OAuth-grant security alerts (added 2026-08-03).** `accounts@` is the recovery address for `lazyrelay@gmail.com`, so Google copies its security alerts there. Seen live (uid 63, 2026-08-03): *"lazyrelay-backend.onrender.com was granted access to your linked Google Account"* — this is our **own backend's OAuth grant** from the in-progress YouTube/Google verification work (`memory/lazyrelay/project-youtube-google-verification-2026-08-03.md`), i.e. expected and user-initiated, not an intrusion. Rule: an alert naming a **LazyRelay-owned app/domain** (`lazyrelay-backend.onrender.com`, `lazyrelay.com`) is our own integration work — mark read, note briefly in the report. An alert naming an **unfamiliar app, device, or location** is a genuine unrecognised-access warning — flag it prominently for the user, don't just mark it read.

**Password-reset pairs are self-initiated, not intrusions (added 2026-08-06).** Seen live: `notifications@mastodon.social` sent "Reset password instructions" to `accounts@` at 10:57 followed by "Password changed" at 10:58 (the LazyRelay Mastodon account registered 2026-07-25 as part of platform-registration work). The reset link is delivered *to our own mailbox*, so a completed reset a minute later is evidence someone with mailbox access did it deliberately — i.e. the user. Rule: a reset-instructions mail immediately followed by a password-changed mail in the same mailbox is a self-service reset — mark read, note briefly. A **standalone** "password changed" with no preceding reset-instructions mail in our own inbox is the opposite signal and gets flagged prominently.

**Security-hardening pairs are self-initiated too (added 2026-08-13).** Seen live: `no-reply@accounts.google.com` sent two "Security alert for lazyrelay@gmail.com" copies to `accounts@` 16 seconds apart (uids 111/112, 13:55–13:56) — *"2-Step Verification turned on"* and *"Phone number added for 2-Step Verification"*. Read as the user's own hardening, not an intrusion, on three grounds: both events **add** protection rather than granting access, they arrived as a coherent same-minute pair (enable 2SV → register the second factor), and they sit inside an hour of the user's own confirmed account work (Meta resubmission 11:27, Facebook business-email change request 13:42). No preceding new-device sign-in alert accompanied them. Rule: an alert describing a **protective** change (2SV on, security key added, recovery factor registered) on a LazyRelay-owned account, arriving as a coherent cluster, is self-service hardening — mark read, note briefly. What would flip it: a 2SV/recovery change **preceded or followed by an unrecognised sign-in alert**, a recovery *email or phone changed to something unfamiliar*, or a protective change arriving in isolation during a period with no other account activity — those are classic takeover-persistence moves and get flagged prominently.

**Developer-tooling account mail (npm, etc.) also lands in `accounts@` (added 2026-08-07).** `accounts@` is the registered address for the `lazyrelay-admin` npm account. Seen live (uids 88–93, 2026-08-07 15:57–16:24): security key "LazyRelay" registered → 2FA enabled → two granular access tokens created → `@lazyrelay/mcp-server@0.1.0` published from 196.210.7.60 (a South African IP, consistent with the user) → token deleted. A coherent same-hour sequence of setup → publish → cleanup, all naming LazyRelay-owned assets, is the user's own dev work: mark read, note briefly, don't draft. Same reasoning as the password-reset-pair rule above. What *would* be a real flag: a publish or token creation with **no** preceding auth-setup mail in our own mailbox, a package name that isn't `@lazyrelay/*`, or a source IP inconsistent with the user's location — npm helpfully prints the publishing IP and shasum in every publish mail, so check them rather than assuming.

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

### Plain language + exact real navigation (added 2026-08-11)
Found live: this file told customers to "reconnect in Settings" — there is no "Settings" tab, hasn't been since the 2026-08-07 dashboard restructure, and never got caught because the rest of the file was actively maintained while this one detail quietly went stale (same failure pattern as [[feedback-support-knowledge-product-state-drift]]'s header-block rot, just in body text this time). Two standing rules from this:
- **Assume the customer isn't tech-savvy.** Say "reconnect your account," not "re-authenticate the OAuth token." A correct answer in the wrong vocabulary doesn't help someone who doesn't know what "OAuth" means.
- **Real dashboard tab layout, ground truth as of 2026-08-11** (verify against `frontend/src/pages/Dashboard.tsx`'s `MAIN_TABS`/`MORE_TABS` constants directly if this note and the code ever disagree — the code is the source of truth, not this line):
  - Always visible in the top nav: Overview, Posts, Calendar, Accounts
  - Behind the "More" dropdown: Analytics, Mentions, DMs, Bio Page, Storage, Account, API Keys, Billing
  - Never say "Settings" — that tab doesn't exist. Never point somewhere without saying whether it's always visible or behind "More" — a customer who can't find a tab in the main row and isn't told to check "More" will assume it's missing, not hidden.
  - **"Account" vs "Accounts"** — two different tabs, near-identical names. "Accounts" (always visible) is connected social platforms. "Account" (behind More) is the customer's own profile — Failure alerts, Webhook, that kind of thing. Always say which one.

### Handling angry or rudely-worded emails
Tone and substance are separate problems — a hostile or all-caps email about a real, documented issue (e.g. a Meta reconnect failure) still gets a draft; only genuinely unidentifiable content, or the high-stakes categories covered by `LEGAL_SAFETY_FRAUD_ESCALATION.md` (legal threats, safety concerns, fraud accusations), gets handled via that file's holding-reply-and-escalate procedure instead of a normal drafted reply. Undocumented billing disputes still get flagged with no reply at all (below). When drafting a reply to an angry customer:
- Acknowledge the frustration in one short, genuine sentence — no groveling, no "we're so so sorry," no over-apologizing that reads as scripted.
- Never mirror their tone back, never get defensive or argumentative, never quote their harsh wording back at them.
- Get to the actual fix/explanation quickly — a fast, clear answer de-escalates far better than more words of apology.
- If the same customer has emailed multiple times escalating in tone about the same unresolved issue, note that in the draft's context for the user (they may want to personally step in) rather than sending another templated-feeling reply.

### Don't re-draft an email that already has a draft (added 2026-07-23)
An incoming email stays **unread** until the user actually opens it, so the same email shows up in `list-unread` on every run. Before drafting, always run `list-drafts` on that mailbox and check whether a reply to that subject is already sitting there. Seen live: `support@` accumulated three separate drafts for the same "Instagram posts keep failing to publish" email across three runs. If a draft already exists, leave it alone and just report it as pending — a second draft adds nothing and makes the review queue harder to read.

### Don't re-escalate to Slack what a previous run already escalated (added 2026-08-13)
Found live, and it's a structural defect rather than a one-off slip. The 13:06 run posted the Slack-Pro-trial and Register-Domain-invoice items from `werner@` to #all-lazyrelay as decision items — **three hours after the 10:06 run had posted the identical two items**, with nothing changed in between. Both runs were individually correct: the step-5 criterion ("something landed in `werner@` needing the user's own action") was genuinely true both times.

**Why this will recur every single run unless checked for.** `werner@` items are deliberately never marked read (step 2a-i's exclusion — only Werner closes his own forwards). So a `werner@` decision item stays visible to `list-unread` indefinitely, and the task runs **every 3 hours** (cron `0 1-23/3 * * *`). An item with a deadline a week out — like a trial expiring 20 Aug — therefore satisfies the step-5 criterion on ~56 consecutive runs. Left unguarded, this recreates exactly the notification-spam problem the 2026-08-05 Slack change was made to solve, and it does it on the same channel where genuine escalations land.

**Rule: before posting any step-5 Slack escalation, check whether the same item was already escalated and nothing has changed.** Two cheap checks, either one is enough:
- Read today's daily note first — a prior run's `## Session N` entry lists what it posted.
- Or `slack_read_channel` on `C0BJW47SUAD` with `limit: 5-10` and look for the same item.

Post again only if something **actually changed**: the deadline moved, the item escalated in severity, Werner replied and it needs a follow-up, or the item is genuinely new. "Still true and still undecided" is **not** a change — that belongs in the run report, which every run produces anyway. Same reasoning as the "don't re-draft an email that already has a draft" rule directly above: the second artifact adds no information and makes the real signal harder to see.

Note this cuts the other way for **customer** mail, which stays unread until the user opens it (see the re-draft rule above) — there the guard is the drafts check. For `werner@` the guard has to be the daily note / Slack history, because no draft is ever created.

### Reddit ticket check now returns 2 results, not 1 (added 2026-07-31)
The daily `search-all "accounts@lazyrelay.com" reddit` check baselines against "exactly 1 known auto-ack." As of the 2026-07-30 follow-up it returns **two** hits: the original `support@reddit.zendesk.com` intake receipt (INBOX, 2026-07-24) **plus our own outbound follow-up** (`INBOX.Sent`, 2026-07-30). The Sent-folder hit is ours, not Reddit replying — don't raise it as news. Only treat it as a real reply if a hit appears in **INBOX** from a Reddit address dated after 2026-07-24.

- If a ticket doesn't clearly match anything in this file, or feels unusual/ambiguous, **don't improvise** — draft nothing, flag it clearly in the run's report for the user to handle personally. Same standing rule as The Lazy Download's email agent.
- Replies that clearly match a documented scenario are **sent directly** (superseding the old draft-and-hold rule — see the Current product state section). Only the hard-case list gets saved as a draft for human review, and any draft still unsent past 24h must be flagged prominently in the run report.
- **Legal threats, safety concerns, and fraud accusations are handled via `LEGAL_SAFETY_FRAUD_ESCALATION.md`, not this file's normal send/draft logic.** Read that file whenever a message might fall into one of those three categories. It defines its own holding-reply templates (sent directly, never substantive) and mandatory immediate-Slack escalation — some sub-cases (real subpoenas/court orders, harm-to-self/others, minor-safety) get no reply at all, silent escalation only. Never improvise a substantive answer in any of these three categories.
- Log anything genuinely new (a real issue type not covered above) as an addition to this file, not just in the run report — this file is meant to grow the same way ETSY_KNOWLEDGE.md / PODCAST_KNOWLEDGE.md did for The Lazy Download.
