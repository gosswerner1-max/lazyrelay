import type { HoldResult, CommitResult, ReleaseResult } from "./ledger.js";
import type { Tier } from "../tier.js";
import { EngineError, type EngineClient } from "./engineClient.js";

/**
 * The competitor teardown orchestrator (10 credits, charged only when a blueprint is delivered):
 *   1. reserve a hold for the teardown, keyed by the client's Idempotency-Key (one key per confirmed click);
 *   2. call the engine (analyze, then blueprint) with a server only token;
 *   3. commit the hold when the blueprint arrived, release it on ANY failure, so a failure never costs credits.
 * A replay of a key never runs the engine again, so it can never charge twice. Legacy accounts skip the hold but still go through the engine.
 */
export interface TeardownDeps {
  ledger: {
    hold(input: { accountId: string; action: "competitor_teardown"; idempotencyKey: string }): Promise<HoldResult>;
    commit(holdId: string): Promise<CommitResult>;
    release(holdId: string): Promise<ReleaseResult>;
  };
  isLegacy(accountId: string): Promise<boolean>;
  engine: EngineClient;
}

export interface TeardownInput {
  accountId: string;
  userId: string;
  tier: Tier;
  idempotencyKey: string;
  input: string;
}

export interface TeardownOutcome {
  status: number;
  body: Record<string, unknown>;
}

const fail = (error: string, extra: Record<string, unknown> = {}) => ({ error, ...extra });

export async function runTeardown(deps: TeardownDeps, req: TeardownInput): Promise<TeardownOutcome> {
  const identity = { userId: req.userId, accountId: req.accountId, tier: req.tier };

  let holdId: string | null = null;
  if (!(await deps.isLegacy(req.accountId))) {
    const hold = await deps.ledger.hold({ accountId: req.accountId, action: "competitor_teardown", idempotencyKey: `teardown:${req.idempotencyKey}` });
    if (!hold.ok) return { status: 402, body: fail("insufficient_credits", { balanceMicro: hold.balanceMicro, requiredMicro: hold.requiredMicro }) };
    if ("exempt" in hold) {
      // The database says this account is exempt: no credits move, the engine still runs.
    } else if (hold.replay) {
      if (hold.status === "committed") return { status: 409, body: fail("already_processed", { message: "This request was already completed and charged. Start a new one to run it again." }) };
      if (hold.status === "held") return { status: 409, body: fail("in_progress", { message: "This request is still running." }) };
      return { status: 409, body: fail("key_already_used", { message: "That attempt did not complete and was not charged. Send a new Idempotency-Key to try again." }) };
    } else {
      holdId = hold.holdId;
    }
  }

  let analysis: unknown;
  let blueprint: unknown;
  try {
    analysis = await deps.engine.analyze(identity, req.input);
    blueprint = await deps.engine.blueprint(identity, req.input);
  } catch (err) {
    console.error("[wallet] teardown failed, releasing the hold:", err);
    if (holdId !== null) {
      try {
        const released = await deps.ledger.release(holdId);
        if (!released.ok) console.error("[wallet] teardown release was refused:", released);
      } catch (releaseErr) {
        // The hold expires on its own (15 minutes); the engine error below is still the answer.
        console.error("[wallet] teardown release failed, the hold will expire by itself:", releaseErr);
      }
    }
    if (err instanceof EngineError) {
      return { status: 502, body: fail("engine_failed", { engineStatus: err.status, engineCode: err.code, message: err.message, charged: false }) };
    }
    throw err;
  }

  let charged = false;
  if (holdId !== null) {
    try {
      const committed = await deps.ledger.commit(holdId);
      if (committed.ok) charged = true;
      else console.error("[wallet] teardown delivered but the hold could not be committed (not charged):", committed);
    } catch (commitErr) {
      console.error("[wallet] teardown delivered but the commit failed (not charged, the hold will expire):", commitErr);
    }
  }
  return { status: 200, body: { analysis, blueprint, charged } };
}
