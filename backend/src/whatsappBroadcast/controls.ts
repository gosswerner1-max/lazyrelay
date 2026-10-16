// DB-backed kill switches and caps (table whatsapp_send_controls, migration 0130) and the per-connection pause
// (whatsapp_connection_send_state). The numbers live in the database, not in code: change the row, not the deploy.
//
// FAIL CLOSED everywhere: no global row, or a global row with a missing or non-positive cap, means NO sending (loadControls
// returns null). A read error is thrown to the caller, which treats it as "do not send".

import { supabase } from "../supabase.js";
import type { PauseReason } from "./metaErrors.js";

export interface EffectiveControls {
  killed: boolean;
  killedBy: "global" | "account" | null;
  maxRecipientsPerBroadcast: number;
  maxBroadcastsPerDay: number;
  maxMessagesPerDay: number;
}

interface ControlRow {
  scope: string;
  account_id: string | null;
  kill_switch: boolean;
  max_recipients_per_broadcast: number | null;
  max_broadcasts_per_day: number | null;
  max_messages_per_day: number | null;
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

export async function loadControls(accountId: string): Promise<EffectiveControls | null> {
  const { data, error } = await supabase
    .from("whatsapp_send_controls")
    .select("scope, account_id, kill_switch, max_recipients_per_broadcast, max_broadcasts_per_day, max_messages_per_day")
    .in("scope", ["global", "account"]);
  if (error) throw new Error(`send controls lookup failed: ${error.message}`);
  const rows = (data ?? []) as ControlRow[];
  const global = rows.find((r) => r.scope === "global");
  if (!global || !positive(global.max_recipients_per_broadcast) || !positive(global.max_broadcasts_per_day) || !positive(global.max_messages_per_day)) return null;
  const own = rows.find((r) => r.scope === "account" && r.account_id === accountId);
  const pick = (mine: number | null | undefined, theirs: number): number => (positive(mine) ? mine : theirs);
  const killedBy = global.kill_switch !== false ? "global" : own && own.kill_switch !== false ? "account" : null;
  return {
    killed: killedBy !== null,
    killedBy,
    maxRecipientsPerBroadcast: pick(own?.max_recipients_per_broadcast, global.max_recipients_per_broadcast),
    maxBroadcastsPerDay: pick(own?.max_broadcasts_per_day, global.max_broadcasts_per_day),
    maxMessagesPerDay: pick(own?.max_messages_per_day, global.max_messages_per_day),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Connection pause
// ---------------------------------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------------------------------
// Usage against the caps
// ---------------------------------------------------------------------------------------------------------------------

/** Messages Meta accepted for this account since `since`: broadcast messages AND chat messages, so one daily cap covers everything the
 *  customer's number sends through LazyRelay. */
export async function countMessagesAcceptedSince(accountId: string, since: Date): Promise<number> {
  const at = since.toISOString();
  const broadcast = await supabase.from("whatsapp_broadcast_recipients").select("id", { count: "exact", head: true }).eq("account_id", accountId).not("handed_off_at", "is", null).gte("handed_off_at", at);
  if (broadcast.error) throw new Error(`usage lookup failed: ${broadcast.error.message}`);
  const chat = await supabase.from("whatsapp_chat_messages").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("direction", "outbound").not("handed_off_at", "is", null).gte("handed_off_at", at);
  if (chat.error) throw new Error(`usage lookup failed: ${chat.error.message}`);
  return (broadcast.count ?? 0) + (chat.count ?? 0);
}

/** Broadcasts this account created since `since`, not counting cancelled ones. */
export async function countBroadcastsSince(accountId: string, since: Date): Promise<number> {
  const { count, error } = await supabase
    .from("whatsapp_broadcasts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .neq("status", "cancelled")
    .gte("created_at", since.toISOString());
  if (error) throw new Error(`usage lookup failed: ${error.message}`);
  return count ?? 0;
}
