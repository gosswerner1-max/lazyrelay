// RSS feeds (master list #18): a feed's new items become drafts. The address is
// fetched and parsed BEFORE it is saved, so a customer learns straight away if it
// is not a feed. The items already in the feed are remembered, not drafted.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { dbError } from "./shared.js";
import { validateBody } from "../validation.js";
import { fetchFeedText, planFeedCheck } from "../../rssPoller.js";
import { parseFeed } from "../../rssFeed.js";

export const MAX_RSS_FEEDS = 5;

const createSchema = z.object({
  url: z.string({ error: "url is required" }).trim().min(1, "url is required").max(1000, "url is too long"),
  label: z.string().trim().max(60, "label must be 60 characters or fewer").optional(),
});
const updateSchema = z.object({ enabled: z.boolean({ error: "enabled must be true or false" }) });

interface FeedRow {
  id: string;
  url: string;
  label: string | null;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
}
const COLUMNS = "id, url, label, enabled, last_checked_at, last_error";
const toPublic = (r: FeedRow) => ({ id: r.id, url: r.url, label: r.label, enabled: r.enabled, lastCheckedAt: r.last_checked_at, lastError: r.last_error });
const guard = [requireAuth, tieredRateLimit] as const;

export function buildRssFeedsRouter(): Router {
  const router = Router();

  router.get("/rss-feeds", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase.from("rss_feeds").select(COLUMNS).eq("account_id", req.accountId).order("created_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /rss-feeds");
      return;
    }
    res.json({ maxFeeds: MAX_RSS_FEEDS, feeds: ((data ?? []) as FeedRow[]).map(toPublic) });
  });

  router.post("/rss-feeds", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(createSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { count } = await supabase.from("rss_feeds").select("id", { count: "exact", head: true }).eq("account_id", req.accountId);
    if ((count ?? 0) >= MAX_RSS_FEEDS) {
      res.status(400).json({ error: `You can add up to ${MAX_RSS_FEEDS} feeds. Remove one first.` });
      return;
    }
    const fetched = await fetchFeedText(body.data.url);
    if (!fetched.ok) {
      res.status(400).json({ error: fetched.error });
      return;
    }
    const items = parseFeed(fetched.text);
    if (items.length === 0) {
      res.status(400).json({ error: "No posts were found at that address. It needs to be an RSS or Atom feed." });
      return;
    }
    // Learn what is already in the feed so only NEW items become drafts.
    const plan = planFeedCheck(items, [], false, 0);
    const { data, error } = await supabase
      .from("rss_feeds")
      .insert({
        account_id: req.accountId,
        url: body.data.url,
        label: body.data.label || null,
        enabled: true,
        seen_ids: plan.seenIds,
        primed: true,
        last_checked_at: new Date().toISOString(),
      })
      .select(COLUMNS)
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /rss-feeds");
      return;
    }
    res.status(201).json(toPublic(data as FeedRow));
  });

  router.patch("/rss-feeds/:id", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(updateSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { data, error } = await supabase.from("rss_feeds").update({ enabled: body.data.enabled }).eq("id", req.params.id).eq("account_id", req.accountId).select(COLUMNS).maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /rss-feeds/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Feed not found" });
      return;
    }
    res.json(toPublic(data as FeedRow));
  });

  router.delete("/rss-feeds/:id", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase.from("rss_feeds").delete().eq("id", req.params.id).eq("account_id", req.accountId).select("id");
    if (error) {
      dbError(res, error, "DELETE /rss-feeds/:id");
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Feed not found" });
      return;
    }
    res.json({ deleted: true });
  });

  return router;
}
