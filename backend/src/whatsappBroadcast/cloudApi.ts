// The WhatsApp Cloud API calls a broadcast needs, made with the CUSTOMER'S OWN stored token (the login bundle from
// platforms/whatsapp/credentials.ts, read from Vault by the caller). LazyRelay has no WhatsApp token of its own.
//
//   sendTemplate    POST /{phone-number-id}/messages with an approved template (the only thing Meta accepts outside the 24 hour
//                   customer-service window, which every scheduled send is)
//   listTemplates   GET /{waba-id}/message_templates, to copy the customer's templates into whatsapp_message_templates
//
// The HTTP client is INJECTED. Tests pass a fake, so no test can reach Meta; production passes fetchHttpClient below. The token
// goes in the Authorization header only: never a URL, a body, a log line, an error or a return value. Meta's error TEXT is never
// returned (it can echo the recipient's number); only its numeric code and the HTTP status are. A request that got no usable
// answer is reported as noResponse so the sender never retries it blindly (the message may already have gone out).

import { WHATSAPP_GRAPH_BASE } from "../platforms/whatsapp/adapter.js";
import type { WhatsAppBundle } from "../platforms/whatsapp/credentials.js";

export interface HttpRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResult {
  status: number;
  json: unknown;
}
export type HttpClient = (url: string, init: HttpRequest) => Promise<HttpResult>;

const REQUEST_TIMEOUT_MS = 10_000;
const GRAPH_PREFIX = "https://graph.facebook.com/";

/** The production client: only Meta's Graph API host, never follows a redirect, always has a timeout. */
export const fetchHttpClient: HttpClient = async (url, init) => {
  if (!url.startsWith(GRAPH_PREFIX)) throw new Error("Refusing a request to a host that is not the Graph API.");
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DIGITS = /^[0-9]{8,15}$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const WAMID = /^wamid\.[A-Za-z0-9._=+/-]{3,300}$/;
const CURSOR = /^[A-Za-z0-9_=+/-]{1,200}$/;
export const MAX_TEMPLATE_PARAM_CHARS = 1024;
const MAX_TEMPLATE_PAGES = 10;

/** Meta rejects a template variable with a newline, a tab or a long run of spaces. Also capped in length. */
export function sanitizeTemplateParam(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, MAX_TEMPLATE_PARAM_CHARS);
}

export interface SendTemplateRequest {
  /** The recipient's number as digits only, country code first (no plus sign). */
  toDigits: string;
  templateName: string;
  language: string;
  /** Body variables in order. Empty for a template without variables. */
  params: string[];
}

export type SendOutcome =
  | { ok: true; wamid: string }
  | { ok: false; httpStatus: number; code: number | null }
  | { ok: false; noResponse: true };

function errorCodeOf(json: unknown): number | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  return typeof json.error.code === "number" ? json.error.code : null;
}

/** Sends one approved template message. Throws only for a request that is malformed on OUR side (checked before anything is
 *  sent); everything Meta or the network does comes back as a value. */
export async function sendTemplate(http: HttpClient, bundle: WhatsAppBundle, req: SendTemplateRequest): Promise<SendOutcome> {
  if (!DIGITS.test(req.toDigits)) throw new Error("Refusing to send: the recipient is not a plain number with its country code.");
  if (!TEMPLATE_NAME.test(req.templateName) || !TEMPLATE_LANGUAGE.test(req.language)) throw new Error("Refusing to send: the template name or language is not in Meta's format.");

  const template: Record<string, unknown> = { name: req.templateName, language: { code: req.language } };
  if (req.params.length > 0) {
    template.components = [{ type: "body", parameters: req.params.map((p) => ({ type: "text", text: sanitizeTemplateParam(p) })) }];
  }
  const body = JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: req.toDigits, type: "template", template });

  let res: HttpResult;
  try {
    res = await http(`${WHATSAPP_GRAPH_BASE}/${bundle.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bundle.systemUserToken}`, "Content-Type": "application/json" },
      body,
    });
  } catch {
    return { ok: false, noResponse: true };
  }
  if (res.status >= 200 && res.status < 300) {
    const first = isRecord(res.json) && Array.isArray(res.json.messages) ? res.json.messages[0] : null;
    const id = isRecord(first) && typeof first.id === "string" ? first.id : null;
    return id && WAMID.test(id) ? { ok: true, wamid: id } : { ok: false, noResponse: true };
  }
  return { ok: false, httpStatus: res.status, code: errorCodeOf(res.json) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Template list
// ---------------------------------------------------------------------------------------------------------------------

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  /** Meta's value, e.g. APPROVED, PENDING, REJECTED. */
  status: string;
  /** Meta's value, e.g. MARKETING, UTILITY, AUTHENTICATION. */
  category: string;
  components: unknown[];
}

export type ListTemplatesOutcome = { ok: true; templates: MetaTemplate[] } | { ok: false; reason: "credentials" | "unreachable" | "rejected" };

function readTemplate(raw: unknown): MetaTemplate | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : typeof raw.id === "number" ? String(raw.id) : null;
  if (!id || !/^[0-9]{1,30}$/.test(id)) return null;
  if (typeof raw.name !== "string" || !TEMPLATE_NAME.test(raw.name)) return null;
  if (typeof raw.language !== "string" || !TEMPLATE_LANGUAGE.test(raw.language)) return null;
  if (typeof raw.status !== "string" || typeof raw.category !== "string") return null;
  return { id, name: raw.name, language: raw.language, status: raw.status, category: raw.category, components: Array.isArray(raw.components) ? raw.components : [] };
}

/** Reads the templates of the customer's own WhatsApp Business Account. Follows Meta's paging CURSOR only (never a returned
 *  "next" link, so a hostile answer cannot send the token to another host), at most 10 pages. */
export async function listTemplates(http: HttpClient, bundle: WhatsAppBundle): Promise<ListTemplatesOutcome> {
  const templates: MetaTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
    const query = new URLSearchParams({ fields: "id,name,language,status,category,components", limit: "100" });
    if (after) query.set("after", after);
    let res: HttpResult;
    try {
      res = await http(`${WHATSAPP_GRAPH_BASE}/${bundle.wabaId}/message_templates?${query.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${bundle.systemUserToken}` },
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (res.status < 200 || res.status >= 300) {
      const code = errorCodeOf(res.json);
      if (res.status === 401 || res.status === 403 || code === 190 || code === 10 || (code !== null && code >= 200 && code <= 299)) return { ok: false, reason: "credentials" };
      return { ok: false, reason: res.status >= 500 ? "unreachable" : "rejected" };
    }
    const json = res.json;
    if (isRecord(json) && Array.isArray(json.data)) {
      for (const raw of json.data) {
        const t = readTemplate(raw);
        if (t) templates.push(t);
      }
    }
    // Meta puts cursors on the last page too; the presence of "next" is what says there is another page. Only the cursor is used.
    const paging = isRecord(json) && isRecord(json.paging) ? json.paging : null;
    const hasNext = !!paging && typeof paging.next === "string";
    const cursor = hasNext && isRecord(paging.cursors) ? paging.cursors.after : null;
    if (typeof cursor !== "string" || !CURSOR.test(cursor)) break;
    after = cursor;
  }
  return { ok: true, templates };
}
