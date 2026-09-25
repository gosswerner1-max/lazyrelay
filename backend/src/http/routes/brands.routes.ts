// brands routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { checkBrandLimit } from "../../brandLimits.js";
import { dbError, MAX_VOICE_PROFILE_LENGTH } from "./shared.js";
import { validateBody } from "../validation.js";

export function buildBrandsRouter(): Router {
  const router = Router();

  // Multi-brand support. Started 2026-08-08 as a free-text label per account
  // (migration 0042); promoted 2026-08-16 to a real `brands` entity
  // (migration 0047) so brands can be COUNTED and CAPPED per tier — closing
  // the leak where unlimited brands let one login run an agency's worth of
  // client businesses for a flat fee. Still one login / one subscription, NOT
  // multi-tenant workspaces. Per-tier caps live in brandLimits.ts.
  //
  // Transition note: social_accounts.brand_label is KEPT as a denormalized
  // mirror of the assigned brand's name, so every existing filter (frontend
  // BrandFilterSelect + backend resolveBrandFilterSocialAccountIds, both of
  // which read brand_label) keeps working unchanged. brand_id is the capped
  // source of truth; brand_label is written in lockstep and dropped in a
  // later cleanup once filtering is migrated to brand_id.
  const MAX_BRAND_NAME_LENGTH = 60;
  // Shared by POST and PATCH /brands. `name` is trimmed first (a non-string
  // reads as ""), then required and length-capped — the trimmed value is
  // what gets stored, same as before.
  const brandBodySchema = z.object({
    name: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === "string" ? v.trim() : ""))
      .pipe(
        z
          .string()
          .min(1, "Brand name is required")
          .max(MAX_BRAND_NAME_LENGTH, `Brand name must be ${MAX_BRAND_NAME_LENGTH} characters or fewer`),
      ),
    voiceProfile: z
      .string({ error: "voiceProfile must be a string or null" })
      .max(MAX_VOICE_PROFILE_LENGTH, `voiceProfile must be ${MAX_VOICE_PROFILE_LENGTH} characters or fewer`)
      .nullish(),
  });

  router.get("/brands", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("brands")
      .select("id, name, voice_profile, created_at")
      .eq("account_id", req.accountId)
      .order("name");
    if (error) {
      dbError(res, error, "GET /brands");
      return;
    }
    res.json(data);
  });

  router.post("/brands", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(brandBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { name, voiceProfile } = body.data;
    // Real per-tier cap, not just marketing copy — see brandLimits.ts.
    const limitError = await checkBrandLimit(req.accountId!);
    if (limitError) {
      res.status(403).json({ error: limitError });
      return;
    }
    const { data, error } = await req.db!
      .from("brands")
      .insert({ account_id: req.accountId, name, voice_profile: voiceProfile?.trim() || null })
      .select("id, name, voice_profile, created_at")
      .maybeSingle();
    if (error) {
      // 23505 = the case-insensitive unique index on (account_id, lower(name)).
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "You already have a brand with that name." });
        return;
      }
      dbError(res, error, "POST /brands");
      return;
    }
    res.status(201).json(data);
  });

  router.patch("/brands/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(brandBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { name, voiceProfile } = body.data;
    const update: Record<string, unknown> = { name };
    if (voiceProfile !== undefined) update.voice_profile = voiceProfile?.trim() || null;
    const { data, error } = await req.db!
      .from("brands")
      .update(update)
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id, name, voice_profile, created_at")
      .maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "You already have a brand with that name." });
        return;
      }
      dbError(res, error, "PATCH /brands/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    // Keep the brand_label mirror in sync on this brand's accounts.
    const { error: mirrorError } = await req.db!
      .from("social_accounts")
      .update({ brand_label: name })
      .eq("account_id", req.accountId)
      .eq("brand_id", req.params.id);
    if (mirrorError) {
      dbError(res, mirrorError, "PATCH /brands/:id mirror");
      return;
    }
    res.json(data);
  });

  router.delete("/brands/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // Clear the brand_label mirror on this brand's accounts first. brand_id
    // auto-nulls via the FK's `on delete set null`, but the denormalized
    // mirror must be cleared explicitly.
    const { error: mirrorError } = await req.db!
      .from("social_accounts")
      .update({ brand_label: null })
      .eq("account_id", req.accountId)
      .eq("brand_id", req.params.id);
    if (mirrorError) {
      dbError(res, mirrorError, "DELETE /brands/:id mirror");
      return;
    }
    const { data, error } = await req.db!
      .from("brands")
      .delete()
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id")
      .maybeSingle();
    if (error) {
      dbError(res, error, "DELETE /brands/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
