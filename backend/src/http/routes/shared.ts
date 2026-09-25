// Helpers and constants shared by more than one route module under
// http/routes/. Everything here was moved verbatim out of the original
// single-file http/routes.ts (split 2026-09-25) — the only change is the
// added `export` keyword.

import { type Request, type Response } from "express";
import { supabase } from "../../supabase.js";

// Postgres/Supabase error messages can name internal detail (constraint
// names, column names, query shape) that shouldn't reach a customer. Log the
// real message server-side for debugging, return a generic one to the
// client. Use this for DB-layer errors; a message we wrote ourselves
// (validation, business-rule errors) should still be returned directly.
export function dbError(res: Response, err: { message: string }, context: string): void {
  console.error(`[routes] ${context}:`, err.message);
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
}

// See createAnthropicClient's own comment (posthogClient.ts) for why this
// exists. Fails closed (treats a missing/malformed header as denied) --
// the safe default for a consent signal is "not granted," not "granted."
export function readAnalyticsConsent(req: Request): boolean {
  return req.headers["x-analytics-consent"] === "granted";
}

// Prefixes reserved for LazyRelay's own family of names (Werner,
// 2026-08-30) — a customer picking "Lazy..." would both collide with our
// own brand and undercut the whole point of unique names (support/agents
// still can't tell accounts apart at a glance). Checked separately from,
// and before, the uniqueness lookup below — no numeric-suffix suggestion
// makes sense for a reserved word, since "Lazy Co 2" is just as reserved.
export const RESERVED_BUSINESS_NAME_PREFIXES = ["lazy"];

export function isReservedBusinessName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_BUSINESS_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// Free-text voice description ("casual, funny, short sentences, lots of
// emoji") fed into the AI caption/hashtag prompts — generous but bounded,
// same reasoning as MAX_POST_CONTENT_LENGTH elsewhere: a customer pasting
// something enormous shouldn't blow out prompt size or cost unbounded.
export const MAX_VOICE_PROFILE_LENGTH = 2000;

// (Moved here from http/routes.ts's buildRouter() — see posts.routes.ts for the comment explaining it.)
export const SUPABASE_ROW_PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxRows: number,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (offset < maxRows) {
    const to = Math.min(offset + SUPABASE_ROW_PAGE_SIZE, maxRows) - 1;
    const { data, error } = await queryFactory(offset, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < to - offset + 1) break;
    offset += data.length;
  }
  return all;
}

// (Moved here from http/routes.ts's buildRouter() — see analytics.routes.ts for the comment explaining it.)
export const UNBRANDED_FILTER_VALUE = "__unbranded__";

// Shared by /analytics/summary and /analytics/insight — both need to
// resolve a "brand" filter value down to the matching social_account_ids
// before querying scheduled_posts. Returns undefined for "no filter".
export async function resolveBrandFilterSocialAccountIds(accountId: string, brand: string | undefined): Promise<string[] | undefined> {
  if (brand === undefined) return undefined;
  let query = supabase.from("social_accounts").select("id").eq("account_id", accountId);
  query = brand === UNBRANDED_FILTER_VALUE ? query.is("brand_label", null) : query.eq("brand_label", brand);
  const { data, error } = await query;
  if (error) throw error;
  // A dummy UUID when nothing matches, rather than an empty array — .in()
  // with an empty list isn't a reliable "match nothing" across Supabase
  // JS versions, and this guarantees zero rows either way.
  return data && data.length > 0 ? data.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"];
}

// Where the OAuth callbacks (social accounts, Google Calendar, Google Sheets)
// send the browser back to. Was a single `const frontendUrl` inside
// buildRouter(); each route module now calls this once when its router is
// built, so it's still read at router-build time exactly as before.
export function getFrontendUrl(): string {
  return process.env.FRONTEND_URL ?? "http://localhost:5173";
}
