# LazyRelay Advertising — Operating Knowledge

Living document for the Advertising Operator/Auditor.

**Placeholder.** This repo is public, so `<other business>` stands for one of Werner's other businesses rather than naming it; it resolves in the vault via `09 - Resources/Ops-QA/reference-werner-mailbox-other-businesses.md`.

## Status: DORMANT (2026-07-22)

No LazyRelay ad account exists on any platform. This domain is fully built and self-tested but spends nothing — `advertising_ops.js` only queues recommendations (target audience, rationale, always `budgetUsd: 0/null`) to `state/pending_recommendations.json` for human review. Same recommendation-only shape as `<other business>`'s own ads domain before it went live. Do not schedule this task with a real cron until a real ad account exists — see `lazyrelay-advertising-ops-weekly`'s SKILL.md gate flag.

## Standing rule

Every recommendation must state a real rationale — no unexplained budget/audience suggestions. Once a real ad account exists, this file gets updated with actual platform-specific policy (min spend, targeting rules, creative requirements) before this domain graduates out of dormant mode — that update happens with the user, not unilaterally.
