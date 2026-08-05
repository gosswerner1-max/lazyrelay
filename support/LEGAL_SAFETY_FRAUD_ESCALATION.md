# LazyRelay Legal / Safety / Fraud Escalation Guide

Living document for the `hello@` / `support@` / `accounts@lazyrelay.com` email agent. Read this file whenever an incoming email might fall into one of these three categories, alongside SUPPORT_KNOWLEDGE.md and EMAIL_REPLY_TEMPLATES.md.

**Purpose:** these three categories are NOT resolvable by an autonomous agent — no in-house legal or safety team exists, and LazyRelay is a small pre-revenue business (IPE Projects (Pty) Ltd, South Africa). This file does not attempt to give the agent authority to resolve them. It gives the agent a **safe, acknowledgment-only holding reply** so a real person isn't left in total silence, while making escalation to Werner mandatory and immediate (Slack) in every case. Bias toward escalation, always — never improvise a substantive answer in any of these three categories, no matter how confident the match looks.

**Reference:** LazyRelay's real published policies live at lazyrelay.com/terms, /privacy, /refunds — link to these where relevant, but never interpret or apply them to a specific dispute; that's Werner's call.

---

## 1. Legal threats

**Covers:** defamation claims, DMCA/copyright takedown notices, cease-and-desist letters, subpoenas, court orders, any explicit threat of legal action or mention of "my lawyer."

**A real subpoena or court order is a universal auto-escalate — never touch, never acknowledge with a template, flag immediately as highest priority.**

For everything else in this category (a customer or third party *threatening* legal action, alleging defamation, sending a DMCA notice):

### Template: Legal Threat Acknowledgment
**Use when:** an incoming email raises a legal claim or threat that is not itself a court order/subpoena.
**Do NOT use when:** the email IS a subpoena, court order, or comes from a regulator/law enforcement/government agency — escalate directly with no reply sent at all.

**Body:**
```
Subject: Re: {{original subject}}

Hi {{name}},

Thanks for your message — I've passed this directly to our team for review, and someone will get back to you personally as soon as possible.

Best,
The LazyRelay Team
```

Notes: no admission, no apology beyond the neutral "thanks," no reference to the specific legal claim, no promise of a timeline beyond "as soon as possible," no offer of compensation/refund/action. This is purely a holding reply so the sender knows a human is aware.

**Escalation (always, no exceptions):** flag to Werner via Slack immediately, marked highest priority, full original email text included. Never let this wait for a routine run summary.

---

## 2. Safety concerns

**Covers:** account compromise, abuse reports, any mention of harm to self or others, anything involving a minor.

**Split by severity — not everything here is a hard case.**

### Already resolvable (not an escalation — use SUPPORT_KNOWLEDGE.md directly)
- Routine account-compromise questions ("did you post something I didn't schedule?") — SUPPORT_KNOWLEDGE.md Part 2 "Security & data" already has documented, safe guidance (token vs password compromise, revoke path, status-update commitment if systemic). Answer directly, no escalation needed.
- Standard "disconnect an account" / GDPR deletion requests — also already documented, answer directly.

### Always escalate — do not attempt any substantive reply
- Any mention of harm to self or others (in any context, including hypothetical or third-person)
- Any mention of a minor / child safety concern
- Abuse reports the agent cannot fully resolve from documented account-compromise guidance alone (e.g. stalking, harassment via the platform, an ex-partner with account access)
- Anything that reads as urgent or distressed, even if the actual request is unclear

### Template: Safety Concern Acknowledgment
**Use when:** the routine account-compromise/disconnect guidance above doesn't fully cover it, but the message doesn't sound urgent or distressed.
**Do NOT use when:** any harm-to-self/others or minor-safety signal is present — in that case, do not send any auto-reply at all, escalate silently and let Werner decide how to respond personally.

**Body:**
```
Subject: Re: {{original subject}}

Hi {{name}},

Thank you for letting us know — this needs a closer look, and I've flagged it for our team to follow up with you directly.

If this is urgent, please also reach out to the relevant platform's own support team, since account safety issues often need action on their side too.

Best,
The LazyRelay Team
```

**Escalation (always):** flag to Werner via Slack immediately, marked high priority. For harm-to-self/others or minor-safety signals specifically: no auto-reply of any kind, escalate silently, full context included, marked highest priority.

---

## 3. Fraud accusations

**Covers two different directions — handle separately.**

### 3a. A customer accuses LazyRelay of being a scam/fraud
Often overlaps with the "customer claims to be paying" case already in SUPPORT_KNOWLEDGE.md (billing isn't live yet, so payment claims are unverifiable). Don't improvise a defense of the business or dispute their claim.

**Template: Fraud Accusation (against us) Acknowledgment**
**Use when:** a customer states or implies LazyRelay is fraudulent, a scam, or is taking their money improperly.
**Do NOT use when:** the accusation includes a legal threat (use the Legal Threat template/escalation instead) or a safety threat.

**Body:**
```
Subject: Re: {{original subject}}

Hi {{name}},

I take this seriously and want to make sure it's handled properly — I've passed it directly to our team, and someone will follow up with you personally.

Best,
The LazyRelay Team
```

**Escalation (always):** flag to Werner via Slack immediately, marked high priority, include any account/billing details mentioned so he can verify the underlying facts.

### 3b. LazyRelay suspects fraudulent activity from a customer (fake signup, chargeback, abuse of free tier)
**Do not email the customer at all** — an auto-reply could tip off the person doing it. Just log and flag internally.

**Handling:** note the suspicious pattern (what triggered the suspicion, account/email involved, timestamp) in the run report and Slack, marked high priority. No template applies — this is Werner's call on whether/how to act (e.g. account suspension per the Terms of Service "Acceptable use" clause).

---

## Escalation criteria summary (applies across all three categories)

Always escalate to Werner directly (Slack, immediate, not batched into a routine run summary) when ANY of the following is true, regardless of which category:
- The matter could involve actual litigation, a regulator, or law enforcement
- The email is a subpoena, court order, or from a government/regulatory address
- Any mention of harm to self or others, or anything involving a minor
- The situation is unprecedented — nothing in this file or SUPPORT_KNOWLEDGE.md closely matches it
- The agent is not fully confident which category applies

When in doubt, escalate. A holding-reply template exists so the sender isn't met with total silence — it is never a substitute for Werner's own judgment on the substance.
