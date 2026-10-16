// The per-connection PAUSE (table whatsapp_connection_send_state, migration 0130). It is set only when META reports a problem with the
// customer's own number: a restriction, a quality limit, a rejected credential or a policy block (metaErrors.ts, statusWebhook.ts).
// While paused nothing is sent from that number, so a retry storm cannot deepen a flag on the customer's own account. It is not a
// LazyRelay limit and not a kill switch: the customer lifts it themselves (resumeConnection) once the problem is fixed in Meta
// Business Manager.
//
// There is no volume cap, no per-day limit and no kill switch anywhere in the WhatsApp code: customers pay Meta directly with their own
// tokens, and the only restrictions are the plan gate, the rollout env flags and what Meta itself requires.

import { supabase } from "../supabase.js";
import type { PauseReason } from "./metaErrors.js";

export type ConnectionPause = { paused: false } | { paused: true; reason: PauseReason };

export async function getConnectionPause(socialAccountId: string): Promise<ConnectionPause> {
  const { data, error } = await supabase.from("whatsapp_connection_send_state").select("paused_at, pause_reason").eq("social_account_id", socialAccountId).maybeSingle();
  if (error) throw new Error(`pause lookup failed: ${error.message}`);
  const row = data as { paused_at: string | null; pause_reason: PauseReason | null } | null;
  // A row that says paused without a reason is still paused (fail closed).
  return row?.paused_at ? { paused: true, reason: row.pause_reason ?? "policy" } : { paused: false };
}

/** Pauses a connection. Stores Meta's numeric code only. Idempotent; the latest reason wins. */
export async function pauseConnection(accountId: string, socialAccountId: string, reason: PauseReason, metaCode: number | null, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  const { error } = await supabase
    .from("whatsapp_connection_send_state")
    .upsert({ social_account_id: socialAccountId, account_id: accountId, paused_at: at, pause_reason: reason, meta_error_code: metaCode, updated_at: at }, { onConflict: "social_account_id" });
  if (error) throw new Error(`pause failed: ${error.message}`);
}

/** Clears a pause. False when the connection is not this account's or was not paused. */
export async function resumeConnection(accountId: string, socialAccountId: string, now: Date = new Date()): Promise<boolean> {
  const at = now.toISOString();
  const { data, error } = await supabase
    .from("whatsapp_connection_send_state")
    .update({ paused_at: null, pause_reason: null, resumed_at: at, updated_at: at })
    .eq("social_account_id", socialAccountId)
    .eq("account_id", accountId)
    .not("paused_at", "is", null)
    .select("social_account_id");
  if (error) throw new Error(`resume failed: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}
