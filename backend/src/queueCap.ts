import { supabase } from "./supabase.js";
import { resolveTier, type Tier } from "./tier.js";
import { walletMode } from "./wallet/mode.js";
import { isLegacyAccount } from "./wallet/legacy.js";
import type { PostFieldsError } from "./postCreation.js";

/** The Free plan holds at most this many queued posts (pending or waiting for approval). */
export const FREE_QUEUE_CAP = 10;
export const FREE_QUEUE_CAP_MESSAGE = "Your free plan holds up to 10 queued posts. Publish or remove one, or add credits.";
const QUEUED_STATUSES = ["pending", "needs_approval"];

/** Refuses a new queued post when a non-legacy FREE account already holds FREE_QUEUE_CAP of them. Every other tier, every legacy
 *  account, and the whole check unless the wallet is fully on (walletMode() "on": not off, not shadow), answer null. */
export async function checkQueueCap(accountId: string, tier: Tier, isLegacy: boolean): Promise<PostFieldsError | null> {
  if (walletMode() !== "on" || tier !== "free" || isLegacy) return null;

  const { count, error } = await supabase
    .from("scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .in("status", QUEUED_STATUSES);
  if (error) {
    console.error("[queueCap] count failed:", error.message);
    return { status: 500, body: { error: "Something went wrong on our end. Please try again." } };
  }
  return (count ?? 0) >= FREE_QUEUE_CAP ? { status: 403, body: { error: FREE_QUEUE_CAP_MESSAGE } } : null;
}

/** The call sites use this: it looks up the tier and the legacy flag, and with the wallet switch off it reads nothing at all. */
export async function enforceQueueCap(accountId: string | undefined): Promise<PostFieldsError | null> {
  if (!accountId || walletMode() !== "on") return null;
  const [tier, legacy] = await Promise.all([resolveTier(accountId), isLegacyAccount(accountId)]);
  return checkQueueCap(accountId, tier, legacy);
}
