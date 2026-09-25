// analytics routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.

import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient } from "../../posthogClient.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { checkGenerationLimit, recordGeneration } from "../../aiUsage.js";
import { dbError, resolveBrandFilterSocialAccountIds, fetchAllRows, readAnalyticsConsent } from "./shared.js";

export function buildAnalyticsRouter(): Router {
  const router = Router();

  // Phase 1 analytics — post-level engagement (likes/shares/views) isn't
  // available yet: that needs a per-platform metrics-fetch method this
  // codebase doesn't have (a real, larger scope, not an oversight). This
  // aggregates what LazyRelay already collects — Proof-of-Publish results —
  // into the operational numbers a customer actually needs today: how many
  // posts went out, per platform, how many actually verified live vs
  // failed, and the daily volume trend.
  // Multi-brand filtering (2026-08-08, item 8) — this route pre-aggregates
  // server-side (unlike Posts/Mentions/DMs, which send raw rows the
  // frontend can filter by social_account_id itself), so brand filtering
  // has to happen here rather than client-side. "brand" query param:
  // omitted = no filter, "__unbranded__" = accounts with no brand_label,
  // anything else = that exact label.
  // (UNBRANDED_FILTER_VALUE and resolveBrandFilterSocialAccountIds() now live in ./shared.ts — shared with posts.routes.ts.)

  const ANALYTICS_SCHEDULED_POSTS_MAX = 5000;
  router.get("/analytics/summary", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const brand = typeof req.query.brand === "string" && req.query.brand.length > 0 ? req.query.brand : undefined;

    let matchingSocialAccountIds: string[] | undefined;
    try {
      matchingSocialAccountIds = await resolveBrandFilterSocialAccountIds(req.accountId!, brand);
    } catch (err) {
      dbError(res, err as { message: string }, "GET /analytics/summary (brand filter)");
      return;
    }

    // Same real per-request row cap as /scheduled-posts (2026-09-14, see
    // fetchAllRows above) — a single .limit(ANALYTICS_SCHEDULED_POSTS_MAX)
    // looked right but Supabase's project settings still truncated it to
    // 1000 regardless, quietly truncating every aggregate below (byStatus,
    // byPlatform, dailyCounts, engagement) on any account whose combined
    // post pool for the range exceeded that. Paged with fetchAllRows instead.
    type AnalyticsPostRow = {
      id: string;
      status: string;
      scheduled_for: string;
      social_accounts: { platform?: string } | { platform?: string }[] | null;
      post_results: { verified_live: boolean; error_message: string | null } | { verified_live: boolean; error_message: string | null }[] | null;
      post_metrics:
        | { checkpoint: string; likes: number | null; comments: number | null; shares: number | null; views: number | null }
        | { checkpoint: string; likes: number | null; comments: number | null; shares: number | null; views: number | null }[]
        | null;
    };
    const scheduledPostsPromise = fetchAllRows<AnalyticsPostRow>((from, to) => {
      let q = req
        .db!.from("scheduled_posts")
        .select(
          "id, status, scheduled_for, social_accounts(platform), post_results(verified_live, error_message), post_metrics(checkpoint, likes, comments, shares, views)"
        )
        .eq("account_id", req.accountId)
        .gte("scheduled_for", since)
        .order("scheduled_for", { ascending: true });
      if (matchingSocialAccountIds) q = q.in("social_account_id", matchingSocialAccountIds);
      return q.range(from, to);
    }, ANALYTICS_SCHEDULED_POSTS_MAX)
      .then((data) => ({ data, error: null as unknown }))
      .catch((error) => ({ data: null as AnalyticsPostRow[] | null, error }));
    // Real total, independent of the row cap above — data.length silently
    // matched the cap instead of the true count once an account passed it.
    let totalPostsCountQuery = req.db!
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("account_id", req.accountId)
      .gte("scheduled_for", since);
    if (matchingSocialAccountIds) {
      totalPostsCountQuery = totalPostsCountQuery.in("social_account_id", matchingSocialAccountIds);
    }
    // Audience growth (2026-08-17) — same brand-filter scoping as the posts
    // query above, just against audience_snapshots instead of
    // scheduled_posts. social_accounts(platform) joined in so the frontend
    // can group by platform without a second round trip.
    let audienceSnapshotsQuery = req.db!
      .from("audience_snapshots")
      .select("social_account_id, follower_count, snapshot_date, social_accounts(platform)")
      .eq("account_id", req.accountId)
      .gte("snapshot_date", since.slice(0, 10))
      .order("snapshot_date", { ascending: true });
    if (matchingSocialAccountIds) {
      audienceSnapshotsQuery = audienceSnapshotsQuery.in("social_account_id", matchingSocialAccountIds);
    }

    const [
      { data, error },
      { count: totalPostsCount, error: totalPostsError },
      { data: dmAutomationRows },
      { count: accountsConnectedCount },
      { data: audienceSnapshotRows, error: audienceError },
    ] = await Promise.all([
      scheduledPostsPromise,
      totalPostsCountQuery,
      req.db!.from("dm_automations").select("id").eq("account_id", req.accountId),
      req.db!.from("social_accounts").select("id", { count: "exact", head: true }).eq("account_id", req.accountId).is("disconnected_at", null),
      audienceSnapshotsQuery,
    ]);
    if (error) {
      dbError(res, error, "GET /analytics/summary");
      return;
    }
    if (totalPostsError) {
      dbError(res, totalPostsError, "GET /analytics/summary (total posts count)");
      return;
    }
    if (audienceError) {
      dbError(res, audienceError, "GET /analytics/summary (audience growth)");
      return;
    }
    const automationIds = (dmAutomationRows ?? []).map((a: { id: string }) => a.id);

    // Per platform: the trend as [{date, followerCount}] (summed across every
    // connected account on that platform, in case there's more than one),
    // plus the simple net change over the whole range so the UI doesn't have
    // to recompute it. A platform absent from this map means no connected
    // account there supports follower-count reads yet (see
    // PlatformAdapter.getFollowerCount) — honestly absent, not a silent zero.
    const audienceGrowth: Record<string, { trend: { date: string; followerCount: number }[]; netChange: number | null }> = {};
    {
      const byPlatformAndDate: Record<string, Record<string, number>> = {};
      for (const row of audienceSnapshotRows ?? []) {
        const platform = Array.isArray(row.social_accounts)
          ? (row.social_accounts[0] as { platform?: string } | undefined)?.platform
          : (row.social_accounts as { platform?: string } | null)?.platform;
        const platformKey = platform ?? "unknown";
        byPlatformAndDate[platformKey] ??= {};
        byPlatformAndDate[platformKey][row.snapshot_date] =
          (byPlatformAndDate[platformKey][row.snapshot_date] ?? 0) + row.follower_count;
      }
      for (const [platformKey, byDate] of Object.entries(byPlatformAndDate)) {
        const trend = Object.entries(byDate)
          .map(([date, followerCount]) => ({ date, followerCount }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const netChange = trend.length >= 2 ? trend[trend.length - 1].followerCount - trend[0].followerCount : null;
        audienceGrowth[platformKey] = { trend, netChange };
      }
    }
    let dmCount = 0;
    if (automationIds.length > 0) {
      const { count } = await req.db!
        .from("dm_automation_log")
        .select("automation_id", { count: "exact", head: true })
        .in("automation_id", automationIds);
      dmCount = count ?? 0;
    }
    const accountsConnected = accountsConnectedCount ?? 0;

    const byStatus: Record<string, number> = {};
    const byPlatform: Record<string, { total: number; posted: number; failed: number; verifiedLive: number }> = {};
    const dailyCounts: Record<string, number> = {};
    // Per-platform breakdown of the same daily counts above (2026-08-20) —
    // additive, same loop, same `day`/`platformKey` already computed below,
    // so this costs nothing extra to accumulate.
    const dailyCountsByPlatform: Record<string, Record<string, number>> = {};
    let verifiedLiveCount = 0;
    let postedCount = 0;

    // Real engagement analytics (2026-08-07) — additive to everything
    // above, never replacing it. Per post, use the single MOST MATURE
    // checkpoint available (30d beats 7d beats ... beats 1h) as that post's
    // current engagement — summing every checkpoint row would count the
    // same post's likes up to 6 times over, since checkpoints aren't
    // independent events. `postsWithData` is the honest denominator: how
    // many of this platform's posts actually have a number yet, since a
    // freshly-posted item or an unsupported platform contributes zero.
    const CHECKPOINT_MATURITY = ["30d", "7d", "3d", "24h", "6h", "1h"];
    const engagement: Record<
      string,
      { likes: number; comments: number; shares: number; views: number; postsWithData: number }
    > = {};

    for (const row of data ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

      // social_accounts(platform) comes back as an array with the !inner
      // shorthand unused here, so it's a single related row in practice —
      // guard defensively rather than assuming Supabase's join shape.
      const platform = Array.isArray(row.social_accounts) ? row.social_accounts[0]?.platform : (row.social_accounts as { platform?: string } | null)?.platform;
      const platformKey = platform ?? "unknown";
      byPlatform[platformKey] ??= { total: 0, posted: 0, failed: 0, verifiedLive: 0 };
      byPlatform[platformKey].total += 1;
      if (row.status === "posted") byPlatform[platformKey].posted += 1;
      if (row.status === "failed") byPlatform[platformKey].failed += 1;

      const results = Array.isArray(row.post_results) ? row.post_results : row.post_results ? [row.post_results] : [];
      const verifiedLive = results.some((r: { verified_live: boolean }) => r.verified_live);
      if (verifiedLive) {
        byPlatform[platformKey].verifiedLive += 1;
        verifiedLiveCount += 1;
      }
      if (row.status === "posted") postedCount += 1;

      const day = row.scheduled_for.slice(0, 10);
      dailyCounts[day] = (dailyCounts[day] ?? 0) + 1;
      dailyCountsByPlatform[platformKey] ??= {};
      dailyCountsByPlatform[platformKey][day] = (dailyCountsByPlatform[platformKey][day] ?? 0) + 1;

      type MetricRow = { checkpoint: string; likes: number | null; comments: number | null; shares: number | null; views: number | null };
      const metricRows: MetricRow[] = Array.isArray(row.post_metrics) ? row.post_metrics : row.post_metrics ? [row.post_metrics] : [];
      if (metricRows.length > 0) {
        const best = metricRows.reduce((a, b) =>
          CHECKPOINT_MATURITY.indexOf(a.checkpoint) <= CHECKPOINT_MATURITY.indexOf(b.checkpoint) ? a : b
        );
        engagement[platformKey] ??= { likes: 0, comments: 0, shares: 0, views: 0, postsWithData: 0 };
        engagement[platformKey].likes += best.likes ?? 0;
        engagement[platformKey].comments += best.comments ?? 0;
        engagement[platformKey].shares += best.shares ?? 0;
        engagement[platformKey].views += best.views ?? 0;
        engagement[platformKey].postsWithData += 1;
      }
    }

    res.json({
      rangeDays: days,
      totalPosts: totalPostsCount ?? 0,
      byStatus,
      byPlatform,
      dailyCounts,
      dailyCountsByPlatform,
      verifiedLiveRate: postedCount > 0 ? verifiedLiveCount / postedCount : null,
      engagement,
      dmCount,
      accountsConnected,
      audienceGrowth,
    });
  });

  // "Why this worked" AI insight (2026-08-08) — item 9 from the 2026-08-07
  // competitor audit's "my own ideas" list, explicitly scoped to depend on
  // real engagement analytics (item 1, shipped 2026-08-07). On-demand only
  // (a button on the Analytics tab, not automatic per post) — running this
  // on every post would be both expensive and mostly noise on posts too
  // fresh to have real engagement data yet. Compares the best- and
  // worst-performing posts in the customer's selected range/brand rather
  // than reasoning over raw totals, since a pattern only shows up in
  // contrast, not in a single aggregate number.
  const MIN_POSTS_WITH_DATA_FOR_INSIGHT = 4;
  router.post("/analytics/insight", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "AI insight isn't set up on this deploy yet." });
      return;
    }

    const { days, brand } = req.body ?? {};
    const rangeDays = Math.min(Math.max(Number(days) || 30, 1), 90);
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
    const brandFilterValue = typeof brand === "string" && brand.length > 0 ? brand : undefined;

    let matchingSocialAccountIds: string[] | undefined;
    try {
      matchingSocialAccountIds = await resolveBrandFilterSocialAccountIds(req.accountId!, brandFilterValue);
    } catch (err) {
      dbError(res, err as { message: string }, "POST /analytics/insight (brand filter)");
      return;
    }

    const limitReason = await checkGenerationLimit(req.accountId!);
    if (limitReason) {
      res.status(429).json({ error: limitReason });
      return;
    }

    let postsQuery = req.db!
      .from("scheduled_posts")
      .select("id, content, post_metrics(checkpoint, likes, comments, shares, views)")
      .eq("account_id", req.accountId)
      .eq("status", "posted")
      .gte("scheduled_for", since);
    if (matchingSocialAccountIds) {
      postsQuery = postsQuery.in("social_account_id", matchingSocialAccountIds);
    }
    const { data: posts, error } = await postsQuery;
    if (error) {
      dbError(res, error, "POST /analytics/insight");
      return;
    }

    // Same "most mature checkpoint wins" reduction as /analytics/summary's
    // engagement aggregation — a post's current number, not a sum across
    // every checkpoint it's ever had.
    const CHECKPOINT_MATURITY = ["30d", "7d", "3d", "24h", "6h", "1h"];
    type MetricRow = { checkpoint: string; likes: number | null; comments: number | null; shares: number | null; views: number | null };
    const scored: { content: string; likes: number; comments: number; shares: number; score: number }[] = [];
    for (const post of posts ?? []) {
      const metricRows: MetricRow[] = Array.isArray(post.post_metrics) ? post.post_metrics : post.post_metrics ? [post.post_metrics] : [];
      if (metricRows.length === 0) continue;
      const best = metricRows.reduce((a, b) => (CHECKPOINT_MATURITY.indexOf(a.checkpoint) <= CHECKPOINT_MATURITY.indexOf(b.checkpoint) ? a : b));
      const likes = best.likes ?? 0;
      const comments = best.comments ?? 0;
      const shares = best.shares ?? 0;
      // Weighted toward the more deliberate engagement types — a share
      // signals more than a like, a comment more than neither.
      scored.push({ content: post.content, likes, comments, shares, score: likes + comments * 2 + shares * 3 });
    }

    if (scored.length < MIN_POSTS_WITH_DATA_FOR_INSIGHT) {
      res.json({ insufficientData: true, postsWithData: scored.length, needed: MIN_POSTS_WITH_DATA_FOR_INSIGHT });
      return;
    }

    scored.sort((a, b) => b.score - a.score);
    const half = Math.max(1, Math.min(3, Math.floor(scored.length / 2)));
    const top = scored.slice(0, half);
    const bottom = scored.slice(-half);
    const describePost = (p: (typeof scored)[number]) => `"${p.content.slice(0, 200)}" (${p.likes} likes, ${p.comments} comments, ${p.shares} shares)`;

    try {
      // Same timeout reasoning as the other Anthropic-backed routes above.
      const client = createAnthropicClient(apiKey, 20_000, readAnalyticsConsent(req));
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content:
              `You're analyzing a small business's social media performance. Here are their best-performing posts:\n\n` +
              `${top.map(describePost).join("\n")}\n\n` +
              `And their worst-performing posts:\n\n${bottom.map(describePost).join("\n")}\n\n` +
              `In 2-3 short sentences, say what pattern seems to separate the better posts from the worse ones (tone, ` +
              `format, topic, length, whatever's actually visible in the text), then give one concrete, specific suggestion ` +
              `for their next post. Be honest if the sample is too mixed to draw a clean conclusion, don't force a pattern that isn't there. ` +
              `Output ONLY the insight text, no preamble, no headers.`,
          },
        ],
      });
      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        res.status(502).json({ error: "AI insight returned no usable text." });
        return;
      }
      await recordGeneration(req.accountId!);
      res.json({ insight: textBlock.text.trim() });
    } catch (err) {
      console.error("[routes] POST /analytics/insight:", err instanceof Error ? err.message : err);
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        res.status(504).json({ error: "AI insight took too long, please try again." });
        return;
      }
      res.status(502).json({ error: "AI insight failed, please try again." });
    }
  });

  return router;
}
