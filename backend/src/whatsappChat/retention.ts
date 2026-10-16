// Retention for the WhatsApp broadcast and chat tables (migration 0131), run by the 6 hourly privacy sweep in index.ts.
//   * purge_whatsapp_chat removes every conversation whose last message is older than 30 days (its messages and approvals with it);
//   * purge_whatsapp_broadcast_history removes the per-person delivery rows of finished broadcasts older than 30 days (the broadcast's
//     own totals stay).
// 30 days is the default decision D3 set for the rest of the feature (privacySweep.ts, MESSAGE_RETENTION_DAYS). Erasing a stored
// contact removes their conversation at once; the hash-only opt-out list is never purged.
// Does nothing while the feature is off, so a database without migration 0131 is never asked. A failure is shown (the message only)
// and flagged; it never stops the other purge and never throws into the sweep.

import type { SupabaseClient } from "@supabase/supabase-js";
import { retentionCutoff } from "../privacySweep.js";
import { broadcastsEnabled } from "../whatsappBroadcast/flags.js";

export interface WhatsappRetentionResult {
  chatDeleted: number;
  broadcastRowsDeleted: number;
  failed: boolean;
}

export async function purgeWhatsappHistory(db: Pick<SupabaseClient, "rpc">, now: Date = new Date()): Promise<WhatsappRetentionResult> {
  const result: WhatsappRetentionResult = { chatDeleted: 0, broadcastRowsDeleted: 0, failed: false };
  if (!broadcastsEnabled()) return result;
  const cutoff = retentionCutoff(now);
  for (const [fn, key] of [["purge_whatsapp_chat", "chatDeleted"], ["purge_whatsapp_broadcast_history", "broadcastRowsDeleted"]] as const) {
    const { data, error } = await db.rpc(fn, { p_cutoff: cutoff });
    if (error) {
      result.failed = true;
      console.error(`[privacySweep] ${fn} failed: ${error.message}`);
      continue;
    }
    result[key] = Number(data ?? 0);
  }
  return result;
}
