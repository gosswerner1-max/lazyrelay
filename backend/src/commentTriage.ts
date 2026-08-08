import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./supabase.js";

// Comment/DM triage (2026-08-08) — item 10 from the 2026-08-07 competitor
// audit: surface only the comment/DM that actually needs a human, instead
// of making the customer scan every item in the Mentions/DMs tabs
// themselves. See migration 0040_comment_triage.sql for why results are
// cached (never re-billed for the same item) and what source_signature
// means for each item type.
//
// Classification runs on-demand, batched into a single Anthropic call per
// tab load (not one call per item) — bounded by tieredRateLimit on the
// calling route plus MAX_ITEMS_PER_BATCH below, so this never needs its own
// AI-usage quota the way customer-initiated /ai/caption generations do.
// Same optional-integration fall-through as every other Anthropic-backed
// feature: no ANTHROPIC_API_KEY, or a failed/malformed AI response, just
// means these items come back unclassified — never blocks the inbox from
// loading.

export interface TriageResult {
  needsAttention: boolean;
  category: "angry_customer" | "sales_question" | "question" | "routine";
  reason: string;
}

export interface TriageItem {
  itemId: string;
  sourceSignature: string;
  author: string;
  text: string;
}

// Caps the size (and cost) of a single classification call regardless of
// how many comments/conversations are in one response — any items beyond
// this simply come back unclassified this request and get picked up (and
// cached) on a later one, same as an uncached item today.
const MAX_ITEMS_PER_BATCH = 30;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey, timeout: 20_000 });
}

async function classifyBatch(items: TriageItem[]): Promise<Map<string, TriageResult>> {
  const out = new Map<string, TriageResult>();
  const client = getClient();
  if (!client || items.length === 0) return out;

  const batch = items.slice(0, MAX_ITEMS_PER_BATCH);
  const prompt =
    `You triage incoming social media comments and DMs for a small business owner. ` +
    `For each numbered item, decide whether it genuinely needs the owner's personal attention, or is routine content ` +
    `that's safe to skip (generic praise, emojis, spam, bot replies).\n\n` +
    `Return ONLY a JSON array, one object per item in the same order, no other text. Each object:\n` +
    `{"needsAttention": boolean, "category": "angry_customer" | "sales_question" | "question" | "routine", "reason": "<8 words or fewer>"}\n\n` +
    batch.map((item, i) => `${i + 1}. ${item.author}: ${item.text}`).join("\n");

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return out;

    const match = textBlock.text.match(/\[[\s\S]*\]/);
    if (!match) return out;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || parsed.length !== batch.length) return out;

    parsed.forEach((entry, i) => {
      const category = entry?.category;
      const validCategories = ["angry_customer", "sales_question", "question", "routine"];
      if (typeof entry?.needsAttention !== "boolean" || !validCategories.includes(category) || typeof entry?.reason !== "string") {
        return;
      }
      out.set(batch[i].itemId, { needsAttention: entry.needsAttention, category, reason: entry.reason.slice(0, 200) });
    });
  } catch (err) {
    console.error("[commentTriage] classifyBatch failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

/** Returns a map from itemId to its triage result for every item passed in
 *  that has one (either reused from cache, or freshly classified this
 *  call) — an item missing from the returned map means it couldn't be
 *  classified this request (no API key configured, or the AI call/parse
 *  failed) and should be treated as "unclassified", not "routine". */
export async function triageItems(accountId: string, itemType: "comment" | "dm", items: TriageItem[]): Promise<Map<string, TriageResult>> {
  const out = new Map<string, TriageResult>();
  if (items.length === 0) return out;

  const itemIds = items.map((i) => i.itemId);
  const { data: cached, error } = await supabase
    .from("comment_triage")
    .select("item_id, source_signature, needs_attention, category, reason")
    .eq("account_id", accountId)
    .eq("item_type", itemType)
    .in("item_id", itemIds);
  if (error) {
    console.error("[commentTriage] cache lookup failed:", error.message);
  }

  const cachedByItemId = new Map((cached ?? []).map((row) => [row.item_id, row]));
  const toClassify: TriageItem[] = [];
  for (const item of items) {
    const row = cachedByItemId.get(item.itemId);
    if (row && row.source_signature === item.sourceSignature) {
      out.set(item.itemId, { needsAttention: row.needs_attention, category: row.category as TriageResult["category"], reason: row.reason });
    } else {
      toClassify.push(item);
    }
  }

  if (toClassify.length === 0) return out;

  const freshResults = await classifyBatch(toClassify);
  if (freshResults.size === 0) return out;

  const upsertRows = toClassify
    .filter((item) => freshResults.has(item.itemId))
    .map((item) => {
      const result = freshResults.get(item.itemId)!;
      out.set(item.itemId, result);
      return {
        account_id: accountId,
        item_type: itemType,
        item_id: item.itemId,
        source_signature: item.sourceSignature,
        needs_attention: result.needsAttention,
        category: result.category,
        reason: result.reason,
      };
    });

  const { error: upsertError } = await supabase.from("comment_triage").upsert(upsertRows, { onConflict: "account_id,item_type,item_id" });
  if (upsertError) {
    console.error("[commentTriage] cache upsert failed:", upsertError.message);
  }

  return out;
}
