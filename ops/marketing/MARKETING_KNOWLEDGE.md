# LazyRelay Marketing — Operating Knowledge

Living document for the Marketing Operator/Auditor.

**Placeholder.** This repo is public, so `<other business>` stands for one of Werner's other businesses rather than naming it; it resolves in the vault via `09 - Resources/Ops-QA/reference-werner-mailbox-other-businesses.md`.

## Status: DORMANT, corrected 2026-08-24 — real branded accounts DO exist, profiles now fully set up, still no ad creative

The 2026-07-22 note above was wrong by the time this was corrected: LazyRelay has real, dedicated, branded accounts on most platforms, kept live specifically for adapter testing/support diagnostics (see [[feedback-dedicated-platform-test-accounts]]) — Facebook Page "LazyRelay" (App ID `1224498757418764`), Instagram `@lazyrelay` (linked Business account), Bluesky `lazyrelay.bsky.social`, Mastodon `lazyrelay@mastodon.social`, TikTok `@lazyrelay2`, Telegram channel `@lrelay2026`, a Discord webhook branded "LazyRelay", a LinkedIn Company Page (under Luzaan's personal login), and a connected Tumblr + YouTube channel. **Pinterest now has its own dedicated LazyRelay profile too, confirmed live 2026-08-24**: `za.pinterest.com/LazyRelay` — real profile, real About text set. (The earlier proof-of-publish Pin was posted to `<other business>`'s own Pinterest board — that was a test artifact, not this profile; this is a separate, deliberate LazyRelay-branded account.)

Werner said 2026-08-24 that LazyRelay has **7 social media accounts** total — the count above (Facebook, Instagram, Bluesky, Mastodon, TikTok, Telegram, Discord, LinkedIn, Tumblr, YouTube, Pinterest = 11) doesn't reconcile with that yet. Don't guess which 7 — confirm with Werner or as each is independently verified live, and correct this list rather than leaving both figures standing unreconciled.

**Profile branding completed 2026-08-24**, ahead of the planned social-ads soft launch (Werner's stated plan: soft-launch on social first to monitor the system and fix bugs before starting Google Ads). Icon (`lazyrelay-icon-1024.png`) and/or banner (`banner.jpg`) plus real About/bio copy are now live on Pinterest, Instagram, Bluesky, Mastodon (icon+banner), TikTok, Telegram, Tumblr, YouTube (icon+banner), and Discord (user account bio + server icon/description). Facebook was already fully branded by Werner himself, left untouched. Discord's **real product webhook** — the one LazyRelay's own posting integration uses, on a separate second Discord server — was checked and confirmed already correctly named "LazyRelay" with the right icon from prior setup; nothing needed there.

**Corrected 2026-08-24, second time today**: real static ad creative already exists — 12 finished branded square posts built 2026-08-18 in `C:\Users\werne\Claude\LazyRelay-social-posts\` (real headlines, real footer URLs, real platform badges, no AI fabrication risk since it's a deterministic Python/PIL generator, not an AI image model). This was never logged in this file or the vault until a session on 2026-08-24 rebuilt work from scratch not knowing it existed — see [[VAULT-INDEX]]'s Checkpoint Persistence rule, added the same day specifically because of this miss. The generator (`generator/make_post.py`) is the correct tool for any future static graphic with real text/claims on it. `marketing_ops.js` still only queues content ideas to `state/pending_content.json` for human review rather than posting anything live — the task remains unscheduled (`lazyrelay-marketing-ops-weekly` is manual-only). Facebook/Instagram can't run ads yet regardless of creative readiness — Meta App Review is still open. TikTok is the one platform with both a real branded account and a cleared review, so it's the most likely candidate to actually run first.

## Brand voice / positioning

Cross-linked to `support/SUPPORT_KNOWLEDGE.md`'s "Trust" section (the old `project-launch-pricing-tiers` note is superseded for pricing as of 2026-10-20). The core differentiator to lead with: **Proof-of-Publish** — "we don't just trust that the API said yes, we independently check the post is actually live." This is LazyRelay's strongest trust asset for a new/small player and should anchor most acquisition content, not generic SaaS marketing copy.

## Honesty constraints (important — checked mechanically by marketing_auditor.js)

- **Corrected 2026-08-24, pricing replaced 2026-10-20.** Do not use any older price wording.
- **Pricing (Werner, 2026-10-20, the only pricing truth).** The Free, Pay-as-you-go, Growth and Pro plans below replace the old Free / Starter / Pro / Business subscription set, which is not sold any more and must not be quoted. Every price in ad copy, posts and outreach carries "plus tax" beside it. Never claim "100% free forever": Free is real but capped (30 credits once at registration, 3 connected accounts, 1 brand, 10 queued posts).

  | Plan | Price (plus tax) | Credits | Credit expiry |
  |---|---|---|---|
  | Free | $0 | 30 once at registration, no monthly reset | none |
  | Pay-as-you-go | $15 one time | 300 | never expire |
  | Growth | $29 a month | 1,000 each billing cycle | end of each cycle, no rollover |
  | Pro | $99 a month | 6,000 each billing cycle | end of each cycle, no rollover |

  Extra packs that never expire (plus tax): Starter pack $15 for 300 credits, Growth pack $50 for 1,500 credits, Pro top-up $30 for 1,500 credits (active Pro subscribers only). Credits work like this: 1 credit per channel destination (one post to 5 channels is 5 credits, and a channel that fails is not charged), 10 credits for a competitor page teardown (charged only when the blueprint is delivered). Expiring credits are spent first. If the wallet runs empty, due posts wait and publish once credits are added. Payments go through Paddle and tax is added at checkout. Per-plan storage, team seats, AI-suggestion limits and recurring-slot or RSS limits are not decided: do not state any of them in marketing.
- **Platform count wording (Werner, 2026-10-16):** always "18 distribution platforms plus WhatsApp". Never 17, never 19. No em dashes or en dashes in any customer-facing text.
- **Live platform posting genuinely works today.** Paddle billing has been in production since 2026-08-11 and IPE Projects is CIPC-registered. Ad copy can claim real, working, verified posting (Proof-of-Publish: every post is independently checked as live), but only for a platform that is actually connectable. The earlier "9-platform marquee" figure in this line was dropped on 2026-10-20 because it contradicts the 18-plus-WhatsApp wording and was not re-verified.
- Every piece of content links back to lazyrelay.com.

## Standing rule

If a content idea doesn't fit anything documented here, don't improvise past what's actually true about the product — flag for the user.
