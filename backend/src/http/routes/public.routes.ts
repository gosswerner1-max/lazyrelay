// public routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { publicRateLimit } from "../rateLimit.js";
import { sendReviewFeedbackNotification } from "../../email.js";
import tls from "node:tls";
import { dbError, isReservedBusinessName } from "./shared.js";
import { validateBody } from "../validation.js";

export function buildPublicRouter(): Router {
  const router = Router();

  // Public, pre-signup availability check (2026-08-30) — no auth exists yet
  // at this point (see AuthContext.tsx's signUp), so this can't be a
  // duplicate-name check on an authed route the way PATCH /account's is.
  //
  // Until 2026-09-01 this read EVERY non-null business_name into memory on
  // each call and compared in JS. That was a deliberate trade, not an
  // oversight: building a PostgREST OR-filter out of untrusted names is
  // genuinely fragile, since commas and parens are filter syntax. But this
  // route is unauthenticated AND fires on every keystroke batch during
  // signup, so the cost of each anonymous request grew with the accounts
  // table. Moved into check_business_name_available() (migration 0077),
  // which avoids the filter-string hazard entirely rather than walking into
  // it — every candidate is a bound value and the lookup rides
  // accounts_lower_business_name_idx (migration 0074). At most 6 index hits
  // per call instead of a full scan; response shape unchanged.
  //
  // The three guards below still run in Node, before the DB is touched.
  // isReservedBusinessName in particular must NOT be duplicated into SQL —
  // PATCH /account shares it, and two implementations would drift.
  router.post("/public/signup/check-business-name", publicRateLimit, async (req, res) => {
    const raw = typeof req.body?.businessName === "string" ? req.body.businessName.trim() : "";
    if (!raw) {
      res.json({ available: true });
      return;
    }
    if (raw.length > 80) {
      res.status(400).json({ error: "businessName must be 80 characters or fewer" });
      return;
    }
    if (/[\r\n]/.test(raw)) {
      res.status(400).json({ error: "businessName can't contain line breaks" });
      return;
    }
    if (isReservedBusinessName(raw)) {
      res.json({ available: false, reason: "reserved" });
      return;
    }
    const { data, error } = await supabase.rpc("check_business_name_available", { p_name: raw });
    if (error) {
      dbError(res, error, "POST /public/signup/check-business-name");
      return;
    }
    res.json(data);
  });

  // Public Proof-of-Publish verification page — no auth, this is what
  // renders at lazyrelay.com/verify/:id when a customer shares the link
  // from GET /scheduled-posts/:id/proof-link. post_results.id doubles as
  // the public identifier (already a random UUID, same safety class as a
  // Stripe/Zoom link — no dedicated slug column needed, see migration
  // 0038_proof_link_sharing.sql). Returns 404 for both "doesn't exist" and
  // "exists but not verified live" — never distinguish the two, and never
  // include account_id, platform_post_id, or error_message.
  router.get("/public/verify/:id", publicRateLimit, async (req, res) => {
    const { data: result, error } = await supabase
      .from("post_results")
      .select(
        "verified_live, platform_post_url, verification_checked_at, scheduled_posts(content, scheduled_for, social_accounts(platform, display_name), accounts(business_name))"
      )
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /public/verify/:id");
      return;
    }
    const post = result?.scheduled_posts as unknown as {
      content: string;
      scheduled_for: string;
      social_accounts: { platform: string; display_name: string | null } | null;
      accounts: { business_name: string | null } | null;
    } | null;
    if (!result || !result.verified_live || !post) {
      res.status(404).json({ error: "Nothing verified at this link." });
      return;
    }
    res.json({
      businessName: post.accounts?.business_name ?? null,
      platform: post.social_accounts?.platform ?? null,
      accountName: post.social_accounts?.display_name ?? null,
      content: post.content,
      scheduledFor: post.scheduled_for,
      verifiedAt: result.verification_checked_at,
      platformPostUrl: result.platform_post_url,
    });
  });

  // Public review-feedback form — no auth, reached from the review-request
  // email's link (Template 12 in EMAIL_REPLY_TEMPLATES.md). token doubles
  // as the sole authorization, same pattern as post_results.id above and
  // account_members.invite_token (migration 0053) — a random uuid Postgres
  // generates on insert, not app code. Werner's call 2026-08-21: replace
  // "reply to this email" with a real 5-question star-rating form + an
  // optional comment box (migration 0063).
  router.get("/public/feedback/:token", publicRateLimit, async (req, res) => {
    const { data: row, error } = await supabase
      .from("review_feedback")
      .select("submitted_at")
      .eq("token", req.params.token)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /public/feedback/:token");
      return;
    }
    if (!row) {
      res.status(404).json({ error: "This feedback link isn't valid." });
      return;
    }
    res.json({ alreadySubmitted: !!row.submitted_at });
  });

  // Column name -> the same question wording shown on FeedbackForm.tsx, for
  // the internal notification email's ratings summary.
  const FEEDBACK_QUESTION_LABELS = [
    ["rating_overall", "Overall satisfaction:"],
    ["rating_reliability", "Reliability:"],
    ["rating_ease", "Ease of getting started:"],
    ["rating_support", "Support:"],
    ["rating_recommend", "Likelihood to recommend:"],
  ] as const;

  // Each rating: an integer from 1 to 5, checked in the order below (the
  // first bad one is the one reported, same as the old per-field loop).
  const ratingField = (bodyKey: string) => {
    const message = `${bodyKey} must be an integer from 1 to 5.`;
    return z
      .number({ error: message })
      .refine((n) => Number.isInteger(n), message)
      .refine((n) => n >= 1 && n <= 5, message);
  };
  const feedbackBodySchema = z.object({
    ratingOverall: ratingField("ratingOverall"),
    ratingReliability: ratingField("ratingReliability"),
    ratingEase: ratingField("ratingEase"),
    ratingSupport: ratingField("ratingSupport"),
    ratingRecommend: ratingField("ratingRecommend"),
  });
  router.post("/public/feedback/:token", publicRateLimit, async (req, res) => {
    const ratingFields = [
      ["ratingOverall", "rating_overall"],
      ["ratingReliability", "rating_reliability"],
      ["ratingEase", "rating_ease"],
      ["ratingSupport", "rating_support"],
      ["ratingRecommend", "rating_recommend"],
    ] as const;

    const body = validateBody(feedbackBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const update: Record<string, unknown> = { submitted_at: new Date().toISOString() };
    for (const [bodyKey, column] of ratingFields) {
      update[column] = body.data[bodyKey];
    }
    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim().slice(0, 2000) : null;
    update.comment = comment || null;

    const { data: existing, error: fetchError } = await supabase
      .from("review_feedback")
      .select("id, submitted_at")
      .eq("token", req.params.token)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "POST /public/feedback/:token fetch");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "This feedback link isn't valid." });
      return;
    }
    if (existing.submitted_at) {
      res.status(409).json({ error: "This feedback link has already been used." });
      return;
    }

    const { error: updateError } = await supabase.from("review_feedback").update(update).eq("id", existing.id);
    if (updateError) {
      dbError(res, updateError, "POST /public/feedback/:token update");
      return;
    }
    // Werner's call 2026-08-21: one click and it's genuinely delivered to
    // us, no further action needed from the customer — this real email to
    // hello@lazyrelay.com IS the delivery, not just a courtesy copy.
    const ratingsSummary = FEEDBACK_QUESTION_LABELS.map(([column, label]) => `${label} ${update[column]}/5`).join("\n");
    sendReviewFeedbackNotification(ratingsSummary, comment);
    res.json({ ok: true });
  });

  // Public status endpoint — no auth, deliberately narrow: only the signals
  // a customer actually needs (is the scheduler running on time, is the
  // site's certificate healthy), never business-sensitive numbers like MAU
  // or DB size — those stay internal-ops-only (see ops/health/health_ops.js,
  // whose real scheduler-lag query this reuses, translated to TS).
  router.get("/public/status", publicRateLimit, async (_req, res) => {
    const graceMinutes = 5;
    const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .is("paused_at", null)
      .lt("scheduled_for", cutoff);
    if (error) {
      dbError(res, error, "GET /public/status");
      return;
    }
    const overdueCount = count ?? 0;
    const schedulerStatus = overdueCount >= 5 ? "delayed" : overdueCount >= 1 ? "watching" : "ok";

    const ssl = await new Promise<{ status: string; daysRemaining: number | null }>((resolve) => {
      const socket = tls.connect(
        { host: "lazyrelay.com", port: 443, servername: "lazyrelay.com", timeout: 15000 },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (!cert || !cert.valid_to) {
            resolve({ status: "unknown", daysRemaining: null });
            return;
          }
          const daysRemaining = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / (24 * 3600 * 1000));
          resolve({ status: daysRemaining <= 7 ? "critical" : daysRemaining <= 14 ? "warn" : "ok", daysRemaining });
        }
      );
      socket.on("error", () => resolve({ status: "unknown", daysRemaining: null }));
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ status: "unknown", daysRemaining: null });
      });
    });

    const overall = schedulerStatus === "delayed" || ssl.status === "critical" ? "degraded" : "operational";

    res.json({
      overall,
      checkedAt: new Date().toISOString(),
      scheduler: { status: schedulerStatus, overdueCount },
      ssl,
    });
  });

  return router;
}
