// Shadow mode records, for every decision the new policy would have made, what the old logic did and what the new one would have
// done (table self_healing_shadow_events, migration 0136). A row holds ids, the platform and fixed codes: never post content,
// tokens or error text. The write is fire and forget: a failure is logged with a fixed tag and can never reach the scheduler.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";
import type { SelfHealingMode } from "./mode.js";

// These lists are the CHECK lists in migration 0136 (a test keeps them identical).
export const SHADOW_SOURCES = ["post", "breaker", "whatsapp", "alert"] as const;
export const SHADOW_ERROR_CLASSES = ["transient", "rate_limited", "auth", "fatal", "ambiguous", "unknown"] as const;
export const SHADOW_ACTIONS = ["attempt", "retry", "reverify", "fail", "hold_connection", "admit", "deny_probe", "reopen", "owner_alert", "pause_broadcast", "none"] as const;
export const SHADOW_REASON_CODES = ["retries_exhausted", "too_late", "fatal", "auth_rejected", "unknown_error"] as const;

export interface ShadowEvent {
  source: (typeof SHADOW_SOURCES)[number];
  postId?: string | null;
  socialAccountId?: string | null;
  platform: string;
  errorClass?: (typeof SHADOW_ERROR_CLASSES)[number] | null;
  legacyAction: (typeof SHADOW_ACTIONS)[number];
  legacyDelayMs?: number | null;
  newAction: (typeof SHADOW_ACTIONS)[number];
  newDelayMs?: number | null;
  newReasonCode?: (typeof SHADOW_REASON_CODES)[number] | null;
  /** How late the post is (or would be when the retry runs) against its scheduled time. */
  latenessMs?: number | null;
  wouldAlert?: boolean;
  diverged: boolean;
}

/** True when the new policy would have done something different: another action, another reason, or another base delay (the
 *  random jitter alone does not count). */
export function shadowDiverged(a: {
  legacyAction: string;
  legacyDelayMs?: number | null;
  legacyReasonCode?: string | null;
  newAction: string;
  newBaseDelayMs?: number | null;
  newReasonCode?: string | null;
}): boolean {
  if (a.legacyAction !== a.newAction) return true;
  if ((a.legacyReasonCode ?? null) !== (a.newReasonCode ?? null)) return true;
  if (a.legacyDelayMs != null && a.newBaseDelayMs != null && a.legacyDelayMs !== a.newBaseDelayMs) return true;
  return false;
}

/** Writes one row. Resolves in every case: a failure is logged, never thrown. */
export async function writeShadowEvent(db: Pick<SupabaseClient, "from">, event: ShadowEvent, mode: SelfHealingMode = "shadow"): Promise<void> {
  try {
    const { error } = await db.from("self_healing_shadow_events").insert({
      mode,
      source: event.source,
      post_id: event.postId ?? null,
      social_account_id: event.socialAccountId ?? null,
      platform: event.platform,
      error_class: event.errorClass ?? null,
      legacy_action: event.legacyAction,
      legacy_delay_ms: event.legacyDelayMs ?? null,
      new_action: event.newAction,
      new_delay_ms: event.newDelayMs ?? null,
      new_reason_code: event.newReasonCode ?? null,
      lateness_ms: event.latenessMs ?? null,
      would_alert: event.wouldAlert ?? false,
      diverged: event.diverged,
    });
    if (error) console.warn("[self-healing-shadow] insert failed", error.code ?? "error");
  } catch {
    console.warn("[self-healing-shadow] insert failed", "threw");
  }
}

/** Fire and forget, on the service client. The caller never waits for it and never sees a failure. */
export function recordShadowEvent(event: ShadowEvent): void {
  void writeShadowEvent(supabase, event);
}
