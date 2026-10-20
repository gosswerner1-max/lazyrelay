import type { createWalletLedger } from "./ledger.js";
import type { WalletMode } from "./mode.js";

type Ledger = ReturnType<typeof createWalletLedger>;

/** What the customer sees on a post that is waiting for credits. */
export const INSUFFICIENT_CREDITS_REASON = "Waiting for credits. Add credits and this post will go out on its own.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP = /^[A-Za-z0-9_.\-]{1,90}$/;

/** One hold per post fan-out group and attempt. A retry is a new attempt (the scheduler counts it), a replay of the same attempt reuses
 *  the same hold, so a crash and a re-verify can never hold or charge twice. */
export function holdKey(chargeGroup: string, attempt: number): string {
  return `post:${chargeGroup}:a${attempt}`;
}

export interface GatePost {
  accountId: string;
  /** scheduled_posts.charge_group_id, or the post's own id when it has none. */
  chargeGroupId: string;
  postId: string;
  /** retry_count + 1 */
  attempt: number;
  platform: string;
  /** The platform already accepted this post on an earlier attempt: only the verification is left, so it is never blocked for credits. */
  alreadyPublished?: boolean;
}

/** What the scheduler carries from reserve to commit or release. null = nothing to settle (off, legacy, wallet unreadable). */
export type GateHold =
  | { kind: "shadow" }
  | { kind: "hold"; holdId: string; accountId: string; chargeGroupId: string }
  | { kind: "late"; accountId: string; chargeGroupId: string };

export type Reservation = { proceed: true; hold: GateHold | null } | { proceed: false; reason: string };

export interface PublishGateDeps {
  ledger: Pick<Ledger, "hold" | "commit" | "release" | "charge">;
  mode: WalletMode;
  isLegacy: (accountId: string) => Promise<boolean>;
  /** The hold row for an account and key, for the stuck-post sweep. */
  findHold: (accountId: string, key: string) => Promise<{ id: string; status: string } | null>;
  log: (line: string) => void;
}

/**
 * The publisher's side of the wallet: reserve one credit BEFORE a post is sent, commit it only AFTER the platform read-back says the post
 * is live, release it on every other outcome. Off and shadow never touch the wallet (shadow only logs what it would charge). Nothing here
 * throws: a wallet problem is logged and never turns a good publish into a failure. If the wallet cannot be asked, the post goes out
 * (the same rule as the queue pause), and the outage is logged.
 */
export function createPublishGate(deps: PublishGateDeps) {
  const { ledger, mode, isLegacy, findHold, log } = deps;
  const problem = (what: string, error: unknown) => log(`[wallet] ${what} (${error instanceof Error ? error.name : "error"})`);

  return {
    async reserve(post: GatePost): Promise<Reservation> {
      if (mode === "off") return { proceed: true, hold: null };
      if (mode === "shadow") return { proceed: true, hold: { kind: "shadow" } };
      if (!UUID.test(post.accountId) || !GROUP.test(post.chargeGroupId)) {
        log("[wallet] a post could not be held: the account or group id was not valid");
        return { proceed: true, hold: null };
      }
      try {
        if (await isLegacy(post.accountId)) return { proceed: true, hold: null };
        const r = await ledger.hold({ accountId: post.accountId, action: "post_publish", idempotencyKey: holdKey(post.chargeGroupId, post.attempt) });
        if (r.ok === false) {
          if (post.alreadyPublished) return { proceed: true, hold: { kind: "late", accountId: post.accountId, chargeGroupId: post.chargeGroupId } };
          return { proceed: false, reason: INSUFFICIENT_CREDITS_REASON };
        }
        if ("exempt" in r) return { proceed: true, hold: null };
        return { proceed: true, hold: { kind: "hold", holdId: r.holdId, accountId: post.accountId, chargeGroupId: post.chargeGroupId } };
      } catch (error) {
        problem("a post could not be held, sending it anyway", error);
        return { proceed: true, hold: null };
      }
    },

    /** Call only once the post is verified live. */
    async commit(hold: GateHold | null): Promise<void> {
      if (!hold) return;
      if (hold.kind === "shadow") {
        log("[wallet-shadow] would charge 1 credit for a post verified live");
        return;
      }
      try {
        if (hold.kind === "hold") {
          const r = await ledger.commit(hold.holdId);
          // Another post of the same group already paid for it.
          if (r.ok || r.status === "committed") return;
        }
        // The hold was released or expired in the meantime (or this post was already live and had none): one late charge, same key every
        // time, so it can never be charged twice.
        const late = await ledger.charge({ accountId: hold.accountId, action: "post_publish", idempotencyKey: `post:${hold.chargeGroupId}:late` });
        if (late.ok === false) log("[wallet] a post that went live could not be charged: the balance is too low");
      } catch (error) {
        problem("a verified post could not be charged", error);
      }
    },

    /** Every outcome except verified live. Safe to call on a hold that is already settled. */
    async release(hold: GateHold | null): Promise<void> {
      if (!hold || hold.kind !== "hold") return;
      try {
        await ledger.release(hold.holdId);
      } catch (error) {
        problem("a hold could not be released (it will expire on its own)", error);
      }
    },

    /** The stuck-post sweep: finds the hold of a post that was given up on and releases it. Nothing to do when there is none. */
    async releaseForPost(post: Pick<GatePost, "accountId" | "chargeGroupId" | "attempt">): Promise<void> {
      if (mode !== "on" || !UUID.test(post.accountId) || !GROUP.test(post.chargeGroupId)) return;
      try {
        const found = await findHold(post.accountId, holdKey(post.chargeGroupId, post.attempt));
        if (found) await ledger.release(found.id);
      } catch (error) {
        problem("a stuck post's hold could not be released (it will expire on its own)", error);
      }
    },
  };
}
