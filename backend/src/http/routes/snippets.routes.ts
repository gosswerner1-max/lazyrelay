// Saved snippets (2026-09-30): reusable text a customer inserts into a post, and
// one optional "signature". See migration 0099. Any signed-in member of the
// account (dashboard session or API key) can list, add, edit and remove them;
// every query is filtered by the caller's account.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { dbError } from "./shared.js";
import { validateBody } from "../validation.js";

export const MAX_SNIPPETS = 50;
export const MAX_SNIPPET_LENGTH = 2000;

const nameSchema = z.string({ error: "name is required" }).trim().min(1, "name is required").max(60, "name must be 60 characters or fewer");
const contentSchema = z
  .string({ error: "content is required" })
  .trim()
  .min(1, "content is required")
  .max(MAX_SNIPPET_LENGTH, `content must be ${MAX_SNIPPET_LENGTH} characters or fewer`);

const createSchema = z.object({
  name: nameSchema,
  content: contentSchema,
  isSignature: z.boolean({ error: "isSignature must be true or false" }).optional(),
});
const updateSchema = z.object({
  name: nameSchema.optional(),
  content: contentSchema.optional(),
  isSignature: z.boolean({ error: "isSignature must be true or false" }).optional(),
});

interface SnippetRow {
  id: string;
  name: string;
  content: string;
  is_signature: boolean;
  created_at: string;
}
const toPublic = (r: SnippetRow) => ({ id: r.id, name: r.name, content: r.content, isSignature: r.is_signature, createdAt: r.created_at });
const COLUMNS = "id, name, content, is_signature, created_at";

const guard = [requireAuth, tieredRateLimit] as const;

export function buildSnippetsRouter(): Router {
  const router = Router();

  router.get("/snippets", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("saved_snippets")
      .select(COLUMNS)
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /snippets");
      return;
    }
    res.json({ maxSnippets: MAX_SNIPPETS, snippets: ((data ?? []) as SnippetRow[]).map(toPublic) });
  });

  router.post("/snippets", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(createSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { count } = await supabase.from("saved_snippets").select("id", { count: "exact", head: true }).eq("account_id", req.accountId);
    if ((count ?? 0) >= MAX_SNIPPETS) {
      res.status(400).json({ error: `You can save up to ${MAX_SNIPPETS} snippets. Remove one first.` });
      return;
    }
    // Only one signature per account.
    if (body.data.isSignature) await supabase.from("saved_snippets").update({ is_signature: false }).eq("account_id", req.accountId);
    const { data, error } = await supabase
      .from("saved_snippets")
      .insert({ account_id: req.accountId, name: body.data.name, content: body.data.content, is_signature: body.data.isSignature === true })
      .select(COLUMNS)
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /snippets");
      return;
    }
    res.status(201).json(toPublic(data as SnippetRow));
  });

  router.patch("/snippets/:id", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(updateSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const update: Record<string, unknown> = {};
    if (body.data.name !== undefined) update.name = body.data.name;
    if (body.data.content !== undefined) update.content = body.data.content;
    if (body.data.isSignature !== undefined) update.is_signature = body.data.isSignature;
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const { data: existing } = await supabase.from("saved_snippets").select("id").eq("id", req.params.id).eq("account_id", req.accountId).maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "Snippet not found" });
      return;
    }
    if (body.data.isSignature) await supabase.from("saved_snippets").update({ is_signature: false }).eq("account_id", req.accountId);
    const { data, error } = await supabase
      .from("saved_snippets")
      .update(update)
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select(COLUMNS)
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /snippets/:id");
      return;
    }
    res.json(toPublic(data as SnippetRow));
  });

  router.delete("/snippets/:id", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase.from("saved_snippets").delete().eq("id", req.params.id).eq("account_id", req.accountId).select("id");
    if (error) {
      dbError(res, error, "DELETE /snippets/:id");
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Snippet not found" });
      return;
    }
    res.json({ deleted: true });
  });

  return router;
}
