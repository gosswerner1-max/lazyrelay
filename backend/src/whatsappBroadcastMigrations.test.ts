// Static checks on migrations 0129 (message templates, rate cards) and 0130 (broadcasts, recipients, delivery status events,
// connection pause state, the atomic claim function). The repo has NO SQL execution harness: these read the files
// as text. They prove the files say the right things (RLS on, grants, guards, no raw numbers, append-only wording); they do NOT
// prove the triggers, policies or the claim function behave correctly in Postgres. That needs a run against a throwaway Supabase
// branch before applying (see docs/whatsapp-phase2-pr-notes.md).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");

function load(prefix: string) {
  const name = fs.readdirSync(dir).find((f) => f.startsWith(prefix));
  const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
  // Strip line comments so a header or ROLLBACK block cannot satisfy or break a check.
  const code = sql.replace(/^\s*--.*$/gm, "");
  const tableBody = (table: string): string => {
    const m = code.match(new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (!m) throw new Error(`table ${table} not found`);
    return m[1];
  };
  const columns = (table: string): string[] =>
    tableBody(table)
      .split("\n")
      .map((l) => l.trim().match(/^([a-z_0-9]+) (uuid|text|timestamptz|boolean|integer|numeric|jsonb|date|bigint)\b/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => m[1]);
  return { name, sql, code, tableBody, columns };
}

const NO_NUMBER_COLUMN = /^(phone|phone_number|number|msisdn|wa_id|recipient_id|e164|to_number|contact_phone|phone_ciphertext)$/;

function commonChecks(m: ReturnType<typeof load>, file: string, tables: string[]) {
  it("exists with the expected name, one transaction, idempotent, with a rollback block, marked not applied", () => {
    expect(m.name).toBe(file);
    expect(m.code).toMatch(/^\s*begin;/m);
    expect(m.code).toMatch(/commit;\s*$/);
    expect(m.sql).toMatch(/-- ROLLBACK/);
    expect(m.sql).toMatch(/NOT applied anywhere/i);
    for (const t of tables) expect(m.code).toContain(`create table if not exists ${t} (`);
  });

  it.each(tables)("%s: RLS on, member select policy, browser roles revoked, service role granted, no write policy", (t) => {
    expect(m.code).toContain(`alter table ${t} enable row level security;`);
    expect(m.code).toContain(`drop policy if exists ${t}_select_members on ${t};`);
    expect(m.code).toMatch(new RegExp(`create policy ${t}_select_members on ${t} for select to authenticated using \\(is_account_member\\(account_id\\)\\);`));
    expect(m.code).toContain(`revoke all on ${t} from public, anon, authenticated;`);
    expect(m.code).toMatch(new RegExp(`grant [a-z, ]+ on ${t} to service_role;`));
    expect(m.code).not.toMatch(new RegExp(`create policy \\w+ on ${t} for (insert|update|delete|all)`));
    expect(m.code).not.toMatch(new RegExp(`grant (all|insert|update|delete)[^;]* on ${t} to (authenticated|anon|public)`));
  });

  it.each(tables)("%s: holds no raw phone number column", (t) => {
    for (const c of m.columns(t)) expect(c).not.toMatch(NO_NUMBER_COLUMN);
  });
}

describe("migration 0129_whatsapp_templates_rate_cards", () => {
  const m = load("0129_");
  commonChecks(m, "0129_whatsapp_templates_rate_cards.sql", ["whatsapp_message_templates", "whatsapp_rate_cards"]);

  it("templates: the columns the sender needs, checks on category and status, one row per connection + name + language", () => {
    const cols = m.columns("whatsapp_message_templates");
    for (const c of ["id", "account_id", "social_account_id", "meta_template_id", "name", "language", "category", "status", "body_text", "variable_count", "supported", "unsupported_reason", "synced_at"]) {
      expect(cols).toContain(c);
    }
    const body = m.tableBody("whatsapp_message_templates");
    expect(body).toMatch(/social_account_id uuid not null references social_accounts\(id\) on delete cascade/);
    expect(body).toMatch(/account_id uuid not null references accounts\(id\) on delete cascade/);
    expect(body).toMatch(/category in \('marketing', 'utility', 'authentication'\)/);
    expect(body).toMatch(/status in \('approved', 'pending', 'rejected', 'paused', 'disabled', 'in_appeal', 'other'\)/);
    expect(body).toMatch(/variable_count between 0 and 20/);
    expect(body).toMatch(/unique \(social_account_id, name, language\)/);
    // a template body is the customer's own marketing copy; it must never be able to hold a long digit run
    expect(body).toMatch(/char_length\(body_text\) <= 1024/);
  });

  it("rate cards: customer-entered prices, never negative, one card per connection, currency code checked", () => {
    const body = m.tableBody("whatsapp_rate_cards");
    for (const c of ["marketing_per_message", "utility_per_message", "authentication_per_message", "currency"]) expect(m.columns("whatsapp_rate_cards")).toContain(c);
    expect(body).toMatch(/marketing_per_message numeric\(12, ?6\) not null/);
    expect(body).toMatch(/marketing_per_message >= 0/);
    expect(body).toMatch(/currency ~ '\^\[A-Z\]\{3\}\$'/);
    expect(body).toMatch(/unique \(social_account_id\)/);
  });
});

describe("migration 0130_whatsapp_broadcasts", () => {
  const m = load("0130_");
  const TABLES = ["whatsapp_connection_send_state", "whatsapp_broadcasts", "whatsapp_broadcast_recipients", "whatsapp_broadcast_status_events"];
  commonChecks(m, "0130_whatsapp_broadcasts.sql", TABLES);

  it("broadcasts: a snapshot of the template, a status list, a schedule, counters, and cascades from the account and the connection", () => {
    const cols = m.columns("whatsapp_broadcasts");
    for (const c of ["id", "account_id", "social_account_id", "template_id", "template_name", "template_language", "template_category", "template_params", "name", "status", "pause_reason", "scheduled_for", "started_at", "completed_at", "cancelled_at", "recipients_materialised_at", "audience_estimate", "count_total", "count_queued", "count_accepted", "count_sent", "count_delivered", "count_read", "count_failed", "count_skipped", "created_by"]) {
      expect(cols).toContain(c);
    }
    const body = m.tableBody("whatsapp_broadcasts");
    expect(body).toMatch(/account_id uuid not null references accounts\(id\) on delete cascade/);
    expect(body).toMatch(/social_account_id uuid not null references social_accounts\(id\) on delete cascade/);
    expect(body).toMatch(/status in \('scheduled', 'sending', 'completed', 'cancelled', 'paused', 'failed'\)/);
    expect(body).toMatch(/template_category in \('marketing', 'utility', 'authentication'\)/);
    expect(body).toMatch(/jsonb_typeof\(template_params\) = 'array'/);
    // the user id is kept as a plain id (no foreign key) so removing a user never edits the record of who scheduled a send
    expect(body).not.toMatch(/created_by uuid[^,]*references/);
  });

  it("recipients: reference the contact by id only, a keyed hash of Meta's message id, a claim token, and one row per contact per broadcast", () => {
    const cols = m.columns("whatsapp_broadcast_recipients");
    for (const c of ["id", "account_id", "broadcast_id", "contact_id", "status", "skip_reason", "message_key", "claim_token", "claimed_at", "attempt_count", "next_attempt_at", "error_code", "failure_reason", "handed_off_at", "sent_at", "delivered_at", "read_at", "failed_at"]) {
      expect(cols).toContain(c);
    }
    const body = m.tableBody("whatsapp_broadcast_recipients");
    expect(body).toMatch(/broadcast_id uuid not null references whatsapp_broadcasts\(id\) on delete cascade/);
    // erasing a contact removes its recipient rows: the delivery history never outlives the contact
    expect(body).toMatch(/contact_id uuid not null references whatsapp_contacts\(id\) on delete cascade/);
    expect(body).toMatch(/status in \('queued', 'claimed', 'handed_off', 'sent', 'delivered', 'read', 'failed', 'skipped'\)/);
    expect(body).toMatch(/message_key ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(body).toMatch(/attempt_count between 0 and 10/);
    expect(body).toMatch(/unique \(broadcast_id, contact_id\)/);
  });

  it("recipients: an index for the claim query and one for finding a recipient from a delivery receipt", () => {
    expect(m.code).toMatch(/create index if not exists \w+ on whatsapp_broadcast_recipients \(broadcast_id, status, next_attempt_at\)/);
    expect(m.code).toMatch(/create (unique )?index if not exists \w+ on whatsapp_broadcast_recipients \(account_id, message_key\) where message_key is not null/);
  });

  it("status events: append-only (update, delete and truncate refused), idempotent by event key, no number anywhere", () => {
    const cols = m.columns("whatsapp_broadcast_status_events");
    for (const c of ["id", "account_id", "social_account_id", "broadcast_recipient_id", "event_key", "status", "event_at", "error_code", "pricing_category", "billable"]) expect(cols).toContain(c);
    const body = m.tableBody("whatsapp_broadcast_status_events");
    expect(body).toMatch(/event_key ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(body).toMatch(/unique \(event_key\)/);
    expect(body).toMatch(/status in \('sent', 'delivered', 'read', 'failed'\)/);
    expect(m.code).toMatch(/grant select, insert on whatsapp_broadcast_status_events to service_role;/);
    expect(m.code).toMatch(/create trigger whatsapp_broadcast_status_events_append_only\s+before update or delete on whatsapp_broadcast_status_events/);
    expect(m.code).toMatch(/create trigger whatsapp_broadcast_status_events_no_truncate\s+before truncate on whatsapp_broadcast_status_events/);
    expect(m.code).toMatch(/errcode = 'LRWB1'/);
    // the one allowed delete is the cascade from the parent recipient
    expect(m.code).toMatch(/from whatsapp_broadcast_recipients \w+ where \w+\.id = old\.broadcast_recipient_id/);
  });

  it("connection pause state: why a connection was paused, no retry into a restriction", () => {
    const body = m.tableBody("whatsapp_connection_send_state");
    expect(body).toMatch(/social_account_id uuid primary key references social_accounts\(id\) on delete cascade/);
    expect(body).toMatch(/pause_reason in \('quality', 'restricted', 'credentials', 'template', 'policy'\)/);
    expect(m.columns("whatsapp_connection_send_state")).toEqual(expect.arrayContaining(["paused_at", "pause_reason", "meta_error_code", "resumed_at"]));
  });

  it("claim function: atomic claim and opt-out check in ONE statement, skip-locked, security definer, callable by the service role only", () => {
    const fn = m.code.match(/create or replace function claim_whatsapp_broadcast_recipients\([\s\S]*?\n\$\$;/);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = public, pg_temp/);
    expect(body).toMatch(/for update of r skip locked/);
    // the consent / opt-out decision is made against the live contact and opt-out rows inside the same function
    expect(body).toMatch(/from whatsapp_contacts/);
    expect(body).toMatch(/from whatsapp_opt_outs/);
    expect(body).toMatch(/consent_status <> 'opted_in'/);
    expect(body).toMatch(/b\.status = 'sending'/);
    expect(body).toMatch(/attempt_count = r\.attempt_count \+ 1/);
    // a US (+1) number is never sent a marketing template
    expect(body).toMatch(/country_calling_code = '1'/);
    expect(body).toMatch(/'marketing'/);
    expect(m.code).toContain("revoke execute on function claim_whatsapp_broadcast_recipients(uuid, integer, uuid) from public, anon, authenticated;");
    expect(m.code).toContain("grant execute on function claim_whatsapp_broadcast_recipients(uuid, integer, uuid) to service_role;");
  });
});
