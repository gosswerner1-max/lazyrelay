// Client review links, the account owner's side (master list #23): create, list and
// revoke links, and read or add to the conversation on a post. The client's side (no
// login) is in reviewPublic.routes.ts.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { dbError } from "./shared.js";
import { validateBody } from "../validation.js";
import { resolveTier, REVIEW_LINK_LIMITS } from "../../tier.js";
import { generateReviewToken, linkStatus, cleanComment, REVIEW_LINK_DEFAULT_DAYS, REVIEW_LINK_MAX_DAYS, MAX_COMMENTS_PER_POST, type ReviewLinkRow } from "../../reviewLinks.js";

const createSchema = z.object({
  label: z.string().trim().max(60, "label must be 60 characters or fewer").optional(),
  brandLabel: z.string().trim().max(60, "brandLabel must be 60 characters or fewer").optional(),
  expiresInDays: z
    .number({ error: "expiresInDays must be a number" })
    .int("expiresInDays must be a whole number")
    .min(1, "expiresInDays must be at least 1")
    .max(REVIEW_LINK_MAX_DAYS, `expiresInDays can be at most ${REVIEW_LINK_MAX_DAYS}`)
    .optional(),
});

const COLUMNS = "id, account_id, token, label, brand_label, expires_at, revoked_at, last_viewed_at, created_at";
const toPublic = (r: ReviewLinkRow) => ({
  id: r.id,
  token: r.token,
  label: r.label,
  brandLabel: r.brand_label,
  expiresAt: r.expires_at,
  lastViewedAt: r.last_viewed_at,
  createdAt: r.created_at,
  status: linkStatus(r),
});
const guard = [requireAuth, tieredRateLimit] as const;

export function buildReviewLinksRouter(): Router {
  const router = Router();

  router.get("/review-links", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase.from("review_links").select(COLUMNS).eq("account_id", req.accountId).order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /review-links");
      return;
    }
    const maxLinks = REVIEW_LINK_LIMITS[await resolveTier(req.accountId!)];
    res.json({ maxLinks, links: ((data ?? []) as ReviewLinkRow[]).map(toPublic) });
  });

  router.post("/review-links", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(createSchema, req.body ?? {});
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const limit = REVIEW_LINK_LIMITS[await resolveTier(req.accountId!)];
    if (limit === 0) {
      res.status(403).json({ error: "Client review links are part of the Starter plan and above. Upgrade to send a link to your clients." });
      return;
    }
    // Only ACTIVE links count toward the cap, so revoking one frees a slot.
    const { data: existing } = await supabase.from("review_links").select("id, expires_at, revoked_at").eq("account_id", req.accountId);
    const active = ((existing ?? []) as Array<Pick<ReviewLinkRow, "expires_at" | "revoked_at">>).filter((l) => linkStatus(l) === "active").length;
    if (active >= limit) {
      res.status(403).json({ error: `Your plan allows ${limit} active review link${limit === 1 ? "" : "s"}. Remove one or upgrade to add more.` });
      return;
    }
    const days = body.data.expiresInDays ?? REVIEW_LINK_DEFAULT_DAYS;
    const { data, error } = await supabase
      .from("review_links")
      .insert({
        account_id: req.accountId,
        token: generateReviewToken(),
        label: body.data.label || null,
        brand_label: body.data.brandLabel || null,
        expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      })
      .select(COLUMNS)
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /review-links");
      return;
    }
    res.status(201).json(toPublic(data as ReviewLinkRow));
  });

  // Revoking stops the link working at once. The row stays so the history of who approved what remains.
  router.delete("/review-links/:id", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("review_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .is("revoked_at", null)
      .select("id");
    if (error) {
      dbError(res, error, "DELETE /review-links/:id");
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Link not found, or already removed" });
      return;
    }
    res.json({ revoked: true });
  });

  // The conversation on one of the owner's posts.
  router.get("/scheduled-posts/:id/review-comments", ...guard, async (req: AuthedRequest, res) => {
    const { data: post } = await supabase.from("scheduled_posts").select("id").eq("id", req.params.id).eq("account_id", req.accountId).maybeSingle();
    if (!post) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    const { data, error } = await supabase
      .from("post_review_comments")
      .select("id, author_kind, author_name, kind, body, created_at")
      .eq("post_id", req.params.id)
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /scheduled-posts/:id/review-comments");
      return;
    }
    res.json({ comments: (data ?? []).map((c) => ({ id: c.id, authorKind: c.author_kind, authorName: c.author_name, kind: c.kind, body: c.body, createdAt: c.created_at })) });
  });

  router.post("/scheduled-posts/:id/review-comments", ...guard, async (req: AuthedRequest, res) => {
    const comment = cleanComment((req.body ?? {}).body, true);
    if (!comment.ok) {
      res.status(400).json({ error: comment.error });
      return;
    }
    const { data: post } = await supabase.from("scheduled_posts").select("id").eq("id", req.params.id).eq("account_id", req.accountId).maybeSingle();
    if (!post) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    const { count } = await supabase.from("post_review_comments").select("id", { count: "exact", head: true }).eq("post_id", req.params.id);
    if ((count ?? 0) >= MAX_COMMENTS_PER_POST) {
      res.status(400).json({ error: `This conversation is full (${MAX_COMMENTS_PER_POST} messages).` });
      return;
    }
    const { data: account } = await supabase.from("accounts").select("business_name").eq("id", req.accountId).maybeSingle();
    const { data, error } = await supabase
      .from("post_review_comments")
      .insert({
        account_id: req.accountId,
        post_id: req.params.id,
        author_kind: "owner",
        author_name: (account?.business_name as string | null) || "The team",
        kind: "comment",
        body: comment.body,
      })
      .select("id, author_kind, author_name, kind, body, created_at")
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /scheduled-posts/:id/review-comments");
      return;
    }
    res.status(201).json({ id: data.id, authorKind: data.author_kind, authorName: data.author_name, kind: data.kind, body: data.body, createdAt: data.created_at });
  });

  return router;
}
