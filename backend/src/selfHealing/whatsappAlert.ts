// The one owner digest when a WhatsApp connection is having trouble. Fed one outcome per finished send. Off: does nothing at all.
// Shadow: only records, as a shadow row, that an alert would have gone out (no email, no stored time). On: emails the account owner
// once per 6 hours per connection, the time kept in social_accounts.whatsapp_fault_alert_sent_at (migration 0138, written only here).
// No message is ever sent to a recipient about a failure. The recent outcomes are kept in memory, so a restart starts a fresh count.
// It can never throw into the send loop.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";
import { sendWhatsappFaultDigest } from "../email.js";
import { isInternalTestAccount } from "../internalTestAccounts.js";
import { selfHealingMode } from "./mode.js";
import { recordShadowEvent } from "./shadow.js";
import { assessFaults, cooldownElapsed, pushOutcome, FAULT_ALERT_COOLDOWN_MS, type SendOutcome } from "./whatsappFaults.js";

const windows = new Map<string, SendOutcome[]>();
const shadowAlertedAt = new Map<string, number>();
// When each connection was last told (or found to have been told): saves asking the database on every send while the 6 hours run.
const knownAlertedAt = new Map<string, number>();

/** Forgets every connection's recent outcomes (for tests). */
export function resetWhatsappFaultState(): void {
  windows.clear();
  shadowAlertedAt.clear();
  knownAlertedAt.clear();
}

export async function noteWhatsappOutcome(args: {
  db?: Pick<SupabaseClient, "from">;
  accountId: string;
  socialAccountId: string;
  outcome: SendOutcome;
  now: Date;
}): Promise<void> {
  const mode = selfHealingMode();
  if (mode === "off") return;
  try {
    const window = pushOutcome(windows.get(args.socialAccountId) ?? [], args.outcome);
    windows.set(args.socialAccountId, window);
    const assessment = assessFaults(window);
    if (!assessment.alert) return;
    const nowMs = args.now.getTime();

    if (mode === "shadow") {
      const last = shadowAlertedAt.get(args.socialAccountId);
      if (last !== undefined && nowMs - last < FAULT_ALERT_COOLDOWN_MS) return;
      shadowAlertedAt.set(args.socialAccountId, nowMs);
      recordShadowEvent({ source: "alert", socialAccountId: args.socialAccountId, platform: "whatsapp", legacyAction: "none", newAction: "owner_alert", wouldAlert: true, diverged: true });
      return;
    }

    const known = knownAlertedAt.get(args.socialAccountId);
    if (known !== undefined && nowMs - known < FAULT_ALERT_COOLDOWN_MS) return;
    const db = args.db ?? supabase;
    const { data: row, error } = await db.from("social_accounts").select("whatsapp_fault_alert_sent_at").eq("id", args.socialAccountId).maybeSingle();
    if (error || !row) {
      console.error("[whatsapp-fault-alert] could not read the last alert time", error?.code ?? "no row");
      return;
    }
    const previous = (row as { whatsapp_fault_alert_sent_at: string | null }).whatsapp_fault_alert_sent_at ?? null;
    if (!cooldownElapsed(previous, nowMs)) {
      const t = previous === null ? NaN : new Date(previous).getTime();
      if (Number.isFinite(t)) knownAlertedAt.set(args.socialAccountId, t);
      return;
    }
    // The stored time is taken before the email goes out, and only if nobody else took it first, so one problem is told once.
    const update = db.from("social_accounts").update({ whatsapp_fault_alert_sent_at: args.now.toISOString() }).eq("id", args.socialAccountId);
    const { data: won, error: updateError } = await (previous === null ? update.is("whatsapp_fault_alert_sent_at", null) : update.eq("whatsapp_fault_alert_sent_at", previous)).select("id");
    if (updateError || !won || won.length === 0) return;
    knownAlertedAt.set(args.socialAccountId, nowMs);

    const { data: account } = await db.from("accounts").select("email").eq("id", args.accountId).maybeSingle();
    const email = (account as { email: string | null } | null)?.email ?? null;
    if (!email || isInternalTestAccount(email)) return;
    sendWhatsappFaultDigest(email, { sends: assessment.sends, failed: assessment.failed, recipientLevel: assessment.recipientLevel, accountLevel: assessment.accountLevel });
  } catch {
    console.error("[whatsapp-fault-alert] failed", "threw");
  }
}
