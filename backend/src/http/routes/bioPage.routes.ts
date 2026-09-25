// bioPage routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit, publicRateLimit } from "../rateLimit.js";
import { isSafeMediaUrl } from "../../urlSafety.js";
import { dbError } from "./shared.js";
import { validateBody, optionalNullableString } from "../validation.js";

export function buildBioPageRouter(): Router {
  const router = Router();

  // Link-in-bio page — one per account, the kind of page a customer puts
  // in their Instagram/TikTok bio. Reads own page/links for the dashboard
  // editor; the public rendering route is further down, not behind
  // requireAuth (see 0027_bio_pages.sql for why RLS alone can't serve it).
  const BIO_SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;
  router.get("/bio-page", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // bio_pages/bio_links stay on supabase (service-role) throughout this
    // file, not req.db -- 0027_bio_pages.sql's own comment: "No client-facing
    // RLS policies... only the backend's service-role client ever
    // reads/writes this table." req.db would just see zero rows here.
    const { data: page, error } = await supabase.from("bio_pages").select("*").eq("account_id", req.accountId).maybeSingle();
    if (error) {
      dbError(res, error, "GET /bio-page");
      return;
    }
    if (!page) {
      res.json(null);
      return;
    }
    const { data: links, error: linksError } = await supabase
      .from("bio_links")
      .select("*")
      .eq("bio_page_id", page.id)
      .order("position", { ascending: true });
    if (linksError) {
      dbError(res, linksError, "GET /bio-page links");
      return;
    }
    res.json({ ...page, links: links ?? [] });
  });

  const SLUG_ERROR = "slug must be 3-40 characters: lowercase letters, numbers, and hyphens only";
  const TITLE_ERROR = "title must be a string, 100 characters or fewer";
  const BIO_ERROR = "bio must be a string, 500 characters or fewer";
  const bioPageBodySchema = z.object({
    slug: z.string({ error: SLUG_ERROR }).regex(BIO_SLUG_PATTERN, SLUG_ERROR),
    title: z.string({ error: TITLE_ERROR }).max(100, TITLE_ERROR),
    bio: z.string({ error: BIO_ERROR }).max(500, BIO_ERROR),
    avatarUrl: optionalNullableString("avatarUrl must be a string"),
  });
  router.put("/bio-page", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(bioPageBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { slug, title, bio, avatarUrl } = body.data;
    // Nothing server-side fetches avatarUrl today (it's only ever rendered
    // client-side as an <img src>, per BioPage.tsx), so this wasn't
    // exploitable in practice -- but every other customer-supplied URL
    // field in this file gets this same check, and this one didn't, found
    // in the 2026-09-06 security audit. Closing it now, before this field
    // is ever consumed server-side (an image proxy/resize step, say),
    // rather than waiting for that to be the reason it gets found again.
    // (Its must-be-a-string check now lives in bioPageBodySchema above.)
    if (avatarUrl !== undefined && avatarUrl !== null) {
      const trimmedAvatarUrl = avatarUrl.trim();
      if (trimmedAvatarUrl.length > 0) {
        const avatarSafety = await isSafeMediaUrl(trimmedAvatarUrl);
        if (!avatarSafety.safe) {
          res.status(400).json({ error: `avatarUrl ${avatarSafety.reason}` });
          return;
        }
      }
    }

    // bio_pages/bio_links: service-role only, see the comment on GET
    // /bio-page above (0027_bio_pages.sql).
    const { data: slugOwner } = await supabase.from("bio_pages").select("account_id").eq("slug", slug).maybeSingle();
    if (slugOwner && slugOwner.account_id !== req.accountId) {
      res.status(409).json({ error: "That link name is already taken — pick another." });
      return;
    }

    const { data, error } = await supabase
      .from("bio_pages")
      .upsert(
        { account_id: req.accountId, slug, title, bio, avatar_url: avatarUrl ?? null, updated_at: new Date().toISOString() },
        { onConflict: "account_id" },
      )
      .select()
      .single();
    if (error) {
      dbError(res, error, "PUT /bio-page");
      return;
    }
    res.json(data);
  });

  const LINK_LABEL_ERROR = "label must be a non-empty string, 80 characters or fewer";
  const LINK_URL_ERROR = "url must start with http:// or https://";
  const bioLinkLabelField = () =>
    z
      .string({ error: LINK_LABEL_ERROR })
      .refine((s) => s.trim().length > 0, LINK_LABEL_ERROR)
      .max(80, LINK_LABEL_ERROR);
  const bioLinkUrlField = () => z.string({ error: LINK_URL_ERROR }).regex(/^https?:\/\//, LINK_URL_ERROR);
  const bioLinkBodySchema = z.object({
    label: bioLinkLabelField(),
    url: bioLinkUrlField(),
  });
  router.post("/bio-page/links", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(bioLinkBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { label, url } = body.data;

    // bio_pages/bio_links: service-role only, see the comment on GET
    // /bio-page above (0027_bio_pages.sql).
    const { data: page, error: pageError } = await supabase
      .from("bio_pages")
      .select("id")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (pageError) {
      dbError(res, pageError, "POST /bio-page/links page lookup");
      return;
    }
    if (!page) {
      res.status(404).json({ error: "Set up your bio page first (PUT /bio-page) before adding links." });
      return;
    }

    const { count } = await supabase.from("bio_links").select("id", { count: "exact", head: true }).eq("bio_page_id", page.id);

    const { data, error } = await supabase
      .from("bio_links")
      .insert({ bio_page_id: page.id, label: label.trim(), url, position: count ?? 0 })
      .select()
      .single();
    if (error) {
      dbError(res, error, "POST /bio-page/links insert");
      return;
    }
    res.status(201).json(data);
  });

  const bioLinkEditBodySchema = z.object({
    label: bioLinkLabelField().optional(),
    url: bioLinkUrlField().optional(),
    position: z
      .number({ error: "position must be an integer" })
      .refine((n) => Number.isInteger(n), "position must be an integer")
      .optional(),
  });
  router.patch("/bio-page/links/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(bioLinkEditBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { label, url, position } = body.data;
    const updates: Record<string, unknown> = {};
    if (label !== undefined) {
      updates.label = label.trim();
    }
    if (url !== undefined) {
      updates.url = url;
    }
    if (position !== undefined) {
      updates.position = position;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    // A link only belongs to a page owned by this account — join through
    // bio_pages rather than trusting the link id alone, same ownership
    // discipline as every other per-resource route.
    // bio_pages/bio_links: service-role only, see the comment on GET
    // /bio-page above (0027_bio_pages.sql).
    const { data: link, error: linkError } = await supabase
      .from("bio_links")
      .select("id, bio_pages!inner(account_id)")
      .eq("id", req.params.id)
      .single();
    if (linkError || !link || (link.bio_pages as unknown as { account_id: string }).account_id !== req.accountId) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    const { data, error } = await supabase.from("bio_links").update(updates).eq("id", req.params.id).select().single();
    if (error) {
      dbError(res, error, "PATCH /bio-page/links/:id");
      return;
    }
    res.json(data);
  });

  router.delete("/bio-page/links/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // bio_pages/bio_links: service-role only, see the comment on GET
    // /bio-page above (0027_bio_pages.sql).
    const { data: link, error: linkError } = await supabase
      .from("bio_links")
      .select("id, bio_pages!inner(account_id)")
      .eq("id", req.params.id)
      .single();
    if (linkError || !link || (link.bio_pages as unknown as { account_id: string }).account_id !== req.accountId) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    const { error } = await supabase.from("bio_links").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /bio-page/links/:id");
      return;
    }
    res.status(204).send();
  });

  // Public rendering endpoint — no auth, this is what the actual bio page
  // (linked from a customer's Instagram/TikTok profile) fetches. Returns
  // only what's safe to show the public: no account_id, no internal ids
  // beyond what's needed for React keys.
  router.get("/public/bio/:slug", publicRateLimit, async (req, res) => {
    const { data: page, error } = await supabase
      .from("bio_pages")
      .select("id, slug, title, bio, avatar_url")
      .eq("slug", req.params.slug)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /public/bio/:slug");
      return;
    }
    if (!page) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const { data: links, error: linksError } = await supabase
      .from("bio_links")
      .select("id, label, url")
      .eq("bio_page_id", page.id)
      .order("position", { ascending: true });
    if (linksError) {
      dbError(res, linksError, "GET /public/bio/:slug links");
      return;
    }
    res.json({ title: page.title, bio: page.bio, avatarUrl: page.avatar_url, links: links ?? [] });
  });

  return router;
}
