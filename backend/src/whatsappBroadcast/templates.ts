// Message templates. A scheduled send is outside WhatsApp's 24 hour customer-service window, so Meta only accepts an APPROVED
// template. The templates belong to the customer's own Meta account: they are read with THEIR token (byok.ts) and copied into
// whatsapp_message_templates (migration 0129), so a broadcast can name one. Only text, language, category and status are kept.
//
// What this version can send: templates whose only variables are in the BODY. A media header, a header variable, a button
// variable or an authentication (one-time code) template is stored as unsupported with a reason and can never be chosen.
// A template that disappears from the customer's Meta account is set to 'disabled' here: fail closed.

import { supabase } from "../supabase.js";
import { listTemplates, type HttpClient, type MetaTemplate } from "./cloudApi.js";
import { checkSendEligibility } from "./byok.js";

export type TemplateStatus = "approved" | "pending" | "rejected" | "paused" | "disabled" | "in_appeal" | "other";
export type TemplateCategory = "marketing" | "utility" | "authentication";

export interface TemplateRow {
  meta_template_id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: TemplateStatus;
  body_text: string;
  variable_count: number;
  supported: boolean;
  unsupported_reason: string | null;
}

const STATUS: Record<string, TemplateStatus> = { APPROVED: "approved", PENDING: "pending", REJECTED: "rejected", PAUSED: "paused", DISABLED: "disabled", IN_APPEAL: "in_appeal" };
const CATEGORY: Record<string, TemplateCategory> = { MARKETING: "marketing", UTILITY: "utility", AUTHENTICATION: "authentication" };
const MAX_BODY_CHARS = 1024;
const MAX_VARIABLES = 20;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasVariable = (text: unknown): boolean => typeof text === "string" && /\{\{/.test(text);

export function countVariables(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return Math.min(max, MAX_VARIABLES);
}

/** One of Meta's templates as a row, or null when its category is not one we model. */
export function normalizeTemplate(t: MetaTemplate): TemplateRow | null {
  const category = CATEGORY[t.category.toUpperCase()];
  if (!category) return null;
  const components = t.components.filter(isRecord);
  const part = (type: string) => components.find((c) => typeof c.type === "string" && c.type.toUpperCase() === type);
  const body = part("BODY");
  const header = part("HEADER");
  const buttons = part("BUTTONS");

  const bodyText = body && typeof body.text === "string" ? body.text.slice(0, MAX_BODY_CHARS) : "";
  let reason: string | null = null;
  if (category === "authentication") reason = "authentication_not_supported";
  else if (!body || bodyText === "") reason = "no_body";
  else if (header && typeof header.format === "string" && header.format.toUpperCase() !== "TEXT") reason = "media_header";
  else if (header && hasVariable(header.text)) reason = "header_variable";
  else if (buttons && Array.isArray(buttons.buttons) && buttons.buttons.some((b) => isRecord(b) && (hasVariable(b.url) || hasVariable(b.text)))) reason = "button_variable";

  return {
    meta_template_id: t.id,
    name: t.name,
    language: t.language,
    category,
    status: STATUS[t.status.toUpperCase()] ?? "other",
    body_text: bodyText,
    variable_count: countVariables(bodyText),
    supported: reason === null,
    unsupported_reason: reason,
  };
}

export type SyncOutcome =
  | { ok: true; synced: number; approved: number; unsupported: number; disabled: number }
  | { ok: false; reason: "plan" | "connection_unavailable" | "no_own_credentials" | "credentials" | "unreachable" | "rejected" };

/** Copies the customer's templates from their own Meta account. Refuses (without calling Meta) unless the account is on a paid
 *  plan and holds its own stored login. A paused connection may still refresh its list. */
export async function syncTemplates(http: HttpClient, accountId: string, socialAccountId: string, now: Date = new Date()): Promise<SyncOutcome> {
  const eligible = await checkSendEligibility(accountId, socialAccountId, { ignorePause: true });
  if (!eligible.ok) return { ok: false, reason: eligible.reason === "connection_paused" ? "connection_unavailable" : eligible.reason };

  const listed = await listTemplates(http, eligible.bundle);
  if (!listed.ok) return { ok: false, reason: listed.reason };

  const at = now.toISOString();
  const rows = listed.templates.flatMap((t) => {
    const n = normalizeTemplate(t);
    return n ? [{ ...n, account_id: accountId, social_account_id: socialAccountId, synced_at: at, updated_at: at }] : [];
  });
  if (rows.length > 0) {
    const { error } = await supabase.from("whatsapp_message_templates").upsert(rows, { onConflict: "social_account_id,name,language" });
    if (error) throw new Error(`template save failed: ${error.message}`);
  }

  // Anything stored that Meta no longer lists is disabled here.
  const { data: stored, error: storedError } = await supabase.from("whatsapp_message_templates").select("id, name, language, status").eq("account_id", accountId).eq("social_account_id", socialAccountId);
  if (storedError) throw new Error(`template lookup failed: ${storedError.message}`);
  const seen = new Set(rows.map((r) => `${r.name}|${r.language}`));
  const gone = ((stored ?? []) as Array<{ id: string; name: string; language: string; status: string }>).filter((s) => !seen.has(`${s.name}|${s.language}`) && s.status !== "disabled");
  if (gone.length > 0) {
    const { error } = await supabase.from("whatsapp_message_templates").update({ status: "disabled", updated_at: at }).in("id", gone.map((g) => g.id));
    if (error) throw new Error(`template disable failed: ${error.message}`);
  }

  return { ok: true, synced: rows.length, approved: rows.filter((r) => r.status === "approved").length, unsupported: rows.filter((r) => !r.supported).length, disabled: gone.length };
}

export interface StoredTemplate {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: TemplateStatus;
  bodyText: string;
  variableCount: number;
  supported: boolean;
  unsupportedReason: string | null;
  /** Approved AND supported: the only templates a broadcast may use. */
  usable: boolean;
  syncedAt: string | null;
}

export const TEMPLATE_COLUMNS = "id, name, language, category, status, body_text, variable_count, supported, unsupported_reason, synced_at";

export function toStoredTemplate(r: Record<string, unknown>): StoredTemplate {
  const status = r.status as TemplateStatus;
  const supported = r.supported === true;
  return {
    id: r.id as string,
    name: r.name as string,
    language: r.language as string,
    category: r.category as TemplateCategory,
    status,
    bodyText: (r.body_text as string) ?? "",
    variableCount: (r.variable_count as number) ?? 0,
    supported,
    unsupportedReason: (r.unsupported_reason as string | null) ?? null,
    usable: status === "approved" && supported,
    syncedAt: (r.synced_at as string | null) ?? null,
  };
}

export async function listStoredTemplates(accountId: string, socialAccountId: string): Promise<StoredTemplate[]> {
  const { data, error } = await supabase.from("whatsapp_message_templates").select(TEMPLATE_COLUMNS).eq("account_id", accountId).eq("social_account_id", socialAccountId).order("name", { ascending: true });
  if (error) throw new Error(`template lookup failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(toStoredTemplate);
}
