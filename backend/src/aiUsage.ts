import { supabase } from "./supabase.js";
import { resolveTier, type Tier } from "./tier.js";

/** Daily cap on combined /ai/caption + /ai/hashtags calls per account,
 *  added 2026-07-31 specifically to bound real Anthropic API spend. Without
 *  this, tieredRateLimit's per-minute request cap (see rateLimit.ts) is the
 *  only backstop — and that's a request-volume guard against API abuse, not
 *  a cost control, so a customer well within it could still generate
 *  hundreds of times a day. These numbers are a starting point, not tied to
 *  external research — easy to tune once real usage data exists.
 *  `null` = unlimited. Keyed by DB code — pro displays as "Starter",
 *  business displays as "Pro", enterprise displays as "Business" (see
 *  tier.ts's Tier type comment). */
export const AI_GENERATION_DAILY_LIMIT: Record<Tier, number | null> = {
  free: 5,
  pro: 20, // "Starter"
  business: 50, // "Pro"
  enterprise: 100, // "Business"
};

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Checked BEFORE calling Anthropic — returns a customer-facing reason if
 *  the account is at today's cap, or null if there's room. Does not itself
 *  increment; call recordGeneration() only after a successful Anthropic call
 *  so a failed/errored generation doesn't count against the cap. */
export async function checkGenerationLimit(accountId: string): Promise<string | null> {
  const tier = await resolveTier(accountId);
  const limit = AI_GENERATION_DAILY_LIMIT[tier];
  if (limit === null) return null;

  const { data, error } = await supabase
    .from("ai_generation_usage")
    .select("generation_count")
    .eq("account_id", accountId)
    .eq("usage_date", todayUTC())
    .maybeSingle();
  if (error) throw error;

  const used = data?.generation_count ?? 0;
  if (used < limit) return null;
  return `You've used all ${limit} AI generations included today on your plan. This resets tomorrow, or upgrade for a higher daily limit.`;
}

/** Call once, after a successful Anthropic response — atomically upserts
 *  today's row for this account. Uses Postgres's ON CONFLICT DO UPDATE via
 *  a raw increment rather than read-then-write, so concurrent requests from
 *  the same account can't race past the cap. */
export async function recordGeneration(accountId: string): Promise<void> {
  const { error } = await supabase.rpc("increment_ai_generation_usage", {
    p_account_id: accountId,
    p_usage_date: todayUTC(),
  });
  if (error) throw error;
}
