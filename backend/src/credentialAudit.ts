// One audit row per change to a stored platform credential (migration 0135). Called AFTER the change succeeded. It carries ids
// and labels only: never a key, token, hint or request body. A failed insert is logged (code and message, never a secret) and
// never fails the customer's request.

import type { SupabaseClient } from "@supabase/supabase-js";

export type CredentialAuditAction = "saved" | "replaced" | "cleared" | "app_secret_cleared";

export async function recordCredentialAudit(args: {
  supabase: Pick<SupabaseClient, "from">;
  accountId: string;
  socialAccountId: string | null;
  platform: string;
  action: CredentialAuditAction;
  actorUserId: string | null;
  actorRole: string | null;
}): Promise<void> {
  try {
    const { error } = await args.supabase.from("credential_audit_events").insert({
      account_id: args.accountId,
      social_account_id: args.socialAccountId,
      platform: args.platform,
      action: args.action,
      actor_user_id: args.actorUserId,
      actor_role: args.actorRole,
    });
    if (error) console.error("[credential-audit] insert failed", error.code, error.message);
  } catch (err) {
    console.error("[credential-audit] insert failed", undefined, err instanceof Error ? err.message : String(err));
  }
}
