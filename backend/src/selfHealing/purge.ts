// Keeps the self-healing tables small: audit rows are kept 13 months, shadow rows 30 days. Runs from the existing 6 hourly job in
// index.ts, only while SELF_HEALING_MODE is shadow or on (off changes nothing, including the audit table). Idempotent. Never throws.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selfHealingMode } from "./mode.js";

export const AUDIT_RETENTION_MONTHS = 13;
export const SHADOW_RETENTION_DAYS = 30;

export function auditCutoff(now: Date): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - AUDIT_RETENTION_MONTHS);
  return d.toISOString();
}

export function shadowCutoff(now: Date): string {
  return new Date(now.getTime() - SHADOW_RETENTION_DAYS * 86_400_000).toISOString();
}

export interface PurgeResult {
  auditDeleted: number;
  shadowDeleted: number;
  failed: boolean;
}

async function purgeTable(db: Pick<SupabaseClient, "from">, table: string, cutoff: string, label: string): Promise<{ deleted: number; failed: boolean }> {
  try {
    const { data, error } = await db.from(table).delete().lt("created_at", cutoff).select("id");
    if (error) {
      console.error(`[self-healing-purge] ${label} purge failed`, error.code ?? "error");
      return { deleted: 0, failed: true };
    }
    return { deleted: (data ?? []).length, failed: false };
  } catch {
    console.error(`[self-healing-purge] ${label} purge failed`, "threw");
    return { deleted: 0, failed: true };
  }
}

export async function purgeSelfHealingHistory(db: Pick<SupabaseClient, "from">, now: Date = new Date()): Promise<PurgeResult> {
  if (selfHealingMode() === "off") return { auditDeleted: 0, shadowDeleted: 0, failed: false };
  const audit = await purgeTable(db, "credential_audit_events", auditCutoff(now), "audit");
  const shadow = await purgeTable(db, "self_healing_shadow_events", shadowCutoff(now), "shadow");
  return { auditDeleted: audit.deleted, shadowDeleted: shadow.deleted, failed: audit.failed || shadow.failed };
}
