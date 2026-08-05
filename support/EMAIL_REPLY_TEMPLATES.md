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

## 2. "It's not live yet" premise mismatch

Use when a customer reports a posting failure but LazyRelay's real integration status for that platform doesn't match what they're describing (e.g. reporting a Meta posting bug when Meta isn't actually connected/live for them yet). Always double-check current platform status in `SUPPORT_KNOWLEDGE.md`'s "Current product state" section before sending this — it changes as integrations go live.

```
Hi [name],

Thanks for the report. Before I troubleshoot — can you confirm which account you connected this to and roughly when? [Platform] posting should be fully live, so if something's actually broken there I want to find the real cause rather than assume.

Once I hear back I'll dig into your account specifically.
```

## 3. Billing/subscription question (pre-billing-launch)

Use for any billing/pricing/subscription question while no billing system is live yet. Always check `SUPPORT_KNOWLEDGE.md`'s current billing status line first — this template is wrong the moment billing goes live.

```
Hi [name],

Paid plans (Pro $29.99/mo, Business $59.99/mo) are coming soon but aren't live yet — nothing you're using today will result in a charge.

When paid plans do launch, existing users will get clear advance notice before anything changes — no surprise charges.

Let me know if you have any other questions in the meantime.
```

## 4. Onboarding — "I connected it but don't see it"

```
Hi [name],

This almost always comes down to one thing: is the account set to a Business or Creator profile (not personal)? [If Meta/Instagram: and is it linked to a Facebook Page you admin?]

Can you double check that and try reconnecting from Settings → Connected Accounts? If it's already set correctly, reply back and I'll look deeper.
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

1. In LazyRelay: Settings → Connected Accounts → Disconnect
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

Connecting takes about a minute from Settings → Connected Accounts. If something's not working or you're not sure where to start, just reply here and I'll help directly.
```

## 12. Review request (accounts_ops.js — added 2026-08-05)

Sent to `hello@lazyrelay.com` outbound, not a reply — for `findReviewRequestCandidates()` candidates (5+ posts confirmed actually live via `post_results.verified_live`). Subject: `Quick favor?`. Fill in the real `verifiedPostCount` from the candidate data — never round up or approximate it. Call `markReviewRequested(accountId)` immediately after sending so this never goes out twice.

```
Hi [name],

You've had [verifiedPostCount] posts go out through LazyRelay so far — glad it's working for you.

If you've got a minute, I'd genuinely love to hear what you think — just reply to this email with a quick line or two (still a small, new product, and real feedback like yours helps a lot). No pressure at all if not.
```

No public review destination exists yet (per `ACCOUNTS_KNOWLEDGE.md`'s "Review requests" section) — this collects feedback via reply-to-this-email, not a link to an external site. Update this template if/when a real public reviews section ships.

---

## Template maintenance

- If `SUPPORT_KNOWLEDGE.md`'s "Current product state" section changes (billing goes live, a new platform integration ships), immediately check whether Templates 2 and 3 above are still accurate — they're written for the current pre-launch state and will actively mislead customers once things change.
- Adding a new template: keep the same terse, plain-language structure — no template here should read like a corporate form letter.
