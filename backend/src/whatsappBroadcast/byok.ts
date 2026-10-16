// "Bring your own key" is permanent and mandatory for WhatsApp broadcasts (Werner). A send happens only when
//   1. the account is on a plan that allows WhatsApp own-keys (the repo's one plan check, checkWhatsappPlan -> resolveTier, so a
//      free, lapsed or too-low plan is refused), AND
//   2. the connection holds the customer's OWN stored login (their system user token, WABA id and phone number id, read from
//      their Vault secret), AND
//   3. the connection is healthy and not paused.
// There is no environment token, no shared token and no fallback: the login comes from the customer's stored bundle or there is
// no send. This file is the only place the broadcast code obtains a login.

import { supabase } from "../supabase.js";
import { checkWhatsappPlan } from "../accountLimits.js";
import { parseWhatsAppBundle, type WhatsAppBundle } from "../platforms/whatsapp/credentials.js";
import { getConnectionPause } from "./controls.js";

export type EligibilityFailure = "plan" | "connection_unavailable" | "connection_paused" | "no_own_credentials";
export type SendEligibility = { ok: true; bundle: WhatsAppBundle } | { ok: false; reason: EligibilityFailure };

interface ConnectionRow {
  id: string;
  credential_mode: string | null;
  byok_status: string | null;
  access_token_vault_id: string | null;
  whatsapp_business_account_id: string | null;
  whatsapp_phone_number_id: string | null;
  paused_at: string | null;
  needs_reconnect_at: string | null;
  disconnected_at: string | null;
  tokens_wiped_at: string | null;
}

export async function checkSendEligibility(accountId: string, socialAccountId: string, opts: { ignorePause?: boolean } = {}): Promise<SendEligibility> {
  // Fails closed: an unreadable plan is "not allowed".
  if ((await checkWhatsappPlan(accountId)) !== null) return { ok: false, reason: "plan" };

  const { data, error } = await supabase
    .from("social_accounts")
    .select("id, credential_mode, byok_status, access_token_vault_id, whatsapp_business_account_id, whatsapp_phone_number_id, paused_at, needs_reconnect_at, disconnected_at, tokens_wiped_at")
    .eq("id", socialAccountId)
    .eq("account_id", accountId)
    .eq("platform", "whatsapp")
    .maybeSingle();
  if (error) throw new Error(`connection lookup failed: ${error.message}`);
  const row = data as ConnectionRow | null;
  if (!row || row.byok_status !== "valid" || row.paused_at || row.needs_reconnect_at || row.disconnected_at || row.tokens_wiped_at) {
    return { ok: false, reason: "connection_unavailable" };
  }
  if (row.credential_mode !== "byok" || !row.access_token_vault_id) return { ok: false, reason: "no_own_credentials" };

  if (!opts.ignorePause && (await getConnectionPause(socialAccountId)).paused) return { ok: false, reason: "connection_paused" };

  const bundle = await readOwnBundle(row.access_token_vault_id);
  // The two ids in the login must be the ones the connection row names, so a mixed-up login can never send from another number.
  if (!bundle || bundle.wabaId !== row.whatsapp_business_account_id || bundle.phoneNumberId !== row.whatsapp_phone_number_id) {
    return { ok: false, reason: "no_own_credentials" };
  }
  return { ok: true, bundle };
}

async function readOwnBundle(vaultId: string): Promise<WhatsAppBundle | null> {
  const { data, error } = await supabase.rpc("read_social_token", { p_vault_id: vaultId });
  if (error) return null;
  return parseWhatsAppBundle(typeof data === "string" ? data : null);
}
