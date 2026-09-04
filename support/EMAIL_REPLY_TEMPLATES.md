# LazyRelay Email Reply Templates

Ready-to-send templates for `lazyrelay-email-operations`, the equivalent of The Lazy Download's Thunderbird Templates folder. The agent runs in full autonomy (see `SKILL.md` in the scheduled task) — for anything matching a template below, fill in the bracketed specifics from the customer's actual message and `SUPPORT_KNOWLEDGE.md`'s troubleshooting tables, then send directly via `imap-tool.js send-mail`. Don't invent a new structure/tone for a scenario that already has a template here — consistency matters more than novelty for routine replies.

**Tone rules for every template**: plain, direct, no corporate filler ("we value your business," "rest assured," "please don't hesitate"). Acknowledge frustration in one sentence max if the customer was upset — don't over-apologize. Always end with an actual next step, not just "let us know if you have questions." The signature is added automatically by `send-mail` — never write your own sign-off block, just end the body content itself.

If a real email doesn't fit any template below closely enough to reuse structure, that's a genuinely new scenario — write the reply from `SUPPORT_KNOWLEDGE.md`'s guidance directly, then add a new template here afterward so the next occurrence has one. Living document, same discipline as `SUPPORT_KNOWLEDGE.md` and The Lazy Download's `ETSY_KNOWLEDGE.md`.

---

## 1. Platform connection/posting issue (Meta/TikTok/Pinterest/etc.)

Use when a customer reports a specific connect/posting failure that matches a row in `SUPPORT_KNOWLEDGE.md` Part 1.

```
Hi [name],

Thanks for flagging this — [one-sentence restatement of what they're seeing, in plain terms].

[Cause, in plain language — no jargon like "OAuth scope" unless the customer used it first]. Here's the fix:

[Numbered fix steps, pulled from the matching SUPPORT_KNOWLEDGE.md row]

[If it's a known platform-side limitation rather than something LazyRelay can fix: say so plainly instead of implying a workaround exists.]

Let me know once you've tried that and I'll help if it's still not working.
```

## 2. "It's not live yet" premise mismatch — **RETIRED 2026-09-04, do not send**

**Every platform LazyRelay integrates is now at production access**, so there is no surface left for which this template's premise is true: Pinterest (2026-08-04), TikTok (2026-08-14), YouTube (2026-08-14), Facebook Pages (2026-08-24) and **Instagram publishing (2026-09-04, the last one)**. Sending it now would tell a customer their platform isn't live when it is — the exact stale-premise failure this file's maintenance rule exists to catch.

**A reported posting failure on ANY platform is now a real issue.** Troubleshoot it against `SUPPORT_KNOWLEDGE.md` Part 1 (Template 1 is the right starting structure), never with a premise mismatch.

Kept here rather than deleted for one reason only: if a *new* platform integration ships and is awaiting review, this is the correct shape for that case. **Before ever reusing it, re-read `SUPPORT_KNOWLEDGE.md`'s "Current product state" line and confirm the specific platform genuinely is not live** — don't trust this paragraph's date, and don't reuse it for any of the five platforms named above.

```
Hi [name],

Thanks for the report. Before I troubleshoot — can you confirm which account you connected this to and roughly when? [Platform] posting should be fully live, so if something's actually broken there I want to find the real cause rather than assume.

Once I hear back I'll dig into your account specifically.
```

## 3. Billing/subscription question (billing live as of 2026-08-11)

Use for general pricing/plan questions. **Billing went live 2026-08-11** — the previous version of this template told customers "nothing you're using today will result in a charge," which is now false and must never be sent. Always re-check `SUPPORT_KNOWLEDGE.md`'s Current product state line before sending, and quote the **display** tier names below, not the DB values.

Prices verified live 2026-08-11: Free $0 / Starter $29.99 / Pro $59.99 / Business $99.99 per month.

```
Hi [name],

Here's how the plans break down:

- Free — $0, no card required (3 connected accounts, 10 posts per account)
- Starter — $29.99/mo (20 connected accounts, unlimited scheduled posts)
- Pro — $59.99/mo (40 connected accounts, 5 recurring schedules)
- Business — $99.99/mo (100 connected accounts, unlimited recurring schedules)

[If they asked about a specific tier or limit, answer that directly here instead of listing all four.]

You can start on Free and upgrade any time from your dashboard — you'll only ever be charged for a plan you pick yourself.

Let me know if you want me to walk you through anything.
```

**Do not use this template for a customer disputing an actual charge** (double-charged, unrecognised charge, refund request). That's a real billing dispute now that payments are live — no reply, escalate per the hard-case rules.

## 4. Onboarding — "I connected it but don't see it"

```
Hi [name],

This almost always comes down to one thing: is the account set to a Business or Creator profile (not personal)? [If Meta/Instagram: and is it linked to a Facebook Page you admin?]

Can you double check that and try reconnecting from the Social Platforms tab in your dashboard? If it's already set correctly, reply back and I'll look deeper.
```

## 5. Timezone / "post went out at the wrong time"

```
Hi [name],

The calendar view shows times in your browser's local timezone for reference, but posts actually publish according to the connected account's own timezone setting on [platform]. If those two differ, the calendar and the real post time won't match.

Proof-of-Publish shows the actual live timestamp — that's the source of truth if you want to confirm exactly when something went out. Let me know if the real post time still looks wrong once you check that.
```

## 6. Security — unauthorized post / suspected compromise

Always send this one even if angry/urgent-toned — this is exactly the kind of thing that needs a fast, plain answer, not a delay.

```
Hi [name],

Thanks for flagging this right away — a few quick questions so I can pin down what happened:

1. Did you recently change your [platform] password, or notice any other unusual account activity there?
2. Is this happening on one connected account or more than one?

In the meantime, here's how to fully revoke LazyRelay's access on [platform]'s side (in addition to disconnecting in LazyRelay itself): [platform-specific revoke-access link/path].

I'll treat this as urgent and follow up as soon as I hear back.
```

## 7. Disconnecting an account

```
Hi [name],

Two steps to fully disconnect [platform]:

1. In LazyRelay: the Social Platforms tab → Disconnect
2. On [platform]'s own side: revoke LazyRelay's access at [platform-specific link] — step 1 alone doesn't always fully revoke platform-side permissions.

Any scheduled posts on that account will stop publishing once disconnected. Let me know if you run into any issues with either step.
```

## 8. Data deletion / GDPR request

```
Hi [name],

Got it — I'll action this request. [Product doesn't yet have self-serve deletion, so:] I'll confirm back here once your data has been fully removed, within 30 days at the latest (in most cases much sooner).

If there's anything specific you'd like confirmed as deleted (e.g. a particular connected account's data vs. everything), let me know and I'll make sure that's covered.
```

## 9. General/press/partnership inquiry (hello@)

```
Hi [name],

Thanks for reaching out. [One or two sentences directly answering what they asked — partnership terms, press info, general product question. If it needs someone's actual judgment/decision rather than a factual answer, don't improvise a commitment here — see the hard-case flag list in SKILL.md instead.]

Happy to talk further if useful — just reply here.
```

## 10. Vendor/platform correspondence (developer-app registration, integration approvals)

Not customer support — this is LazyRelay corresponding with a platform (Meta, TikTok, Pinterest, Snapchat, Reddit, etc.) about our own app/developer account. Always re-verify current app credentials, business entity name, and thread history before sending — these threads span days/weeks and a stale detail (old client ID, wrong business name, an already-answered question) reads as sloppy to a platform reviewer.

```
Hi [contact name from the thread, or "Hi," if unclear],

[Direct, factual answer to exactly what they asked — app name, OAuth client ID, business entity/registration details, integration status. Never include a client secret or password in this kind of email.]

[If something is still outstanding on our side or needs their action: say so plainly and ask for the specific next step, don't just restate the same info as before.]

[Preserve any thread-routing marker from their message verbatim, e.g. thread::...::]

Thanks for your help,
```

## 11. Stuck-onboarding nudge (accounts_ops.js — added 2026-08-05)

Sent to `support@lazyrelay.com` outbound, not a reply — for `findStuckOnboardingAccounts()` candidates (signed up 7+ days ago, zero connected social accounts). Not a reply-to-them scenario, so subject is fresh: `Quick question about your LazyRelay account`.

```
Hi [name],

Noticed you signed up for LazyRelay but haven't connected a social account yet — just checking in to see if you hit a snag, or if you have any questions before getting started.

Connecting takes about a minute from the Social Platforms tab in your dashboard. If something's not working or you're not sure where to start, just reply here and I'll help directly.
```

## 12. Review request (accounts_ops.js — added 2026-08-05, form link added 2026-08-21)

Sent to `hello@lazyrelay.com` outbound, not a reply — for `findReviewRequestCandidates()` candidates (5+ posts confirmed actually live via `post_results.verified_live`). Subject: `Quick favor?`. Fill in the real `verifiedPostCount` from the candidate data — never round up or approximate it.

**Before filling this template, call `createFeedbackRequest(supabase, accountId)`** (accounts_ops.js) to get a real `token`, then build the link as `https://lazyrelay.com/feedback/<token>`. Call `markReviewRequested(accountId)` immediately after the email actually sends so this never goes out twice.

```
Hi [name],

You've published [verifiedPostCount] posts with LazyRelay so far — love that it's working out for you!

Mind sharing a quick rating? Takes about 30 seconds, and it genuinely helps us make LazyRelay better.

[BUTTON] Rate LazyRelay|[feedbackUrl]

Thanks for being with us early on — it means a lot.
```

Werner's call 2026-08-21: replaced "reply to this email with a quick line or two" with a real 5-question star-rating form (`frontend/src/pages/FeedbackForm.tsx`, reached at `/feedback/<token>`) plus an optional free-text comment box — lower friction than composing a reply, and gives structured signal instead of only free text. The `[BUTTON]` line renders as a real styled button, not a bare URL (imap-tool.js, added 2026-08-21) — a first pass with a plain link read as an afterthought/chore, so it's an actual button now. **Copy rewritten same day** after Werner saw the first live test send and said it read as obligatory/a lot of work to ask — warmer, shorter, leads with genuine appreciation rather than "a few quick questions." No public reviews destination exists yet (per `ACCOUNTS_KNOWLEDGE.md`'s "Review requests" section) — responses land in the `review_feedback` table (migration 0063), not anywhere public. Update this template again if/when a real public reviews section ships.

## 13. Dunning — payment failed, subscription past due (billing_ops.js — added 2026-08-11)

Sent from `accounts@lazyrelay.com` outbound, not a reply — for `findPastDueNeedingFollowup()` candidates (`status: past_due` for 24+ hours, per BILLING_KNOWLEDGE.md's dunning cadence: money-impacting issues get the tight 24h window, not the standard 1-2 days). Subject: `Your LazyRelay payment didn't go through`.

**Gate before sending, every time:** `getMorStatus()` must return `environment: "production"` AND `source: "deployed"`. Sandbox rows are test data and must never receive a real email. `findPastDueNeedingFollowup()` already filters internal test accounts, but the environment gate is the one that matters — check it yourself, don't assume.

State the fact and the fix. No threat, no urgency theatre, no dunning-escalation ladder — one plain notice that a card failed, because the overwhelmingly likely cause is an expired card, not a customer refusing to pay.

```
Hi [name],

Your last LazyRelay payment didn't go through, so your [tier] subscription is currently marked past due.

Usually this is just an expired or replaced card. You can update your payment details under Settings → Billing in your dashboard, and that'll settle the outstanding amount automatically.

Your scheduled posts are still running for now. If the payment doesn't clear, the account drops back to Free limits — so it's worth sorting out in the next few days.

If you think this is a mistake, or the payment page gives you an error, reply here and I'll look into it directly.
```

Never state a specific shutoff date or dollar amount unless it's read from the real subscription row — an invented deadline or figure in a payment email is the kind of error that costs a customer permanently. Billing owns the money event only: this email never itself changes account state (`accounts_ops.js` reacts to the payment event separately, per the domain boundary in BILLING_KNOWLEDGE.md).

## 14. Cancellation — confirming a cancel request or asking about cancellation status (added 2026-08-11)

Use when a customer emails asking to cancel, asking how to cancel, or asking to confirm their access end date. **`lazyrelay-email-operations` has no live database access, so it can never see or quote a customer's actual `current_period_end` date — don't invent one.** Cancelling itself is self-serve (Settings → Billing, real-time), not something this agent does on the customer's behalf.

Real mechanics to get right (`cancel_at_period_end`, migration `0043`, live 2026-08-11): cancelling does **not** cut off access immediately. It sets a pending-cancellation flag; the subscription stays fully active, and access continues, until the current paid period genuinely ends — at which point it drops to Free automatically. No further charge happens once cancelled.

```
Hi [name],

[If they're asking how to cancel:] You can cancel any time under Settings → Billing in your dashboard — no need to email us for it.

[If they've already cancelled and are asking to confirm:] That's confirmed on our end. One thing worth knowing: cancelling doesn't cut off access right away — you'll keep everything you have now until your current billing period ends, shown live under Settings → Billing, and you won't be charged again after that. Once that date passes, the account moves to the Free plan automatically; nothing else changes and nothing gets deleted.

Let me know if anything looks off on your end.
```

Never say "your access ends today" or state any date yourself — the dashboard's own Settings → Billing section is the one place with the real, current number, and that's what this reply should point to.

---

## Template maintenance

- If `SUPPORT_KNOWLEDGE.md`'s "Current product state" section changes (billing goes live, a new platform integration ships), immediately check whether Templates 2 and 3 above are still accurate — they're written for the current pre-launch state and will actively mislead customers once things change. **This rule has now fired twice and caught a real defect both times:** Template 3 on 2026-08-11 (it told customers "nothing you're using today will result in a charge" hours after billing went live) and **Template 2 on 2026-09-04** (Instagram was its last remaining valid target; the moment that approval landed, the whole template became a way to tell customers a live platform isn't live). Both were caught in the same pass as the product-state edit, which is the only reason neither reached a customer — **do the sweep in the same pass, not "next run."**
- **Dashboard tab names live in these templates too.** Templates 4, 7, 11, 13 and 14 all tell a customer where to click, so a dashboard restructure silently breaks them. The 2026-08-17 restructure (Settings and API Keys promoted to the top bar; Storage/Account/Billing merged into Settings; "Accounts" renamed **Social Platforms**) invalidated all five at once — corrected 2026-08-18. Whenever the nav changes, re-read `frontend/src/pages/Dashboard.tsx`'s `MAIN_TABS`/`MORE_TABS` and sweep this file alongside `SUPPORT_KNOWLEDGE.md`'s Part 3 layout block, in the same pass.
- Adding a new template: keep the same terse, plain-language structure — no template here should read like a corporate form letter.
