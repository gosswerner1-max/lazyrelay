// System audit rows for connection transitions: a connection going from working to refused (rejected) and back (recovered). They go
// into credential_audit_events (migration 0137) with actor role "system". Only TRANSITIONS are written, and only for auth-class
// refusals: network, DNS, timeout and 5xx errors never reach this module. Ids, the platform name and a fixed reason code only: never
// a key, a token or any message text. Written in shadow and on, not off. It can never throw into the caller.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";
import { selfHealingMode } from "./mode.js";

// This list is the reason_code CHECK in migration 0137 (a test keeps them identical).
export const AUDIT_REASON_CODES = ["invalid_token", "expired", "revoked", "insufficient_permission", "key_rejected", "validation_failed"] as const;
export type AuditReasonCode = (typeof AUDIT_REASON_CODES)[number];
export type SystemAuditAction = "rejected" | "recovered";

/** The closest fixed reason for an auth-class error text. The text is only read here, never stored. */
export function authReasonFromText(text: string): AuditReasonCode {
  if (/permission|scope/i.test(text)) return "insufficient_permission";
  if (/revoked|invalidated/i.test(text)) return "revoked";
  if (/expired/i.test(text)) return "expired";
  return "invalid_token";
}

export async function recordSystemCredentialTransition(args: {
  db?: Pick<SupabaseClient, "rpc">;
  accountId: string;
  socialAccountId: string | null;
  platform: string;
  action: SystemAuditAction;
  reasonCode?: AuditReasonCode | null;
}): Promise<void> {
  if (selfHealingMode() === "off" || !args.socialAccountId) return;
  const reason = args.action === "rejected" && args.reasonCode && AUDIT_REASON_CODES.includes(args.reasonCode) ? args.reasonCode : null;
  try {
    const { error } = await (args.db ?? supabase).rpc("record_system_credential_audit", {
      p_account_id: args.accountId,
      p_social_account_id: args.socialAccountId,
      p_platform: args.platform,
      p_action: args.action,
      p_reason_code: reason,
    });
    if (error) console.error("[credential-audit] system transition failed", error.code ?? "error");
  } catch {
    console.error("[credential-audit] system transition failed", "threw");
  }
}
