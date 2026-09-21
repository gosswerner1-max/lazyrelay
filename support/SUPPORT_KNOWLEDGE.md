# LazyRelay Support Knowledge Base

Living document for the `hello@` / `support@` / `accounts@lazyrelay.com` email agent. Read this file every run before drafting any reply. Update it whenever a genuinely new issue type is handled that isn't covered here yet — same discipline as `<other business>`'s knowledge files.

**Placeholders in this file.** This repo is public, so `<other business>` stands for one of Werner's other businesses rather than naming it. It resolves in the vault via `09 - Resources/Ops-QA/reference-werner-mailbox-other-businesses.md`. Same convention as `ops/accounts/ACCOUNTS_KNOWLEDGE.md` and `ops/billing/BILLING_KNOWLEDGE.md`, which also use `<other-business domain>` and `<first external signup address>`.

**How this file is split (since 2026-09-16).** This file holds **current state and the rules** — read it in full every run. The dated evidence behind the rules (full vendor-thread histories, first-instance write-ups, retracted conclusions) lives word for word in **`SUPPORT_KNOWLEDGE_ARCHIVE.md`** next to this file. Open the archive only when you need the evidence behind a rule or a thread's full history; it is not an every-run read. Entries below cite their origin as *(archive: YYYY-MM-DD)*.
- **New entries go here.** When a vendor thread closes or a case is fully resolved, move its dated write-up to the archive in the same pass and leave a one-line status plus any durable rule here.
- **Keep this file under ~150KB.** Past that, rotate resolved detail to the archive again.

---

## Current product state (keep this current — it changes what's actually possible to answer)

Verified 2026-09-16 unless a row says otherwise. **Never restate a whole-product claim ("every platform is live") from per-platform approvals** — state it per platform, naming the specific gate *(archive: 2026-09-05)*.

| Surface | What a customer can do today | Since | Notes |
|---|---|---|---|
| Pinterest | **Live** (Standard access, App ID 1593837) | 2026-08-04 | Part 1's Trial-access rows are historical — never quote them |
| YouTube | **Live** (Google OAuth verified: `youtube.readonly` + `youtube.upload`, project `978463501573`) | 2026-08-14 | Treat reported failures as real issues |
| Facebook Pages | **Live** (`pages_manage_posts` approved) | 2026-08-24 | Troubleshoot against Part 1 |
| Instagram | **Live** (`instagram_content_publish` approved) | 2026-09-04 | Troubleshoot against Part 1 |
| TikTok | **Audit APPROVED 2026-09-21, but not yet proven for customers.** `accounts@` uid 216, 06:01 UTC: *"Your Content Posting API - Direct Post application is approved! The audit is completed and you can now launch your integrations"* (app ID `7666018240841254930`, ours). **This removes the known blocker, but rule 14 applies: an approval mail proves app-level approval, not a customer capability.** Until a real post to a real *public* TikTok account is confirmed live, treat the capability as unproven | — | **Customer wording until that test passes: TikTok posting isn't available yet.** Do not tell a customer it is live off this mail alone — that is exactly the 2026-09-05 mistake. Never suggest they change account privacy, never blame their settings. **Once a real public post is verified, update this row, the Part 1 TikTok row and Template 2 in the same pass.** History: rejected 2026-09-14 (ref `20260905111305`), resubmitted 2026-09-15 (ref `20260915123859`), approved 2026-09-21 |
| Snapchat | Not integrated | — | Public Profile API allowlisting is gated behind a Snap Account Manager assignment with no ETA — see the vendor status board |
| Google Calendar sync / Google Sheets export | Built; Google's verification approved 2026-09-05 (`calendar.calendarlist`; `calendar.app.created` and `drive.file` are non-sensitive) | — | `GOOGLE_INTEGRATIONS_LIVE` in `frontend/src/pages/Dashboard.tsx` **read `true` on 2026-09-16** (it was set `false` on 2026-09-04). Re-check that line before telling a customer either way |
| Unsupported | LinkedIn, Threads, Bluesky, Mastodon, Tumblr, Reddit | — | Registration/OTP mail from these is Werner's own setup work, never evidence an adapter exists |

**The 1,160-post launch batch is deliberately paused** (`paused_at`, Werner's locked 2026-09-05 decision) until TikTok's audit clears. **The audit cleared 2026-09-21 — so the stated condition is met, but the pause stands until Werner lifts it.** Resuming is his call and his alone; escalated to Slack 2026-09-21, awaiting his answer. Don't resume it, and don't report the pause as a fault. The daily ops digest reads `overall: critical` because of it — a **known false positive**. Don't report the pause as a fault, and don't resume it. Launch timing is Werner's call; don't treat inbound as launch traffic unless he has said so *(archive: 2026-09-04, 2026-09-05)*.

**Billing is live since 2026-08-11** (Paddle, Live environment). Customers can subscribe and be charged today.
- **Tiers and prices (verified 2026-08-11):** Free $0 / **Starter $29.99** / **Pro $59.99** / **Business $99.99** per month, plus storage add-ons. DB `pro` displays as Starter, DB `business` as Pro, DB `enterprise` as Business (comment block at the top of `backend/src/tier.ts`). **Always quote display names.**
- **Never quote a price or tier name from this file alone.** Verify against `frontend/src/pages/Landing.tsx` (prices) and `backend/src/tier.ts` (names) first. The old "Pro $29.99 / Business $59.99" wording looked plausible and was wrong on both names and price *(archive: 2026-08-11)*.
- The legal and billing entity is **IPE PROJECTS (PTY) LTD** (CIPC 2021/003176/07). "LazyRelay" is the trading name. Receipts and the card statement read LazyRelay / `PADDLE.NET* LAZYRELAY` (confirmed 2026-08-18).

**Mailboxes.** `hello@` = general/press/partnership, `support@` = product/technical, `accounts@` = billing/account. Classify by content, not by the address it arrived at. `werner@` is platform/vendor registrations plus Werner's own forwards — never marked read.

**Draft-and-hold is retired (2026-08-03).** Send directly for anything that clearly matches a documented scenario or template. Save a draft and flag only the narrow hard-case list: unidentifiable request, legal threat, safety concern, fraud accusation, undocumented billing dispute, compliance/security-posture question, or a genuinely new scenario.

---

## Part 1 — Platform Integration Troubleshooting (for once Phase 0 ships)

### Meta (Facebook Pages / Instagram Business)

Quick triage:

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Was working, now silently stopped, no error" | Long-lived token expired (60-day) silently, or the async media container step never finished | Reconnect Facebook/Instagram from the **Social Platforms** tab (always visible in the top nav, no menu needed — this is the tab that was called "Accounts" before 2026-08-17) |
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
| "My video only posts privately, followers can't find it" | TikTok forces ALL unaudited-client posts to self-only visibility, regardless of what privacy setting the user picked | **Audit APPROVED 2026-09-21** (history: known-unaudited 2026-09-05, rejected 09-14, resubmitted 09-15). **But approval is app-level and the customer-facing capability is not yet proven** — until a real post to a real public account is confirmed live, assume a public account can still hit `403 unaudited_client_can_only_post_to_private_accounts`. **Customer wording is unchanged for now: TikTok posting isn't available yet, no date, never blame their account settings.** If a customer reports this *after* the capability test passes, it is a genuine new issue — flag it, don't reuse the unaudited-client explanation |
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
- **Downgrade below current usage** (e.g. 50 connected accounts on Business, downgrades to the 30-account Pro): accounts beyond the new limit get **paused, never auto-deleted**. Let the customer choose which stay active. Scheduled posts on paused accounts are held, not silently dropped. Re-upgrading instantly unlocks everything again. (Loomly's actual policy — making a downgrade not take effect until the end of the billing cycle — is a real competitor weak point; don't copy it.)
- **Cancellation (real mechanics as of migration `0043_cancel_at_period_end.sql`, 2026-08-11): access does NOT end immediately.** Cancelling sets a pending-cancellation flag — the subscription stays fully `active` and access continues until the real, current paid period ends, at which point it drops to Free automatically once the genuine `subscription.canceled` webhook lands. No further charge happens after cancelling. Cancelling is self-serve from the dashboard's **Settings** tab → **Billing** section (real-time, no agent involved) — never quote a specific end date yourself in an email, since this file/agent has no live database access; point the customer to their own Settings → Billing, which shows the real date live. Use Template 14 in `EMAIL_REPLY_TEMPLATES.md` for any cancellation-related email.

### Onboarding
- "I connected it but don't see it" — first question to ask: is the account set to Business/Creator, and (for the older Meta flow) is it linked to a Facebook Page they admin? This single check resolves most of these tickets.
- Timezone confusion ("post went out at the wrong time") — clarify the calendar shows browser-local time for reference, but the post publishes per the connected account's actual set timezone. Since Proof-of-Publish timestamps the real live time, point to that as the source of truth over the calendar view.

### Proof-of-Publish sharing (shipped 2026-08-08)
Any scheduled post that has been independently verified live now has a **public share link** — a "Share proof" button on the post in the dashboard generates a link to `lazyrelay.com/verify/:id`, a no-login page showing the post genuinely went live (this is the same Proof-of-Publish check, just made shareable). Good answer for "how do I prove to a client/boss this actually posted."

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Share proof button is greyed out / missing" | Post hasn't been verified live yet (still scheduled, still verifying, or verification failed) | Only verified-live posts can be shared — check the post's own status first |
| "Can my Zapier/agent/API integration generate these links automatically?" | By design, API keys **cannot** generate share links unless that specific key has "Allow this key to generate public proof-sharing links" checked — off by default | Customer creates a new API key (or the existing one, if they still have the secret) with that box checked on the **API Keys** tab (always visible in the top nav as of 2026-08-17 — it used to be behind **More**). Logged-in dashboard use is never gated by this — only programmatic/API-key access is |
| "I shared a link and it 404s" | Either the post ID is wrong, or it wasn't actually verified live (link only ever renders for verified-live posts — this is intentional, not a bug) | Confirm the post shows "verified live" in the dashboard before troubleshooting further |
| Anything about what the verify page *shows* | It's read-only, public, and only ever shows verification status + timestamp — never account details, platform post IDs, or error messages | No action needed, that's the intended design (safe to share externally) |

### Failure alerts / email notifications (shipped 2026-08-08)
Opt-in email notifications when a scheduled post fails for good (all retries exhausted) or when an account gets auto-paused. **Off by default** — customer must turn it on themselves on the **Settings** tab (always visible in the top nav), checkbox: "Email me if a scheduled post fails". Sent from `noreply@mail.lazyrelay.com`.

**The old "Account" vs "Accounts" name collision is gone as of 2026-08-17** — the customer's own profile settings moved into **Settings**, and the connected-social-platforms tab was renamed **Social Platforms**. Don't warn customers about two similarly-named tabs any more; there aren't any.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "I didn't get an email when my post failed" | Setting is off by default — most customers haven't turned it on yet | Point them to the **Settings** tab → "Failure alerts" |
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
A technical customer can set a webhook URL on the **Settings** tab (always visible in the top nav). LazyRelay POSTs a signed event to it the moment a post's Proof-of-Publish check confirms it's genuinely live (success only, not on failure). Aimed at customers wiring LazyRelay into their own systems, or a tool like Zapier/n8n/Make.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "How do I verify the webhook is really from LazyRelay?" | Every delivery is signed (HMAC-SHA256 of the raw JSON body, in the X-LazyRelay-Signature header) using the secret shown once when the webhook was set up | Recompute the HMAC on their end with their stored secret and compare; if they lost the secret, they can generate a new one from the same Settings page (this invalidates the old one) |
| "I didn't get a webhook for a post that failed" | Working as intended, this webhook only fires on success (verified live), never on failure — failure has its own separate opt-in email alert | Point them to the Failure alerts toggle if they also want failure notifications |
| "I didn't get a webhook even though the post succeeded" | Delivery is a single fire-and-forget attempt with no retry, so a receiving endpoint that was down/erroring at that exact moment genuinely misses it | Confirm the post is actually marked verified/live in the dashboard first; if it is and the endpoint was up, that's worth escalating as a real bug |
| "Can I get more than one webhook, or webhook on failure too?" | Not currently, one webhook URL per account, success-only | Log as a feature request, don't overpromise a timeline |
| "I lost my secret / need to rotate it" | The secret is only ever shown once at creation, by design | They can regenerate it themselves from the same Settings page, no need to also change the URL |

### Content coach / "Get ideas" button (shipped 2026-08-08)
In the compose form, a "Not sure what to post? Get ideas" button (above the existing topic field) generates 5 AI post ideas, grounded in the account's business name and its own recent posts. Clicking an idea just fills the topic field, it doesn't post anything or write the final caption by itself.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "The ideas aren't relevant to my business" | Ideas are grounded only in the business name field and recent post history, there's no separate industry/niche field today | Suggest they fill in Business Name in Account settings if it's blank or vague; otherwise this is a known current limitation, log as feedback |
| "It gave me the same ideas as before" | Ideas are freshly generated each click, not cached, but if the account has few/no recent posts there's less signal to vary against | Not a bug, more post history naturally improves variety over time |
| "Clicking an idea didn't create a post" | Working as intended, an idea only fills the topic field, the customer still reviews/generates a caption and hits Schedule themselves | Explain the flow: idea -> topic field -> Generate with AI (optional) -> review -> schedule |
| "Does this count against my AI generation limit?" | Yes, same daily quota as caption/hashtag generation, since it's a customer-initiated generate action | Point to the same daily-limit messaging used for captions/hashtags if they hit it |

### Multi-brand support (shipped 2026-08-08; upgraded to real brands with per-tier caps 2026-08-16)
A customer running more than one business through LazyRelay creates a **brand** for each business (Dashboard → Accounts → Brands manager → type a name → Add brand), then assigns each connected account to a brand via the dropdown next to it. A "Brand" filter dropdown then appears on Overview, Posts, Calendar, Analytics, Mentions, and DMs to narrow each view to one brand. Each plan **includes a set number of brands: Free 1, Starter 2, Pro 4, Business 7.** Still one login, one subscription — brands are a grouping/filter within the account, not a separate workspace or separate billing per brand.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Can I get a separate login/subscription per brand?" | Not what this feature is, it's a filter/grouping on the existing single account, not multi-tenant workspaces | Explain clearly so they don't expect separate billing or separate team access per brand, that's a bigger ask, log as feedback |
| "I can't create another brand / says I've reached my limit" | They're at their plan's brand cap (Free 1, Starter 2, Pro 4, Business 7) | Have them delete a brand they no longer need, or upgrade for more. This is a real per-tier cap, not a bug |
| "I don't see the brand filter dropdown" | The filter only appears once at least one connected account is assigned to a brand | Have them create a brand and assign at least one account, in Accounts |
| "I assigned an account to a brand but posts aren't showing up filtered" | The filter is opt-in per view; each tab has its own dropdown defaulting to "All brands" | Check the dropdown at the top of that specific tab is actually set to the brand they expect |
| "What happens to an account I haven't assigned to a brand yet?" | It shows under the "Unbranded" option in the filter, and always shows under "All brands" | Reassure nothing is hidden or lost, just uncategorized until assigned |
| "Does assigning an account to a brand change what it can post to / connect to?" | No, a brand is purely organizational grouping, doesn't affect posting, connections, or permissions at all | Safe to reassure this is cosmetic/organizational only |

### "Why this worked" AI insight (shipped 2026-08-08)
On the Analytics tab, a "Get AI insight: why this worked" button compares the customer's best- and worst-performing posts in the currently selected date range/brand and generates a short note on what differs plus one concrete suggestion for the next post.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "It says not enough data yet" | Needs at least 4 posts with real engagement numbers in the selected range, posts too fresh haven't collected engagement yet | Explain the threshold, suggest widening the date range (7/30/90 day picker) or checking back after more posts have had time to collect metrics |
| "The insight seems vague / says the pattern isn't clear" | Working as intended, the AI is instructed to be honest rather than force a pattern that isn't really there in a mixed or low-signal sample | Not a bug, this is deliberate honesty over a confident-sounding guess |
| "Does this run automatically / will I get spammed with insights?" | No, on-demand only, click the button each time, never runs automatically per post | Reassure it's opt-in each time, not a background feature |
| "Does this count against my AI generation limit?" | Yes, same daily quota as captions/hashtags/content ideas | Point to the same daily-limit messaging if they hit it |
| "Does it respect my brand filter?" | Yes, whatever brand filter is set on the Analytics tab when they click the button is what the insight is generated from | Confirm the right brand is selected before generating if they expected a different result |

### Two-factor authentication (shipped 2026-08-26)
Optional TOTP-based 2FA, set up from the **Settings** tab: scan a QR code with any authenticator app (Google Authenticator, Authy, etc.), confirm a 6-digit code, done. 10 single-use recovery codes are shown once at setup and can be regenerated later from the same section (regenerating invalidates the old set).

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Does LazyRelay have 2FA?" | — | Yes, optional, Settings tab. Not on by default. |
| "I lost my phone / authenticator app AND my recovery codes" | No self-serve override exists for this combination | Escalate — this needs manual account verification, don't attempt to talk them through a workaround that doesn't exist |
| "I lost my phone but still have my recovery codes" | Normal, expected recovery path | Have them use a recovery code to sign in, then re-enroll a new authenticator app from Settings |
| "Can I turn 2FA off?" | Yes, self-serve, but requires being signed in with 2FA already completed | Point to the "Remove two-factor authentication" button in Settings; if they can't get past the 2FA prompt itself, that's the lost-phone-and-codes case above |

### Google Calendar sync (shipped 2026-08-21 through 2026-08-31, phases 1-3)
Two-way sync between LazyRelay's scheduling and a dedicated "LazyRelay Posts" calendar on the customer's own Google account. Connect/disconnect from the **Settings** tab.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "How do I connect Google Calendar?" | — | Settings tab, Connect Google Calendar, sign in with the Google account they want to sync to |
| "I moved/edited/deleted an event on Google Calendar, will LazyRelay update?" | Yes, real-time push (not polling) | Reassure it syncs within seconds automatically |
| "I created a new event directly on the LazyRelay Posts calendar, why didn't it post to Instagram?" | Google Calendar has no concept of "which platform" — a Calendar-created event becomes a planned idea in LazyRelay, not an auto-scheduled post | Explain they need to open that planned idea in LazyRelay and pick the platform(s) themselves |
| "If I disconnect, does it delete my Google Calendar / the events on it?" | No | Reassure — disconnecting only stops future syncing, the calendar and its existing events stay on their Google account |

### Google Sheets export (shipped 2026-09-02)
Outbound-only live mirror of the content calendar into a Google Sheet in the customer's own Drive. Connect/disconnect from the **Settings** tab — a separate connection from Google Calendar, not the same toggle.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Can I share my content calendar with a client who doesn't have LazyRelay?" | Exactly the use case this was built for | Point them to Settings → Connect Google Sheets, then share the resulting spreadsheet from their own Google Drive |
| "I edited the spreadsheet but nothing changed in LazyRelay" | Outbound-only by design, editing the Sheet doesn't feed back in | Explain it's a read-only mirror for sharing, not a two-way edit surface (unlike Calendar sync above) |
| "If I disconnect, is the spreadsheet gone?" | No | Reassure — the spreadsheet stays in their Google Drive, disconnecting just stops future updates to it |

### Browser extension (shipped 2026-07-31)
Right-click any page, link, or image to send it to LazyRelay as a draft post. Not on the Chrome Web Store — manual install only.

| Customer says... | Likely cause | Fix |
|---|---|---|
| "Where do I download the browser extension?" | Not on the Chrome Web Store yet | Point to the install guide (chrome://extensions → enable Developer Mode → Load unpacked); set expectations this is a manual, slightly technical install, not a one-click store install |
| "The extension isn't doing anything when I right-click" | Needs an already-signed-in LazyRelay tab open somewhere in the browser | Have them sign in to the dashboard in a tab first, then retry |

### Security & data
- **"Did you post something I didn't schedule?"** — first clarify whether it's a token compromise or a password compromise (different severity), give the exact platform-side revoke path, and if it's systemic (not one account), commit to a public status update. Fast and plain-language beats hedging (this is literally why Buffer's 2013 breach response is still cited as the industry model).
- **Disconnecting an account** — always give BOTH steps: (1) disconnect inside LazyRelay, (2) also revoke access on the platform's own app-permissions page (link directly to Meta/TikTok/Pinterest's page). Don't assume step 1 alone fully revokes access.
- **"Delete my data" / GDPR requests** — should be self-serve in-product once built; until then, acknowledge the request and give a concrete timeframe (don't let it drag past ~30 days — that's when these escalate to formal/legal language).
- **"What happens to my data if I cancel?" (added 2026-08-15)** — real, live policy: cancelling does NOT delete anything immediately. Access continues until the end of the paid period, then **30 days after that**, posts and uploaded media are permanently deleted (reminder email sent 7 days before, at the 23-day mark). Resubscribing before the 30 days are up cancels the deletion — nothing is lost. This is the one place in the whole product data ever gets deleted automatically; hitting a storage quota while still subscribed still just blocks new uploads, never deletes anything. See Terms of Service ("Cancellations and refunds") and the Data Deletion page for the exact customer-facing wording — answer from those, don't paraphrase differently.

### Content/platform-policy responsibility
- LazyRelay schedules and verifies publication — it does not set or enforce what content is allowed. That's entirely each platform's own rules (already stated in the site's Disclaimer/Privacy Policy). Answer this matter-of-factly, link the specific platform's guidelines relevant to the complaint, don't get defensive.

### Billing disputes, refunds and "I was charged" (consolidated 2026-09-16)
- **A customer saying they were charged is now most likely telling the truth.** Never tell a customer they cannot have been charged.
- **A refund, double-charge or billing-error claim is a no-reply hard case** (rule (e)). It needs Werner's decision and a look at the real Paddle transaction. Flag it and post to Slack. Never answer it from a template.
- A plain pricing or plan question = **Template 3**. Cancelling, or confirming a cancellation = **Template 14** (never state an end date yourself; this agent has no database access).
- **First innocent explanation for two charges in a month: a storage add-on.** Plan and add-on are separate Paddle subscriptions with separate receipts (proven 2026-08-11).
- **There is no invoice or charge history in the dashboard** (confirmed by code search 2026-08-26). Paddle's receipt emails are the only customer-visible record. Never tell a customer to check invoices in the dashboard.
- **From 2026-09-07 Paddle sends one combined welcome-plus-receipt email per new subscription** instead of two. A missing second email is not a billing defect. Two subscriptions still produce two emails.
- **A `[TEST]-` subject prefix, a card ending 4242, or a price that doesn't match the live catalogue = Paddle Sandbox**, not a sale. No reply, one report line, no Slack *(archive: 2026-08-22)*.
- **Paddle mail at `accounts@` can belong to another of Werner's products** (they share the seller account). Read the product or domain named in the body before treating it as LazyRelay's. Never fold another product's figures into a LazyRelay report beyond noting the mail exists.

#### What the widget may say while still escalating a double-charge/refund claim (approved 2026-09-03, from the weekly support-gap digest)
This is still a no-reply hard case for the email agent (escalate rule (e), unchanged) — this section only governs what the AI chat widget (`chatKnowledge.ts`) can safely say while escalating, not permission to start resolving refund claims by email or chat.
- **Never quote "no refunds for partial billing periods" at a double-charge claim.** That policy (`TermsOfService.tsx`, "Cancellations and refunds") is about cancelling partway through a month — it says nothing about a duplicate or erroneous charge, and citing it here reads as refusing a refund for a billing error. The Terms' own contact line explicitly invites refund requests "outside the standard policy" to hello@.
- **First thing to check against the real Paddle record: whether the customer has a storage add-on.** Plan and add-on are separate Paddle subscriptions with separate receipts (proven live 2026-08-11: Starter $29.99 and Storage $2.99 produced two subscriptions and two receipts, uids 99-102) — the most likely innocent explanation for two charges in one month.
- **There is no invoice/charge history in the dashboard** — confirmed 2026-08-26 by direct code search: zero matches for invoice / receipt / customer-portal across `frontend/src` and `backend/src`. Paddle's receipt emails are the only customer-visible record. Never tell a customer to "check their invoices in the dashboard" (this also closes the 2026-08-11 gap-analysis open question "does an in-app invoice list exist?" — it does not).
- Origin: 2026-08-19 `accounts@` uid 140 escalation ("I think I was charged twice this month, can I get a refund"), self-reported `jordan.smith@example.com` — Werner confirmed the same day this was his own Zapier test traffic, not a real customer. Drafted and approved anyway since the underlying question is one a real customer will eventually ask. See the weekly gap-digest run log in [[project-gemini-faq-gap-analysis-2026-08-11]].

### AI support-widget escalations (consolidated 2026-09-16)
Sender `"LazyRelay Support Widget" <noreply@mail.lazyrelay.com>`, subject **"Support widget escalation"**, body is the verbatim user/assistant transcript. **Never reply to `noreply@`** — it's unmonitored.
- **They land at any of the three customer mailboxes** (routed by the conversation's topic) and **often arrive already read**, so the `search-all "@"` sweep is what catches them.
- **Classify by the escalated conversation's content**, exactly as if the customer had emailed directly. A documented scenario stays documented; a hard case stays a hard case.
- **The `Customer:` line has three shapes:**
  - **Logged in:** address plus account UUID.
  - **Anonymous, self-reported:** unverified. **Confirm the address actually appears in a `user:` turn before treating it as a lead**, and never send account-specific or billing information to it.
  - **Nothing captured:** unreplyable from the mail alone. It must be answered from the app's own conversation records.
- The extractor was fixed 2026-08-17 (user turns only; our own domain skipped). **If that logic is touched again, run `npx tsx src/test-support-chat.ts` in `backend/` first.** Escalations older than 2026-08-17 12:48 UTC still show the wrong failure-alert footer — history, not a live defect.
- **Test-traffic markers:** a `[TEST - James verification, please ignore]` prefix, or RFC 2606 reserved TLDs (`.invalid`, `.example`). Handle test traffic exactly like the real thing, but don't report it as a buying signal. **Absence of markers is not evidence of a real customer.** When an escalation carries no identity and matches something Werner was testing that day, report it as "unattributed, possibly test traffic" and check the daily note first *(archive: 2026-08-10 to 2026-08-19)*.

### Compliance, security-posture and data-residency questions — never answer (rule (c))
Covers SOC 2, ISO 27001, HIPAA/BAA, PCI, a GDPR Data Processing Agreement request, security questionnaires (VSAQ/CAIQ/SIG), pen-test results, a subprocessor list, and "which region / what physical address is our data in" for a vendor file.
- **Handling: no reply, no draft, escalate to Slack, flag in the report.** Route it to Werner even when the answer looks obvious or the infrastructure facts are knowable. A compliance answer is a binding representation about the business, not a support fact.
- Don't infer certification status from company size or from the absence of a note here. Werner's Information Regulator (POPIA) registration is **not** an answer the agent may give.
- A real vendor security review is a buying signal worth telling Werner about, unless it's test traffic *(archive: 2026-08-11, 2026-08-17)*.

### Unsolicited "vulnerability report" with a bounty ask — never answer
The "beg bounty" genre: a mass-mailed DNS lookup dressed up as a disclosure, closing with a request for payment.
- **Handling: no reply, no draft, marked read.** Any reply is a statement about our security posture to someone who has said they'll keep probing, and there is no bounty policy to answer from.
- **Check the claim yourself anyway, because the substance can be real.** Run the DMARC and SPF lookups against `8.8.8.8`. As of 2026-09-11: `_dmarc.lazyrelay.com` = `v=DMARC1; p=none; rua=mailto:hello@lazyrelay.com;`. The apex SPF is `v=spf1 +a +mx +ip4:156.38.153.210 ~all`, with `~all` kept deliberately until DMARC reports confirm nothing legitimate breaks.
- **The hello@ email-spoofing reporter (first mail 2026-09-08) is DECIDED:** Werner, 2026-09-09 — no reply, leave it. Every chase from that sender is the same decided item under a new uid. No Slack.
- If the genre recurs from a new sender: re-run the two lookups. If the finding is unchanged, don't re-escalate. DNS fixes are Werner's *(archive: 2026-09-08, 2026-09-11)*.

### A near-blank inbound is not hard case (a) — ask what they need
A one-word or subject-less email contains no request to get wrong. **Test: does a useful reply have to claim something** about the product, an account, money or a policy? If yes, it's a hard case: hold it. If the whole reply is "tell us what you're trying to do," send it directly, mark read, no draft, no Slack. Report a free-mail, no-subject, one-word sender as a likely probe or mis-send, not a lead *(archive: 2026-09-01)*.

### Trust (being a new/small player)
- Lead with Proof-of-Publish as the concrete reliability differentiator ("we don't just trust that the API said yes, we independently check the post is actually live") — this is the strongest trust asset available and should be mentioned in any "is this reliable / will you be around" type question.
- Responsiveness is the actual trust variable users care about (not company age/size) — reply fast, in plain language, no bot-only stalling.

### Other categories to be ready for
- Feature requests for unsupported platforms (LinkedIn, Threads, Bluesky, YouTube Shorts) — acknowledge and log, don't overpromise a timeline.
- "Why don't I have analytics" — expected if/when a feature is tier-gated; be upfront about which tier includes it.
- Team/seat questions — LazyRelay currently has no multi-user/org schema; be upfront that team seats aren't available yet rather than improvising an answer.
- API/rate-limit confusion — customers will blame LazyRelay for platform-imposed caps (Instagram's 25/day, TikTok's daily cap, etc.) — this is likely the single highest-volume root cause behind "why won't it let me post" tickets industry-wide; always check whether it's a platform-side cap before treating it as a LazyRelay bug.

---

## Part 2b — Vendor and platform threads

### Status board (as of 2026-09-16)
| Thread | Mailbox | Status | Next expected event | Standing handling |
|---|---|---|---|---|
| **TikTok Direct Post audit** (`noreply@dev.tiktok.com` sends automated notices; `tiktokfordevelopers@tiktok.com` answers support ticket `8ed39c9bce67f365`) | `accounts@` | **APPROVED 2026-09-21** (uid 216, 06:01 UTC). Escalated to Slack same run; Current product state and Part 1's TikTok row updated in the same pass | Werner's decision on resuming the 1,160-post batch, then a real public-account post to prove the capability | **Verdict received — do not re-escalate it.** A further status change (the capability test passing or failing) is a fresh Slack item. "A decision is delayed" is not a status change. Match on subject and content, never on sender (three sender shapes). The rejection reason sits in a hover tooltip on the ⓘ icon next to "Reapply" in the portal and is not customer-facing. No reply to `noreply@` |
| **Snap ad-support ticket 05490701** (`ad-support@snapchat.com`) | `accounts@` | **Parked.** Allowlisting needs an assigned Account Manager; no ETA; ad-support has no further moves (Ron, 2026-08-17) | Inbound only: AM contact or an API-team reply | **Don't reply to inactivity-timer check-ins.** Ron confirmed that a reply after an auto-close opens a linked request carrying the full history, so letting it close costs nothing. Never reply "Resolved". Keep the `[ thread::-gA1MDoEcNa13ooQvtJd0Ac:: ]` token verbatim if a reply is ever needed. Ads prompts (funding source, payment method, business-email verification) don't apply to us |
| **`profile-api-dev-support@snapchat.com`** | `accounts@` | Silent. Five messages from us (2026-08-03 request, 08-13 mailing list, 08-19, 08-26 and 09-02 chases), none answered | Inbound only | **Never send to this address without Werner's say-so.** The three chases were undocumented agent sends against the hold; a hard guard in the task file has been with Werner since 2026-08-26. See the chase-pattern watch below |
| **Paddle seller support** (`sellers@paddle.com`) | `accounts@` | **Closed 2026-08-19** on both sides. Business and identity verified; display name "LazyRelay" confirmed on receipts and statement descriptor | None | `sellers@paddle.com` also sends one-way product broadcasts. Match on subject, and read them for customer-visible changes. No reply to `help@` / `no-reply@paddle.com` transactional mail |
| **Pinterest API Ops** (Zendesk) | `accounts@` | **Closed 2026-08-04** (Standard access) | None | — |
| **Google OAuth: YouTube** (reply token `+15csgvdem6kka1d`, project `978463501573`) | `accounts@` | **Approved 2026-08-14** | None | Same subject line as the Calendar review — don't conflate |
| **Google OAuth: Calendar/Sheets** (token `+186nvitpvhqvk1d`, project `301758284445` / `lazyrelay-calendar`) | `hello@` | **Approved 2026-09-05** | None | A compliance reply in Werner's name is not autonomous-send work |
| **Meta App Review** (LazyRelay Social, App ID 1649594756135169) | `support@` + `accounts@` | **All permissions approved 2026-09-04** | None | "Your App Review results are ready" never states the verdict; only the dashboard does, and reading it is user-only. "Data access renewal is complete" is the routine annual Data Use Checkup, a different mail — match the subject |
| **Reddit API access ticket K7X3KX-R4K95** | `accounts@` | Open. No reply since the 2026-07-24 intake receipt | A Reddit reply in INBOX | See the Part 3 baseline |
| **Twelve Tools / Wired Business** (Sam, Amphibian Digital) | `hello@` | **Closed 2026-09-01**, both listings manually approved | None | Whether to chase the crawler UA/IP is Werner's campaign call |

**Known IDs, safe to use in vendor mail:** Snap OAuth client ID `a37883b6-7dcd-4a60-b2e3-63f6c26925e9`, Snap org ID `d76fc825-c25c-4361-98bf-5a8325f3dafd`, TikTok App ID `7666018240841254930`. **Never put a client secret in outbound mail.** The Render hostname `lazyrelaylazyrelay-backend.onrender.com` is real, not a typo; never "correct" it inside a quote.

### Snapchat chase-pattern watch — DORMANT (scored 2026-09-17)
Agent sends to `profile-api-dev-support@snapchat.com` went out **2026-08-19, 08-26 and 09-02, each at the 08:22 UTC slot**, each with a doubled signature. **2026-09-09: no send. 2026-09-16: no send** (re-checked 2026-09-21: newest `accounts@` `INBOX.Sent` item is still uid 31, 2026-09-02 08:22:22 UTC — three consecutive misses now). Two consecutive misses, so the pattern is **dormant**. Keep one glance at `INBOX.Sent` for anything newer than uid 31 during the sweep; a send restores the weekly reading.
- **Two consecutive misses = the pattern can be called dormant.** A send restores the weekly reading.
- **A negative check on a scheduled send only counts if it runs after the predicted slot.**
- A quiet week raises no decision. Don't re-post to Slack. The open ask with Werner (a hard guard in the task file) stands either way *(archive: 2026-08-19 to 2026-09-16)*.

### Vendor-thread rules (distilled from the threads above; evidence in the archive)
1. **Acknowledgment rule.** Vendor mail that only confirms, acknowledges or promises follow-up, with no ask: mark read, report, don't reply. A courtesy "thanks" re-queues a settled thread to a fresh agent *(Paddle 2026-08-02)*.
2. **Close prompts.** A trailing "reply Resolved" footer on a message whose body commits to keeping the thread open is boilerplate: no reply. A close prompt while our ask is still unanswered gets a short reply declining the close. A standalone automated inactivity mail whose whole body is the close threat normally gets a brief reply quoting the vendor's own commitment. **Exception: Snap ticket 05490701** (see the status board).
3. **When a vendor asks "is there anything left?"**, answer plainly and give them permission to close *(Paddle 2026-08-18)*.
4. **When a vendor contradicts its own earlier answer**, quote both statements verbatim with dates and sender names and ask them to reconcile. It's a factual question, not a hard case *(Snap 2026-08-09)*.
5. **When a vendor can't see something our records say we did**, send the timestamp and the observable evidence we actually have. Offer to resubmit. Don't overclaim a confirmation the platform never showed *(Pinterest 2026-08-04)*.
6. **A vendor's "it's done" closes a thread only until an observation contradicts it**, and a later observation can close it again. A vendor saying an automated process has been disabled is a claim about a system: wait for its next tick before writing the cost down to zero *(Paddle 2026-08-13/14; Snap 2026-08-16)*.
7. **Retract our own stale premise quickly, whether the news is good or bad.** Before any vendor reply, re-check the thing our last message called impossible, and check the vault daily notes for a newer observation *(Paddle 2026-08-16/18)*.
8. **"We can't attach a screenshot" is not "we can't supply the evidence."** Quote the Sent-folder original with its Message-ID and timestamp, and offer an image as a fallback *(Snap 2026-08-08)*.
9. **If Werner wrote a conditional instruction in a thread and the vendor's reply meets the condition, complete the loop.** Restate the exact scope in the reply *(Paddle 2026-08-12)*.
10. **Evidence only the user holds** (registry screenshots, ID verification, dashboard verdicts, an unknown identifier) → a half-ready draft, stated plainly in the report. Never invent an identifier. Before calling an ID unobtainable, look for it in the tracking URLs of that vendor's earlier automated mail *(Snap 2026-08-01)*.
11. **A newer vendor message that changes the ask makes an older draft stale.** Delete it and draft against the new message.
12. **Before sending any vendor reply, check `INBOX.Sent` twice over:** has this message already been answered (duplicate guard, 2026-08-18), and does this file mark the thread on hold (policy guard, 2026-08-19)? **A doubled signature in a Sent item means the body file carried its own sign-off.** That is never correct, and it's the tell of an agent send. A single personal signature is evidence the send did *not* go through `send-mail`. Check the vault note attached to a draft before calling an unexplained outbound unauthorised *(2026-09-01)*.
13. **When a claim to a vendor is about a page, verify the page the reviewer loads.** For a client-rendered page, render it in a browser and check the bundle. `curl` alone gives the wrong answer on React routes *(Google 2026-09-03/04)*.
14. **A platform approval mail proves app-level approval, not a customer capability.** Prove the capability with a real post to a real public account, and treat that confirmation as blocking *(TikTok 2026-09-05)*. Check the vault's portal records before calling a grant unknown. Google's approval mails list only sensitive and restricted scopes *(2026-09-05)*.
15. **A platform's stated review window is a forecast, not a schedule.** Keep sweeping threads the vault says are quiet *(Google 2026-08-14, 2026-09-05)*.
16. **An identical reviewer reason string is not evidence of an identical cause.** Read the specific note and test the capability *(Meta 2026-08-25)*.

---

## Part 2c — Every-run process rules and non-customer inbound

### Process rules
- **Run the `search-all <mailbox> "@"` full-folder date sweep on all four mailboxes every run**, and compare the newest hits against the last recorded action in this file. Mail regularly arrives already marked read and never shows in `list-unread`: Snap, TikTok verdicts, Paddle, Google and widget escalations have all done it, a dozen-plus times. A read flag means something marked it, not that it was dealt with. **Never narrow the sweep to INBOX.**
- **`sort-mailbox` sorts on a header, not on judgment.** A `List-Unsubscribe` header sends real platform notices to `INBOX.Promotions`: `noreply@developers.facebook.com`, `security@facebookmail.com`, `security@mail.threads.net`, `security@mail.instagram.com`, `sellers@paddle.com` broadcasts, `pinbot@info.pinterest.com`. Read and mark read before sorting. Never predict the folder from the sender; Pinterest's subdomains differ.
- **`mark-read` only works on INBOX.** Passing the old uid of a message that was just sorted silently does nothing. That's benign; don't chase it.
- **Match on subject and content, never on sender alone.** One address can send unrelated shapes (TikTok, Meta, Paddle, Pinterest).
- **Before reporting any action item from inbound mail as open, read the day's daily note** (and, for directory mail, the tracker CSV or the vault note attached to a draft). Werner works these within the hour, so the mail is usually older than the state.
- **Before reporting a rejection or failure, look for a newer message from the same sender about the same object.** For a forwarded CI failure, check the named commit against `git log`: GitHub sends nothing when the next run passes.
- **When our own record and a newer mail disagree, check the live observable** (fetch the page, run the DNS lookup). For `curl` against a directory, send a browser user agent and check the status code, not just whether the product name appears.
- **Never infer a real-world action's status (paid, enrolled, done) from the read state of mail about it.**
### `get-message` body extraction — HTML-only is fixed, footer-only is not
- **Fixed:** `extractBody()` in `imap-tool.js` (checked 2026-09-16) falls back to the HTML part when there is no `text/plain` part, and returns `bodySource` as `"text"`, `"html"` or `"none"`. An HTML-only email no longer comes back looking empty. The original defect write-up is in the archive *(2026-08-22)*.
- **Still open:** the fallback only triggers when the text part is *empty*. When the text part is only a footer (an address block plus tracking links), `bodySource` reads `"text"` and the real content sits in `parsed.html`. **If the body is only a footer, re-read the HTML before classifying.** Confirmed three times on Pinterest mail *(archive: 2026-09-03, 09-11, 09-15)*.
- **`bodySource: "none"` means genuinely no readable body.** Never mark a message read on the strength of a body you couldn't read.

### Mailbox argument must be the FULL address, not the short name (added 2026-08-27)
Every `imap-tool.js` command takes the mailbox as its **full address** — `support@lazyrelay.com`, not `support`. The keys in `credentials.local.json` are the four full addresses (`hello@` / `support@` / `accounts@` / `werner@`), and a short name fails with `No credentials entry for "support" in credentials.local.json`.

The failure is loud, so it can't be mistaken for an empty mailbox — but it costs a wasted round trip on first use each session. Found again by `lazyrelay-billing-ops-daily` 2026-08-27 running `list-unread support`. Note the contrast with the `get-message` defect above: that one fails *silently*, this one fails *safely*. Neither should ever be read as "no mail."

### Self-initiated account and security mail
- **Platform OTPs, confirm-your-email and registration mail** (including platforms we have no adapter for, e.g. Bluesky, and LinkedIn's "API access request" OTP): mark read, one report line, never draft. **An OTP naming an API application shows Werner started a registration. It never shows an adapter exists.**
- **Login alerts:** read the location in the body. Klein-Brakrivier / Mossel Bay on Windows + Chrome is Werner. An unfamiliar device or location gets flagged prominently.
- **OAuth grant alerts** (these name an app and no location): a LazyRelay-owned app or domain, or a tool Werner is known to use (Thunderbird, the browser, npm, AWS CLI) → mark read, note briefly. The alert names the app, never the scope, so don't tie it to whichever integration you happen to be tracking. A genuinely unrecognised app gets flagged.
- **Password-reset instructions followed by "password changed" in our own mailbox** = a self-service reset. A standalone "password changed" with no reset mail before it gets flagged.
- **A cluster of protective changes** (2-step verification on, second factor added) on our accounts = Werner hardening them. Flag it if it comes with an unrecognised sign-in, a recovery address or phone changed to something unfamiliar, or a protective change arriving alone during a quiet period.
- **npm:** token creation → a publish from `196.210.7.60` under `@lazyrelay/*` = Werner. **An expiring or expired token is not a blocker:** CI publishes via OIDC trusted publishing, and only a manual local `npm publish` needs a fresh token. Flag a publish with no token-creation mail before it, a package outside `@lazyrelay/*`, or an inconsistent IP. More generally, **an expiring credential is only a deadline if something still uses it**; read the workflow that would consume it first.
- **A Meta alert about another of Werner's projects** (read the account names in the body): note that the mail exists and stop there.
- **Mail from a regulator's portal** (registration, OTP, certificate from a `noreply@` sender) is self-initiated. The auto-escalate rule is about a regulator *contacting us*: an enquiry, complaint, information request or notice with a human sender or a case reference.
- **Bing Places for Business** (`bp-norep@microsoft.com`, subject "Claim your free Bing listing", landing at `support@`): Werner's own listing setup, not a cold pitch. The tell is `notification@facebookmail.com` "You logged into Bing Places for Business with Facebook" (2026-09-17 10:53 UTC) sitting alongside it — a self-initiated OAuth login. The Microsoft mail is an unmonitored-mailbox marketing nudge and repeats (09-17, 09-19). Mark read, one report line, never a tracker row and never a reply *(first seen 2026-09-21)*.

### `werner@` (never marked read)
- **It carries operational mail for several of Werner's businesses.** Ask "which business is this?" before "is it urgent?". The other-business list is kept out of this public file, in the vault at `09 - Resources/Ops-QA/reference-werner-mailbox-other-businesses.md`. For another business's mail: note it exists, nothing more.
- **For a `Fwd:`, read the forwarded header's own `Date:`.** Werner clears his personal inbox in batches, so an old date means history he's already handled.
- **A dollar figure plus a deadline is not an obligation.** Check who it's addressed to (test personas like "Werner Test Client") and look for a "paid on" line. A decided-to-lapse subscription sends dunning-shaped mail on its way out; the figure in it is a quote, not an invoice.
- **Acquire.com digests** are buyer-side marketplace newsletters from Werner's signup. Don't infer intent from them. Fold into a count.
- **An infrastructure-vendor broadcast is judged on whether it touches a system we depend on**, not on whether it asks for action. First instance: Cloudflare replaced "Block AI Bots" with Search / Training / Agent controls, migrating over the week from 2026-09-15. `lazyrelay.com` is on Cloudflare, and Bot Fight Mode already broke directory verification once (2026-08-29 to 09-01). This task can't see the zone's settings. **Watch for any directory or platform crawler failing to verify `lazyrelay.com` in the week after 2026-09-15.** Report line, no Slack *(archive: 2026-09-16)*.
- **Decisions on specific `werner@` items:** Part 3's standing dispositions table.

### Pinterest mail
- **The `recommendations@` consumer digests** (subdomains `discover`, `inspire`, `explore`, `ideas`) are noise, **but read the subject.** `discover` once carried a real Terms of Service notice.
- **`pinbot@info.pinterest.com`** (monthly developer newsletter) and **`pinbot@legal.pinterest.com`** (notices): read them for anything landing on an endpoint we call. LazyRelay posts organic Pins and runs no Pinterest ads, so Ads API, conversions and ad-URL items don't apply. Report line, no Slack. **What would flip it:** an organic Pins or boards endpoint deprecation, a Standard-access rate-limit or scope change, or a dated developer-terms re-acceptance.
- **`pinbot@legal.pinterest.com` also carries the verdict on a blocked-link/domain appeal** (subject "Your domain suspension", first seen 2026-09-17). **A verdict either way is a status change: post it to Slack and name the decision it forces**, because a spam-blocked destination URL keeps failing every queued Pin that points at it, each failure fires an ops alert, and a run of blocked links puts the connected Pinterest account's own standing at risk. **No reply** — the sender is unmonitored and a further appeal goes through Pinterest's Help Center, which is Werner's call. The block is per-destination-domain, not per-account: read which domain the body names before assuming which scheduled posts it touches.
  - **The first instance is CLOSED — `accounts@` uid 208, 2026-09-17 22:38 UTC: the appeal for another business's domain (the one named in the vault note referenced above) was rejected.** The decision it forced was taken the morning of 2026-09-18 in a separate session (Werner's own call): the 71 pending Pins for that business were paused, verified as only those posts. **Never re-escalate uid 208** — it is a decided item. LazyRelay's own domain was never blocked.
  - **Standing rule from it: before Slack-escalating any verdict mail, read the day's daily note first.** Werner works Pinterest/platform incidents live with other sessions, often within the hour, so a verdict that arrives overnight is frequently already decided and executed before this task's next run sees it. A verdict is only a Slack item while the decision it forces is still open.
- **A run of failing posts trips the scheduler's circuit breaker, and that breaker is keyed on the platform, not the account** (`backend/src/scheduler.ts`: `breakers` is a `Map` on `platform`; 5 consecutive failures → all posting to that platform paused 5 minutes). Tripped posts are un-claimed and retried, not failed, so nothing is lost. Two things follow:
  - **Support angle:** "my post didn't go out at its scheduled time" on a platform with no error of its own can be a breaker trip caused by *unrelated* failures elsewhere. Check for a circuit-breaker ops alert around that timestamp before treating it as an account-specific bug.
  - **Escalation angle — state the blast radius, don't assume it.** The code fact above is about the *platform*; who it actually reaches is a question only the `social_accounts` table answers, so query it before calling a breaker trip customer impact. **Corrected 2026-09-18:** an earlier run escalated a Pinterest trip as degrading service "for every customer" straight off the platform-wide code path; all four Pinterest connections in the system turned out to belong to Werner's own internal account, so no customer could be affected at all. A true statement about the code became a false statement about the world. The part that does hold either way: hammering a platform that is already rejecting us can get LazyRelay's app-level API access throttled or flagged, and that is usually the fact that forces the decision.

### Directory campaign and cold pitches (mostly `hello@`, sometimes `accounts@`)
Context: Werner's directory-submission campaign, run from `hello@` since 2026-08-27. The tracker is the vault's `03 - LazyRelay/Growth/lazyrelay-directory-submission-tracker.csv`. Product Hunt launched 2026-09-02.

| Shape | Handling |
|---|---|
| Automated welcome / verify / OTP / login link / leaderboard / digest from a directory we signed up to (also identity services like Gravatar or Auth0 during signups) | Mark read, count only, never draft |
| A receipt carrying a deadline (badge within 24h, finish listing within 30 days) | Check the daily note and tracker for a newer state. If still open, name it and its date in the report. Not Slack |
| A human asking something only we can answer about **our own** listing | Template 10 vendor correspondence |
| A cold pitch offering a **free** listing on a directory we're not on, **including a free tier with conditions** such as a badge | A tracker candidate row, reported as a listing opportunity. Flag the badge-maintenance tail. No reply |
| Any **paid** listing (whatever the fee), paid services (SEO, Reddit seeding, promo packages), a free **trial** of their product, a content-syndication invite, a source-code sale | Vendor solicitation: mark read, one line, no tracker row, no Slack |
| A sales-sequence upsell off a free listing we hold (e.g. SaaSworthy's HubSpot cadence), or a directory re-pricing a submission already in its free queue (e.g. SpotSaaS $399) | One report line. The stays-free-only policy already decides it. Never a second row |

- **The discriminator: would this put LazyRelay in front of buyers on someone else's site, for free?** Judge the ask, not the flattery or effort in the preamble. Apply it to the cheapest tier that actually lists us.
- **Tells of untargeted bulk mail:** misdescribing the product, a broken merge field (proves bulk sending, not irrelevance), a `google.com/search?q=` link instead of a real URL, a sending domain that doesn't match the product domain, or a Product Hunt citation dated before 2026-09-02.
- **Match every pitch against the tracker by sending domain, including Declined and Parked rows.** The `@focusapps.app` cluster was declined, so every local-part under it (ten brands and counting) is one decided sender. A "one step away" reminder on a Parked row (e.g. BetaList) is not an open action.
- **Never answer a "reply 'no'" opt-out on Werner's behalf. Never pay, and never reply with a receipt. Never open demo links, use supplied credentials or join Telegram handles** from unsolicited mail.
- **Known loose ends (checked 2026-09-21):** LaunchIgniter (2026-09-04), LaunchBuck (2026-09-06) and **SellWithBoost** earned candidate verdicts but are **not in the tracker CSV**. Crozdesk's row reads `Submitted` (2026-08-28). Its Revleads acceptance gave 30 days (~2026-09-27) to finish the listing, and whether that happened isn't recorded.
- **SellWithBoost (`tim@sellwithboost.com`) — third and self-declared final mail, `hello@` uid 237, 2026-09-21.** It **resolves one of the two quality tells the 09-09 original carried** *(archive: 2026-09-09)*: the submission link is now a real URL (`sellwithboost.com/submit?tier=standard`), not a `google.com/search?q=` redirect, so the directory does have a live submission page. The Message-ID domain mismatch (`rp.backlinklog.com` vs `sellwithboost.com`) still stands. Tiers are now explicit — **free = nofollow link plus a badge on our site; $29 one-time = dofollow, no badge**. The cheapest tier that lists us is free, so the verdict is unchanged: **still a tracker candidate, still no reply**, with the badge-maintenance tail as the cost. Sender says this was the last check-in; treat further mail from it as the same decided item.

---

## Part 3 — Response Discipline

### Plain language + exact real navigation (added 2026-08-11)
Found live: this file told customers to "reconnect in Settings" — there is no "Settings" tab, hasn't been since the 2026-08-07 dashboard restructure, and never got caught because the rest of the file was actively maintained while this one detail quietly went stale (same failure pattern as [[feedback-support-knowledge-product-state-drift]]'s header-block rot, just in body text this time). Two standing rules from this:
- **Assume the customer isn't tech-savvy.** Say "reconnect your account," not "re-authenticate the OAuth token." A correct answer in the wrong vocabulary doesn't help someone who doesn't know what "OAuth" means.
- **Real dashboard tab layout, ground truth as of 2026-08-18** (read off `frontend/src/pages/Dashboard.tsx`'s `MAIN_TABS`/`MORE_TABS` constants this date, not from memory — verify against the code directly if this note and the code ever disagree, the code is the source of truth, not this line):
  - Always visible in the top nav: Overview, Posts, Calendar, **Social Platforms**, **API Keys**, **Settings**
  - Behind the "More" dropdown: Analytics, Mentions, DMs, Bio Page
  - **Settings is a real tab now and holds Storage, Team, Billing, and the customer's own profile settings** (Failure alerts, Webhook, Business Name) — all four used to be separate entries behind "More".
  - **"Accounts" no longer exists** — connected social platforms are on the **Social Platforms** tab. Never point a customer at "Accounts"; nothing is called that any more.
  - Never point somewhere without saying whether it's always visible or behind "More" — a customer who can't find a tab in the main row and isn't told to check "More" will assume it's missing, not hidden.

  **This block was wrong for a full day and it is the second time.** The 2026-08-17 restructure (Storage/Account/Billing merged into Settings; Settings and API Keys promoted to the top bar; "Accounts" renamed "Social Platforms") landed while this section still carried the 08-11 layout — including the rule *"Never say Settings, that tab doesn't exist"*, which had inverted from correct to actively wrong. Same failure as the 08-11 entry above, one restructure later. **Standing rule: a dashboard restructure is a support-doc change, not just a frontend change — re-read `MAIN_TABS`/`MORE_TABS` and sweep both support files for tab names in the same pass.** Every navigation line in this file and in `EMAIL_REPLY_TEMPLATES.md` had to be corrected on 2026-08-18 to catch up.

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

#### Standing dispositions for long-running `werner@` items (consolidated 2026-09-16)
`werner@` mail is never marked read, so these resurface on every sweep. **A decided item must never be re-flagged.** A disposition covers the *item*, not the uid, so match on topic: follow-on mail about the same subject under a new uid is the same item. When Werner decides something, record it here and stop reporting it.

| Item | Disposition |
|---|---|
| **Slack Pro trial** (uid 40; expiry notice uid 57) | **Decided 2026-08-17: let it lapse.** It lapsed 2026-08-20, which was the intended outcome. Silent |
| **Register Domain invoice 1528348** (uid 39) | **Paid** (Werner, 2026-08-19). Silent |
| **Loom Business + AI trial** (uids 62, 89, 122) | **Decided 2026-08-26: let it lapse.** It moved to Starter 2026-09-10, loop closed. Silent |
| **Runpod volume low balance** (uid 75) | **Decided 2026-08-29: let the volume lapse.** Nothing worth keeping is stored there. Silent |
| **Zapier trial** (uids 79, 86) | **Escalated 2026-08-30, still awaiting Werner. Don't re-escalate.** The trial ended 2026-09-01 and the account is on Free. LazyRelay's own Zap is two-step, which Free permits, but that's an inference from the build record and only Werner can confirm it |
| **GitHub 2FA enrolment due 2026-10-19** (uid 94) | **Open on Werner, deliberately not escalated.** If he hasn't confirmed enrolment by **2026-10-05**, post **once** to Slack as a date reminder that says plainly we can't see enrolment status. Then record his answer here |
| **Beg-bounty email-spoofing reporter** (`hello@`) | **Decided 2026-09-09: no reply.** Every chase is the same item |

**Never infer the status of a real-world action from the read state of the mail about it.** A reminder about money must be phrased as a date reminder that says we can't see payment status *(archive: 2026-08-13 to 2026-09-10)*.

### Reddit ticket check now returns 2 results, not 1 (added 2026-07-31)
The daily `search-all "accounts@lazyrelay.com" reddit` check baselines against "exactly 1 known auto-ack." As of the 2026-07-30 follow-up it returns **two** hits: the original `support@reddit.zendesk.com` intake receipt (INBOX, 2026-07-24) **plus our own outbound follow-up** (`INBOX.Sent`, 2026-07-30). The Sent-folder hit is ours, not Reddit replying — don't raise it as news. Only treat it as a real reply if a hit appears in **INBOX** from a Reddit address dated after 2026-07-24.

- If a ticket doesn't clearly match anything in this file, or feels unusual/ambiguous, **don't improvise** — draft nothing, flag it clearly in the run's report for the user to handle personally. Same standing rule as `<other business>`'s email agent.
- Replies that clearly match a documented scenario are **sent directly** (superseding the old draft-and-hold rule — see the Current product state section). Only the hard-case list gets saved as a draft for human review, and any draft still unsent past 24h must be flagged prominently in the run report.
- **Legal threats, safety concerns, and fraud accusations are handled via `LEGAL_SAFETY_FRAUD_ESCALATION.md`, not this file's normal send/draft logic.** Read that file whenever a message might fall into one of those three categories. It defines its own holding-reply templates (sent directly, never substantive) and mandatory immediate-Slack escalation — some sub-cases (real subpoenas/court orders, harm-to-self/others, minor-safety) get no reply at all, silent escalation only. Never improvise a substantive answer in any of these three categories.
- Log anything genuinely new (a real issue type not covered above) as an addition to this file, not just in the run report — this file is meant to grow the same way `<other business>`'s own knowledge files did.
