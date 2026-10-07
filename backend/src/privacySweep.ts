// The privacy sweep (decided by Werner 2026-10-07), run from the 6 hourly job in index.ts:
//   1. wipe the stored logins of every disconnected connection (tokenWipe.ts), and
//   2. delete cached comment text and DM snippets that fell outside the tracking window.
// The tracking window is 30 days, the same window the Mentions poller reads (posts scheduled in the last 30 days), so the
// poller never writes back what this deletes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepDisconnectedTokens } from "./tokenWipe.js";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export const MESSAGE_RETENTION_DAYS = 30;

export interface PrivacySweepResult {
  tokensWiped: number;
  tokenFailures: number;
  commentsDeleted: number;
  dmsDeleted: number;
  purgeFailed: boolean;
}

export function retentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - MESSAGE_RETENTION_DAYS * 24 * 3600_000).toISOString();
}

export async function runPrivacySweep(db: Db, now: Date = new Date()): Promise<PrivacySweepResult> {
  const tokens = await sweepDisconnectedTokens(db);

  let commentsDeleted = 0;
  let dmsDeleted = 0;
  let purgeFailed = false;
  const { data, error } = await db.rpc("purge_stored_messages", { p_cutoff: retentionCutoff(now) });
  if (error) {
    purgeFailed = true;
    console.error("[privacySweep] could not delete old comments and DMs:", error.message);
  } else {
    const row = (Array.isArray(data) ? data[0] : data) as { comments_deleted?: number | string; dms_deleted?: number | string } | null;
    commentsDeleted = Number(row?.comments_deleted ?? 0);
    dmsDeleted = Number(row?.dms_deleted ?? 0);
  }

  return { tokensWiped: tokens.wiped, tokenFailures: tokens.failed, commentsDeleted, dmsDeleted, purgeFailed };
}
