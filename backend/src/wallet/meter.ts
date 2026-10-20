import type { createWalletLedger } from "./ledger.js";
import { microToCredits } from "./money.js";
import type { WalletMode } from "./mode.js";
import { priceMicro } from "./prices.js";

type Ledger = ReturnType<typeof createWalletLedger>;

export type MeterOutcome =
  | { outcome: "off" }
  | { outcome: "would_charge"; chargedMicro: number }
  | { outcome: "charged"; chargedMicro: number; balanceMicro: number }
  | { outcome: "replay"; chargedMicro: number; balanceMicro: number }
  | { outcome: "exempt" }
  | { outcome: "insufficient_funds"; balanceMicro: number }
  | { outcome: "error" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM = /^[a-z0-9_-]{1,40}$/;

/**
 * Charges one post_publish (1 credit) for a post that has been verified live on a platform. The key is built from the post and the
 * platform, so a retry of the same post is a replay, never a second charge. Best effort by design: it NEVER throws, because the post is
 * already live and a wallet problem must not turn a good publish into a failure. An empty wallet is reported; the queue pause stops the
 * NEXT posts.
 */
export async function meterVerifiedDispatch(input: {
  ledger: Ledger;
  mode: WalletMode;
  post: { postId: string; platform: string; accountId: string };
  log: (line: string) => void;
}): Promise<MeterOutcome> {
  const { ledger, mode, post, log } = input;
  if (mode === "off") return { outcome: "off" };
  if (!UUID.test(post.postId) || !UUID.test(post.accountId) || !PLATFORM.test(post.platform)) {
    log("[wallet] a verified dispatch could not be metered: the post, account or platform was not valid");
    return { outcome: "error" };
  }
  if (mode === "shadow") {
    const chargedMicro = priceMicro("post_publish");
    log(`[wallet-shadow] would charge ${microToCredits(chargedMicro)} credit for a verified dispatch to ${post.platform}`);
    return { outcome: "would_charge", chargedMicro };
  }
  try {
    const r = await ledger.charge({ accountId: post.accountId, action: "post_publish", idempotencyKey: `dispatch:${post.postId}:${post.platform}` });
    if (!r.ok) {
      log("[wallet] a verified dispatch could not be charged: the balance is too low");
      return { outcome: "insufficient_funds", balanceMicro: r.balanceMicro };
    }
    if ("exempt" in r) return { outcome: "exempt" };
    return { outcome: r.replay ? "replay" : "charged", chargedMicro: r.chargedMicro, balanceMicro: r.balanceMicro };
  } catch (error) {
    log(`[wallet] a verified dispatch could not be charged (${error instanceof Error ? error.name : "error"})`);
    return { outcome: "error" };
  }
}
