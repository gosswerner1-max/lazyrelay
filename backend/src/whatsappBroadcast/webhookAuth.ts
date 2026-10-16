// What the broadcast and chat webhook handlers share: finding the connection a delivery belongs to, and checking its signature.
// EVERY customer brings their own Meta app, so a delivery is verified over the RAW body with THAT connection's own app secret
// (X-Hub-Signature-256), read from their Vault entry, in constant time. No saved secret, or a signature that does not match:
// nothing is stored. The two Meta ids (WABA id and phone number id) only route; the signature is the gate.

import { createHmac, timingSafeEqual } from "node:crypto";
import { supabase } from "../supabase.js";
import { recordSecurityEvent } from "../http/securityAlerts.js";
import { parseWhatsAppBundle } from "../platforms/whatsapp/credentials.js";

export interface ConnectionRow {
  id: string;
  account_id: string;
  access_token_vault_id: string | null;
}

function safeEqual(a: string, b: string): boolean {
  return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signatureMatches(rawBody: Buffer, header: string, appSecret: string): boolean {
  return safeEqual(header, "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex"));
}

export async function loadAppSecret(vaultId: string | null): Promise<string | null> {
  if (!vaultId) return null;
  const { data, error } = await supabase.rpc("read_social_token", { p_vault_id: vaultId });
  if (error) return null;
  return parseWhatsAppBundle(typeof data === "string" ? data : null)?.appSecret ?? null;
}

const COLUMNS = "id, account_id, access_token_vault_id";

/** Connected, not wiped WhatsApp rows for a business account (and a phone number id when given). */
export async function connectionsFor(wabaId: string, phoneNumberId: string | null): Promise<ConnectionRow[]> {
  let q = supabase.from("social_accounts").select(COLUMNS).eq("platform", "whatsapp").eq("whatsapp_business_account_id", wabaId).is("disconnected_at", null).is("tokens_wiped_at", null);
  if (phoneNumberId) q = q.eq("whatsapp_phone_number_id", phoneNumberId);
  const { data, error } = await q;
  if (error) throw new Error("account lookup failed");
  return (data ?? []) as ConnectionRow[];
}

/** One verifier per delivery: checks each connection once. "blocked" = no saved app secret, false = bad signature (counted as a
 *  security event, one event never alerts), true = genuine. */
export function makeVerifier(rawBody: Buffer, signatureHeader: string): (c: ConnectionRow) => Promise<boolean | "blocked"> {
  const verified = new Map<string, boolean>();
  return async (c) => {
    if (verified.has(c.id)) return verified.get(c.id)!;
    const secret = await loadAppSecret(c.access_token_vault_id);
    if (!secret) return "blocked";
    const good = signatureMatches(rawBody, signatureHeader, secret);
    if (!good) recordSecurityEvent("whatsapp_bad_signature", "WhatsApp webhook delivery failed signature verification");
    verified.set(c.id, good);
    return good;
  };
}
