// Test-only helpers for the WhatsApp broadcast modules. Nothing here can reach a real database, Meta or any network: it builds on
// the in-memory supabase stand-in (testFakeSupabase.ts), throwaway keys, and a TypeScript MODEL of the SQL claim function.
//
// The model (claimModel) mirrors claim_whatsapp_broadcast_recipients in migration 0130 so the sender loop can be tested
// end to end. It is a model, not the function: whether the real plpgsql behaves like it is NOT proven until the migration runs
// on a throwaway Supabase branch.

import { randomBytes, randomUUID } from "node:crypto";
import { tables, fakeRpc, vault, type Row } from "../testFakeSupabase.js";
import { contactKeyFor, maskPhone } from "../platforms/whatsapp/contactPrivacy.js";
import { encryptPhone } from "../platforms/whatsapp/phoneVault.js";
import { serializeWhatsAppBundle } from "../platforms/whatsapp/credentials.js";

export const ACC = "acc1";
export const ACC_OTHER = "acc2";
export const SA = "11111111-1111-4111-8111-111111111111";
export const SA_OTHER = "22222222-2222-4222-8222-222222222222";
export const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
export const TOKEN = "EAAFAKEtokenFAKEtokenFAKEtoken0123456789";
export const APP_SECRET = "abcdef0123456789abcdef0123456789";
export const WABA = "1234567890";
export const PHONE_ID = "9876543210";

/** Throwaway secrets for the contact vault and hash. Not secrets: generated fresh per call, never written anywhere. */
export function setTestEnv(): void {
  process.env.WHATSAPP_BYOK_ENABLED = "true";
  process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
  process.env.WHATSAPP_SEND_ENABLED = "true";
  process.env.WHATSAPP_CONTACT_HASH_KEY = "h".repeat(40);
  process.env.WHATSAPP_CONTACT_ENC_KEY = randomBytes(32).toString("base64");
  process.env.WHATSAPP_CONTACT_ENC_KEY_ID = "k1";
}

export function resetTables(): void {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
}

export interface WorldOptions {
  killSwitch?: boolean;
  template?: Partial<Row>;
  withControls?: boolean;
}

/** One account, one WhatsApp connection with a stored login (token + app secret), one approved marketing template and the
 *  global send controls. Returns the ids. */
export function seedWorld(opts: WorldOptions = {}): { vaultId: string } {
  const vaultId = "vault-wa-1";
  vault.set(vaultId, serializeWhatsAppBundle({ systemUserToken: TOKEN, wabaId: WABA, phoneNumberId: PHONE_ID, appSecret: APP_SECRET }));
  tables.accounts = [{ id: ACC, email: "owner@acme.example" }];
  tables.social_accounts = [
    {
      id: SA,
      account_id: ACC,
      platform: "whatsapp",
      credential_mode: "byok",
      byok_status: "valid",
      access_token_vault_id: vaultId,
      whatsapp_business_account_id: WABA,
      whatsapp_phone_number_id: PHONE_ID,
      paused_at: null,
      needs_reconnect_at: null,
      disconnected_at: null,
      tokens_wiped_at: null,
      display_name: "Acme Cafe",
    },
  ];
  tables.whatsapp_message_templates = [
    {
      id: TEMPLATE_ID,
      account_id: ACC,
      social_account_id: SA,
      meta_template_id: "555",
      name: "spring_offer",
      language: "en_US",
      category: "marketing",
      status: "approved",
      body_text: "Hi {{1}}, {{2}} off today",
      variable_count: 2,
      supported: true,
      unsupported_reason: null,
      ...opts.template,
    },
  ];
  tables.whatsapp_send_controls =
    opts.withControls === false
      ? []
      : [{ id: "ctl-global", scope: "global", account_id: null, kill_switch: opts.killSwitch ?? false, max_recipients_per_broadcast: 250, max_broadcasts_per_day: 2, max_messages_per_day: 250 }];
  tables.whatsapp_contacts = [];
  tables.whatsapp_opt_ins = [];
  tables.whatsapp_opt_outs = [];
  tables.whatsapp_broadcasts = [];
  tables.whatsapp_broadcast_recipients = [];
  tables.whatsapp_broadcast_status_events = [];
  tables.whatsapp_connection_send_state = [];
  tables.whatsapp_rate_cards = [];
  tables.whatsapp_conversations = [];
  tables.whatsapp_chat_messages = [];
  tables.whatsapp_approval_requests = [];
  tables.whatsapp_audiences = [];
  tables.whatsapp_audience_members = [];
  tables.plans = [];
  return { vaultId };
}

let contactCounter = 0;
/** A stored contact exactly as Phase 1 stores one: keyed hash, mask, encrypted number. `phone` is a made-up E.164 number. */
export function addContact(phone: string, over: Row = {}): Row {
  contactCounter += 1;
  const digits = phone.replace(/\D/g, "");
  const accountId = (over.account_id as string) ?? ACC;
  const key = contactKeyFor(accountId, digits)!;
  const id = (over.id as string) ?? randomUUID();
  const row: Row = {
    id,
    account_id: accountId,
    social_account_id: SA,
    contact_key: key,
    wa_contact_key: null,
    contact_display: maskPhone(digits),
    phone_ciphertext: encryptPhone(accountId, key, `+${digits}`),
    country_calling_code: digits.startsWith("1") ? "1" : digits.slice(0, 2),
    display_name: null,
    consent_status: "opted_in",
    opted_in_at: "2026-10-01T00:00:00.000Z",
    opted_out_at: null,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, contactCounter)).toISOString(),
    ...over,
  };
  tables.whatsapp_contacts.push(row);
  return row;
}

export function addOptOut(contact: Row, over: Row = {}): Row {
  const row: Row = { id: `oo-${randomUUID()}`, account_id: contact.account_id, contact_key: contact.contact_key, wa_contact_key: null, contact_display: contact.contact_display, scope: "all", source: "keyword", keyword: "STOP", occurred_at: new Date().toISOString(), ...over };
  tables.whatsapp_opt_outs.push(row);
  return row;
}

/** A TypeScript model of claim_whatsapp_broadcast_recipients (migration 0130). See the header. */
/** The database clock, which a test can set so retries and the daily window can be tested without waiting. */
export const clock: { now?: Date } = {};

export function claimModel(args: Record<string, unknown>, now: Date = clock.now ?? new Date()): Row[] {
  const broadcastId = args.p_broadcast_id as string;
  const limit = args.p_limit as number;
  const token = args.p_claim_token as string;
  const b = (tables.whatsapp_broadcasts ?? []).find((x) => x.id === broadcastId && x.status === "sending");
  if (!b) return [];
  const picked = (tables.whatsapp_broadcast_recipients ?? [])
    .filter((r) => r.broadcast_id === broadcastId && r.status === "queued" && (!r.next_attempt_at || String(r.next_attempt_at) <= now.toISOString()))
    .sort((a, z) => String(a.created_at).localeCompare(String(z.created_at)) || String(a.id).localeCompare(String(z.id)))
    .slice(0, limit);
  const out: Row[] = [];
  for (const r of picked) {
    const c = (tables.whatsapp_contacts ?? []).find((x) => x.id === r.contact_id);
    const optedOut =
      !c ||
      c.consent_status !== "opted_in" ||
      (tables.whatsapp_opt_outs ?? []).some(
        (o) =>
          o.account_id === c.account_id &&
          (o.contact_key === c.contact_key || o.wa_contact_key === c.contact_key || (c.wa_contact_key && (o.contact_key === c.wa_contact_key || o.wa_contact_key === c.wa_contact_key))),
      );
    if (optedOut) Object.assign(r, { status: "skipped", skip_reason: "opted_out_at_claim" });
    else if (b.template_category === "marketing" && c.country_calling_code === "1") Object.assign(r, { status: "skipped", skip_reason: "us_marketing_blocked" });
    else if (!c.phone_ciphertext) Object.assign(r, { status: "skipped", skip_reason: "no_number_stored" });
    else {
      Object.assign(r, { status: "claimed", claim_token: token, claimed_at: now.toISOString(), next_attempt_at: null, attempt_count: (r.attempt_count as number) + 1 });
      out.push({ recipient_id: r.id, contact_id: c.id, contact_key: c.contact_key, phone_ciphertext: c.phone_ciphertext, country_calling_code: c.country_calling_code, attempt_count: r.attempt_count });
    }
  }
  return out;
}

export const rpcLog: Array<{ fn: string; args: Record<string, unknown> }> = [];
/** Lets a test change the world at the exact moment after a claim, to model a race (an opt-out landing mid-batch). */
export const hooks: { afterClaim?: () => void } = {};

/** The fake `supabase.rpc`: the in-memory Vault functions plus the claim model. */
export async function fakeRpcAll(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null | { message: string } }> {
  rpcLog.push({ fn, args });
  if (fn === "claim_whatsapp_broadcast_recipients") {
    const data = claimModel(args);
    hooks.afterClaim?.();
    return { data, error: null };
  }
  return fakeRpc(fn, args);
}
