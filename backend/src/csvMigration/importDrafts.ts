// The confirm step: creates the drafts. Drafts only (status "draft", no connection, no scheduled time), written the same way
// the existing draft route writes them, in ONE insert. Rows already imported from the same file are skipped, so confirming
// twice never duplicates. The identity of an imported row is a tag on the draft (ih-<hash of file fingerprint, row, content>).

import type { SupabaseClient } from "@supabase/supabase-js";
import { extrasToColumns, normalizeDraftExtras } from "../postExtras.js";
import { MAX_DRAFTS_PER_REQUEST } from "./limits.js";
import type { Analysis, ImportItem, SkipReason } from "./analyze.js";

export interface ImportResult {
  created: number;
  skipped: Array<{ row: number; reason: SkipReason }>;
  draftIds: string[];
  /** Usable rows left for another confirm because this request reached its cap. */
  remaining: number;
}

const LOOKUP_CHUNK = 100;

async function alreadyImported(db: SupabaseClient, accountId: string, items: ImportItem[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < items.length; i += LOOKUP_CHUNK) {
    const wanted = items.slice(i, i + LOOKUP_CHUNK).map((item) => item.importTag);
    const { data, error } = await db.from("scheduled_posts").select("tags").eq("account_id", accountId).overlaps("tags", wanted);
    if (error) throw new Error(`csv import lookup failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ tags: string[] | null }>) {
      for (const tag of row.tags ?? []) found.add(tag);
    }
  }
  return found;
}

async function draftRow(accountId: string, sourceTag: string, item: ImportItem) {
  const extras = await normalizeDraftExtras({ tags: [sourceTag, item.importTag] });
  if (!extras.ok) throw new Error(`csv import tags rejected: ${extras.failure.body.error}`);
  return {
    account_id: accountId,
    social_account_id: null,
    content: item.content,
    media_url: null,
    cover_image_url: null,
    board_id: null,
    destination_link: null,
    first_comment: null,
    media_alt_text: null,
    tiktok_privacy_level: null,
    tiktok_disable_comment: true,
    tiktok_disable_duet: true,
    tiktok_disable_stitch: true,
    tiktok_brand_organic: false,
    tiktok_brand_content: false,
    planned_date: item.plannedDate,
    planned_account_ids: null,
    scheduled_for: null,
    ...extrasToColumns(extras.extras, true),
    status: "draft",
  };
}

export async function importDrafts(db: SupabaseClient, accountId: string, analysis: Analysis): Promise<ImportResult> {
  const known = await alreadyImported(db, accountId, analysis.items);
  const fresh = analysis.items.filter((item) => !known.has(item.importTag));
  const batch = fresh.slice(0, MAX_DRAFTS_PER_REQUEST);
  const skipped: ImportResult["skipped"] = [
    ...analysis.skipped,
    ...analysis.items.filter((item) => known.has(item.importTag)).map((item) => ({ row: item.row, reason: "already_imported" as const })),
  ].sort((a, b) => a.row - b.row);
  if (batch.length === 0) return { created: 0, skipped, draftIds: [], remaining: 0 };
  const rows = await Promise.all(batch.map((item) => draftRow(accountId, analysis.sourceTag, item)));
  const { data, error } = await db.from("scheduled_posts").insert(rows).select("id");
  if (error) throw new Error(`csv import insert failed: ${error.message}`);
  const draftIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  return { created: draftIds.length, skipped, draftIds, remaining: fresh.length - batch.length };
}
