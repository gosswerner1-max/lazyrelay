// Static checks on migration 0131_whatsapp_chat.sql (two-way WhatsApp: conversations, chat messages encrypted at rest, approval
// requests, saved audiences, and the 30 day retention functions). The repo has NO SQL execution harness: these read the file as
// text. They prove the file says the right things (RLS on, column-level grants that hide every ciphertext, no plain number or
// message body, retention functions callable only by the service role); they do NOT prove the policies, grants or functions
// behave correctly in Postgres. That needs a run against a throwaway Supabase branch before applying.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0131_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
const code = sql.replace(/^\s*--.*$/gm, "");
const TABLES = ["whatsapp_conversations", "whatsapp_chat_messages", "whatsapp_approval_requests", "whatsapp_audiences", "whatsapp_audience_members"];
/** Columns that hold encrypted values: never selectable by the browser-facing roles. */
const CIPHERTEXT: Record<string, string | null> = {
  whatsapp_conversations: "phone_ciphertext",
  whatsapp_chat_messages: "body_ciphertext",
  whatsapp_approval_requests: "title_ciphertext",
  whatsapp_audiences: null,
  whatsapp_audience_members: null,
};

function tableBody(table: string): string {
  const m = code.match(new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error(`table ${table} not found`);
  return m[1];
}
const columns = (table: string): string[] =>
  tableBody(table)
    .split("\n")
    .map((l) => l.trim().match(/^([a-z_0-9]+) (uuid|text|timestamptz|boolean|integer|jsonb)\b/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1]);

describe("migration 0131_whatsapp_chat", () => {
  it("exists with the expected name, one transaction, idempotent, with a rollback block, marked not applied", () => {
    expect(name).toBe("0131_whatsapp_chat.sql");
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/commit;\s*$/);
    expect(sql).toMatch(/-- ROLLBACK/);
    expect(sql).toMatch(/NOT applied anywhere/i);
    for (const t of TABLES) expect(code).toContain(`create table if not exists ${t} (`);
  });

  it.each(TABLES)("%s: RLS on, member select policy, browser roles revoked, service role granted, no write policy", (t) => {
    expect(code).toContain(`alter table ${t} enable row level security;`);
    expect(code).toMatch(new RegExp(`create policy ${t}_select_members on ${t} for select to authenticated using \\(is_account_member\\(account_id\\)\\);`));
    expect(code).toContain(`revoke all on ${t} from public, anon, authenticated;`);
    expect(code).toMatch(new RegExp(`grant [a-z, ]+ on ${t} to service_role;`));
    expect(code).not.toMatch(new RegExp(`create policy \\w+ on ${t} for (insert|update|delete|all)`));
    expect(code).not.toMatch(new RegExp(`grant (all|insert|update|delete)[^;]* on ${t} to (authenticated|anon|public)`));
  });

  it.each(TABLES)("%s: browser roles get a column-level select that never includes a ciphertext column", (t) => {
    const cipher = CIPHERTEXT[t];
    const defined = columns(t);
    if (cipher) {
      expect(defined).toContain(cipher);
      const grant = code.match(new RegExp(`grant select \\(([^)]*)\\) on ${t} to authenticated;`));
      expect(grant).not.toBeNull();
      const granted = grant![1].split(",").map((c) => c.trim()).filter(Boolean);
      expect(granted).not.toContain(cipher);
      expect(granted.sort()).toEqual(defined.filter((c) => c !== cipher).sort());
      expect(code).not.toMatch(new RegExp(`grant select on ${t} to authenticated`));
    } else {
      expect(code).toMatch(new RegExp(`grant select on ${t} to authenticated;`));
    }
  });

  it("no plain phone number or message body column anywhere", () => {
    for (const t of TABLES) {
      for (const c of columns(t)) {
        expect(c).not.toMatch(/^(phone|phone_number|number|msisdn|wa_id|e164|body|text|message_text|content|title)$/);
      }
    }
  });

  it("conversations: keyed hash, mask, an encrypted number, the window anchor, one conversation per connection and contact", () => {
    const body = tableBody("whatsapp_conversations");
    for (const c of ["contact_key", "contact_display", "contact_id", "phone_ciphertext", "last_inbound_at", "last_message_at", "unread_count"]) expect(columns("whatsapp_conversations")).toContain(c);
    expect(body).toMatch(/contact_key ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(body).toMatch(/contact_display !~ '\[0-9\]\{7\}'/);
    expect(body).toMatch(/phone_ciphertext text not null/);
    expect(body).toMatch(/phone_ciphertext ~ '\^v1/);
    // erasing a stored contact removes its conversation, so no message outlives the person
    expect(body).toMatch(/contact_id uuid references whatsapp_contacts\(id\) on delete cascade/);
    expect(body).toMatch(/social_account_id uuid not null references social_accounts\(id\) on delete cascade/);
    expect(body).toMatch(/unique \(social_account_id, contact_key\)/);
  });

  it("chat messages: encrypted body, keyed hash of Meta's message id, direction/kind/status checks, idempotent on the message id", () => {
    const body = tableBody("whatsapp_chat_messages");
    for (const c of ["conversation_id", "direction", "kind", "body_ciphertext", "message_key", "status", "reply_to_message_key", "template_name", "sent_by", "occurred_at", "delivered_at", "read_at"]) expect(columns("whatsapp_chat_messages")).toContain(c);
    expect(body).toMatch(/conversation_id uuid not null references whatsapp_conversations\(id\) on delete cascade/);
    expect(body).toMatch(/direction in \('inbound', 'outbound'\)/);
    expect(body).toMatch(/kind in \('text', 'interactive_buttons', 'interactive_list', 'template', 'button_reply', 'list_reply', 'unsupported'\)/);
    expect(body).toMatch(/status in \('received', 'handed_off', 'sent', 'delivered', 'read', 'failed'\)/);
    expect(body).toMatch(/message_key ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(body).toMatch(/body_ciphertext ~ '\^v1/);
    expect(code).toMatch(/create unique index if not exists \w+ on whatsapp_chat_messages \(account_id, message_key\) where message_key is not null/);
  });

  it("approvals: a convenience record only, at most 3 options, a status list, the client's button id and title, an encrypted title", () => {
    const body = tableBody("whatsapp_approval_requests");
    for (const c of ["conversation_id", "message_id", "title_ciphertext", "options", "status", "response_option_id", "response_title", "responded_at"]) expect(columns("whatsapp_approval_requests")).toContain(c);
    expect(body).toMatch(/message_id uuid not null references whatsapp_chat_messages\(id\) on delete cascade/);
    expect(body).toMatch(/status in \('pending', 'approved', 'changes_requested', 'question', 'other_reply'\)/);
    expect(body).toMatch(/jsonb_typeof\(options\) = 'array'/);
    expect(body).toMatch(/jsonb_array_length\(options\) between 1 and 3/);
    expect(sql).toMatch(/not legal consent/i);
  });

  it("audiences: a saved list of contacts by id, removed with the contact", () => {
    expect(tableBody("whatsapp_audience_members")).toMatch(/contact_id uuid not null references whatsapp_contacts\(id\) on delete cascade/);
    expect(tableBody("whatsapp_audience_members")).toMatch(/primary key \(audience_id, contact_id\)/);
    expect(tableBody("whatsapp_audiences")).toMatch(/unique \(social_account_id, name\)/);
  });

  it("retention: 30 day purge functions (chat and broadcast history), service role only", () => {
    for (const fn of ["purge_whatsapp_chat", "purge_whatsapp_broadcast_history"]) {
      expect(code).toMatch(new RegExp(`create or replace function ${fn}\\(p_cutoff timestamptz\\)`));
      expect(code).toContain(`revoke execute on function ${fn}(timestamptz) from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function ${fn}(timestamptz) to service_role;`);
    }
    expect(code).toMatch(/delete from whatsapp_conversations where last_message_at < p_cutoff/);
    expect(sql).toMatch(/30 days/);
  });
});
