// Tracked links for the Campaign clicks tab: create a link, and read the per-link click totals.
// Both tables are service-role only (migration 0146), so these handlers use the service-role client on purpose and ALWAYS filter by the
// signed-in account (req.accountId): that is the only tenant isolation here, there is no row-level policy to fall back on.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { DEFAULT_PUBLIC_API_BASE_URL } from "./whatsappWebhookInfo.routes.js";
import { PLATFORM_RE, newCode, parseDestination } from "../../trackedLinks.js";

const createBody = z.object({
  destinationUrl: z.unknown(),
  platform: z.unknown(),
  scheduledPostId: z.string().min(1).max(64).optional(),
});

type SummaryRow = {
  code: string;
  destination_url: string;
  platform: string;
  brand: string;
  scheduled_post_id: string | null;
  created_at: string;
  clicks: number | string;
  last_click: string | null;
};

export function buildTrackedLinksRouter(): Router {
  const router = Router();

  router.post("/tracked-links", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = createBody.safeParse(req.body ?? {});
    const destination = body.success ? parseDestination(body.data.destinationUrl) : null;
    const platform = body.success && typeof body.data.platform === "string" ? body.data.platform : "";
    if (!body.success || !destination) {
      res.status(400).json({ error: "destinationUrl must be an https page on lazyrelay.com or timeajob.com." });
      return;
    }
    if (!PLATFORM_RE.test(platform)) {
      res.status(400).json({ error: "platform must be the channel the link will be posted on, for example pinterest." });
      return;
    }
    const scheduledPostId = body.data.scheduledPostId;
    if (scheduledPostId) {
      const { data: post, error } = await supabase.from("scheduled_posts").select("id").eq("id", scheduledPostId).eq("account_id", req.accountId!).maybeSingle();
      if (error && /invalid input syntax for type uuid/i.test(error.message)) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (error) {
        console.error("POST /tracked-links (post lookup):", error.message);
        res.status(500).json({ error: "Something went wrong. Please try again." });
        return;
      }
      if (!post) {
        res.status(404).json({ error: "Not found" });
        return;
      }
    }
    // 48 random bits make a collision rare; the unique constraint catches the one that happens, and we try again.
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = newCode();
      const { error } = await supabase.from("tracked_links").insert({ code, account_id: req.accountId!, scheduled_post_id: scheduledPostId ?? null, platform, destination_url: destination });
      if (!error) {
        const base = (process.env.PUBLIC_API_BASE_URL || DEFAULT_PUBLIC_API_BASE_URL).replace(/\/+$/, "");
        res.status(201).json({ code, url: `${base}/r/${code}`, destinationUrl: destination, platform });
        return;
      }
      if (error.code !== "23505") {
        console.error("POST /tracked-links:", error.message);
        res.status(500).json({ error: "Something went wrong. Please try again." });
        return;
      }
    }
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  router.get("/analytics/link-clicks", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const platform = typeof req.query.platform === "string" && req.query.platform.length > 0 ? req.query.platform : null;
    const brand = typeof req.query.brand === "string" && req.query.brand.length > 0 ? req.query.brand.slice(0, 100) : null;
    if (platform && !PLATFORM_RE.test(platform)) {
      res.status(400).json({ error: "platform is not valid." });
      return;
    }
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.rpc("link_clicks_summary", { p_account_id: req.accountId!, p_since: since, p_platform: platform, p_brand: brand });
    if (error) {
      console.error("GET /analytics/link-clicks:", error.message);
      res.status(500).json({ error: "Something went wrong. Please try again." });
      return;
    }
    const rows = (data ?? []) as SummaryRow[];
    const links = rows.map((r) => ({
      code: r.code,
      destinationUrl: r.destination_url,
      platform: r.platform,
      brand: r.brand,
      scheduledPostId: r.scheduled_post_id,
      createdAt: r.created_at,
      clicks: Number(r.clicks),
      lastClick: r.last_click,
    }));
    res.json({
      links,
      totals: { clicks: links.reduce((s, l) => s + l.clicks, 0) },
      days,
    });
  });

  return router;
}
