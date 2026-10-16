// WhatsApp broadcast contacts and consent, Phase 1 (table whatsapp_contacts / whatsapp_opt_ins / whatsapp_opt_outs, migration
// 0128). Contacts and consent only: nothing here sends a message or talks to Meta.
//
//   GET    /whatsapp/capabilities          { broadcasts: boolean } so the dashboard knows whether to show the WhatsApp tab
//   GET    /whatsapp/contacts              the account's contacts (masked, newest first)
//   POST   /whatsapp/contacts              add one contact with its consent record
//   POST   /whatsapp/contacts/import       add many (the browser parsed the CSV); dryRun supported
//   POST   /whatsapp/contacts/:id/opt-out  manual opt-out
//   DELETE /whatsapp/contacts/:id          erase the contact (the hash-only opt-out list is kept)
//   GET    /whatsapp/opt-outs              count and a masked list
//
// Gate, in this order, on every route but capabilities (which answers false instead of 404): WHATSAPP_BYOK_ENABLED=true, else 404;
// WHATSAPP_BROADCASTS_ENABLED=true, else 404; canSeePlatform("whatsapp") for the account, else 404; then, for writes, signed-in
// HUMAN only (an API key is refused; the MCP and Zapier have no route here); then the plan (any paid plan), else 400.
//
// Reads go through req.db (the caller's own database role, so row level security applies) plus an explicit account_id filter,
// with an explicit column list that never names phone_ciphertext. Writes use the service-role client in whatsappContacts.ts.
// A phone number is never returned, never put in a URL we log, never logged. Search matches the mask or the name only, and a
// search that looks like a phone number is refused.

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { supabase } from "../../supabase.js";
import { checkWhatsappPlan } from "../../accountLimits.js";
import { WHATSAPP_BYOK_REQUIRED_PLAN_NAME } from "../../tier.js";
import { canSeePlatform } from "./socialAccounts.routes.js";
import { dbError } from "./shared.js";
import {
  ATTESTATION_VERSION,
  ContactStorageNotConfiguredError,
  MAX_IMPORT_ROWS,
  OPT_IN_SOURCES,
  addContacts,
  contactStorageReady,
  eraseContact,
  isAffirmative,
  optOutContact,
  parseConsentDate,
  type AddContactItem,
  type AddResult,
  type OptInEvidence,
} from "../../whatsappContacts.js";
import { randomUUID } from "node:crypto";

/** What a customer may read of a contact. Never the encrypted number. */
export const WHATSAPP_CONTACT_COLUMNS = "id, social_account_id, contact_key, contact_display, display_name, country_calling_code, consent_status, opted_in_at, opted_out_at, created_at";
const OPT_OUT_COLUMNS = "id, contact_display, scope, source, keyword, occurred_at";

const STORAGE_NOT_READY = "Contact storage is not set up yet.";
const UUID = z.string().uuid();
const REJECT_MESSAGES: Record<string, string> = {
  name_invalid: "That name is too long or looks like a phone number.",
  opt_in_date_in_future: "The consent date cannot be in the future.",
};

/** Max 2 MB (5,000 rows), with an error handler that answers a fixed line: body-parser's own error carries the raw body, which
 *  here is a list of phone numbers. Mounted in app.ts BEFORE the global JSON parser. */
export const whatsappContactsImportJsonParser = [
  express.json({ limit: "2mb" }),
  (_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: "That import could not be read. Keep the file under 2 MB and 5,000 rows." });
  },
];

function flagGate(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (process.env.WHATSAPP_BYOK_ENABLED !== "true" || process.env.WHATSAPP_BROADCASTS_ENABLED !== "true" || !canSeePlatform("whatsapp", req.accountId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

async function planGate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const planError = await checkWhatsappPlan(req.accountId!);
  if (planError) {
    res.status(400).json({ error: planError, requiresPlan: WHATSAPP_BYOK_REQUIRED_PLAN_NAME });
    return;
  }
  next();
}

/** The user id inside the already verified sign-in token, for the consent record's recorded_by. Null when not readable. */
function userIdFromToken(token: string | undefined): string | null {
  try {
    const sub = (JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown }).sub;
    return typeof sub === "string" && UUID.safeParse(sub).success ? sub : null;
  } catch {
    return null;
  }
}

async function ownsConnection(accountId: string, socialAccountId: string): Promise<boolean> {
  const { data, error } = await supabase.from("social_accounts").select("id").eq("id", socialAccountId).eq("account_id", accountId).eq("platform", "whatsapp").maybeSingle();
  if (error) throw new Error(`connection lookup failed: ${error.message}`);
  return !!data;
}

const optInSchema = z.object({
  source: z.enum(OPT_IN_SOURCES),
  capturedAt: z.string().min(1).max(40),
  consentText: z.string().trim().min(1).max(1000),
  proofReference: z.string().trim().max(500).nullish(),
  attested: z.literal(true),
});
const addSchema = z.object({
  social_account_id: UUID,
  phone: z.string().max(40),
  name: z.string().max(200).nullish(),
  optIn: optInSchema,
});
const importSchema = z.object({
  social_account_id: UUID,
  source: z.enum(OPT_IN_SOURCES),
  consentText: z.string().trim().min(1).max(1000),
  proofReference: z.string().trim().max(500).nullish(),
  capturedAt: z.string().min(1).max(40),
  attested: z.literal(true),
  dryRun: z.boolean().optional(),
  rows: z.array(z.unknown()).min(1).max(MAX_IMPORT_ROWS),
});
const listSchema = z.object({
  social_account_id: UUID.optional(),
  status: z.enum(["opted_in", "opted_out"]).optional(),
  search: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.join(".") || "request"}: ${issue.message}`;
}

/** The consent date the customer states: a date or ISO time that is not in the future. */
function consentDate(value: string): Date | null {
  const date = parseConsentDate(value);
  return date && date.getTime() <= Date.now() ? date : null;
}

function handle(res: Response, e: unknown, context: string): void {
  if (e instanceof ContactStorageNotConfiguredError) {
    res.status(503).json({ error: STORAGE_NOT_READY });
    return;
  }
  dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, context);
}

export function buildWhatsAppContactsRouter(): Router {
  const router = express.Router();
  const read = [requireAuth, tieredRateLimit, flagGate, planGate];
  const write = [requireAuth, tieredRateLimit, flagGate, requireHumanAuth, planGate];

  // Booleans only. True when every gate passes AND the two secrets exist, so the tab never shows for a feature that cannot work.
  router.get("/whatsapp/capabilities", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const on =
      process.env.WHATSAPP_BYOK_ENABLED === "true" &&
      process.env.WHATSAPP_BROADCASTS_ENABLED === "true" &&
      canSeePlatform("whatsapp", req.accountId) &&
      contactStorageReady() &&
      (await checkWhatsappPlan(req.accountId!)) === null;
    res.json({ broadcasts: on });
  });

  router.get("/whatsapp/contacts", ...read, async (req: AuthedRequest, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "social_account_id must be a connection id; status opted_in or opted_out; search up to 40 characters; limit 1 to 100; before an ISO time" });
      return;
    }
    const { social_account_id, status, search, limit, before } = parsed.data;
    const term = (search ?? "").trim();
    if (term.replace(/\D/g, "").length >= 7) {
      res.status(400).json({ error: "Search by name or by the last digits shown, not by a full phone number." });
      return;
    }
    let query = req.db!.from("whatsapp_contacts").select(WHATSAPP_CONTACT_COLUMNS).eq("account_id", req.accountId!);
    if (social_account_id) query = query.eq("social_account_id", social_account_id);
    if (status) query = query.eq("consent_status", status);
    const safe = term.replace(/[^\p{L}\p{N} .'+-]/gu, "");
    if (safe) query = query.or(`contact_display.ilike.%${safe}%,display_name.ilike.%${safe}%`);
    if (before) query = query.lt("created_at", new Date(before).toISOString());
    const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
    if (error) {
      dbError(res, error, "GET /whatsapp/contacts");
      return;
    }
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    res.json({
      contacts: rows.map((r) => ({
        id: r.id,
        socialAccountId: r.social_account_id,
        contactKey: r.contact_key,
        contactDisplay: r.contact_display,
        displayName: r.display_name,
        countryCallingCode: r.country_calling_code,
        consentStatus: r.consent_status,
        optedInAt: r.opted_in_at,
        optedOutAt: r.opted_out_at,
        createdAt: r.created_at,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null,
    });
  });

  router.post("/whatsapp/contacts", ...write, async (req: AuthedRequest, res) => {
    const parsed = addSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const body = parsed.data;
    const capturedAt = consentDate(body.optIn.capturedAt);
    if (!capturedAt) {
      res.status(400).json({ error: "optIn.capturedAt must be a date like 2026-10-01 that is not in the future." });
      return;
    }
    try {
      if (!contactStorageReady()) throw new ContactStorageNotConfiguredError();
      if (!(await ownsConnection(req.accountId!, body.social_account_id))) {
        res.status(404).json({ error: "That WhatsApp connection was not found." });
        return;
      }
      const evidence: OptInEvidence = {
        source: body.optIn.source,
        capturedAt,
        consentText: body.optIn.consentText,
        proofReference: body.optIn.proofReference || null,
        attestationVersion: ATTESTATION_VERSION,
        importBatchId: null,
      };
      const [result] = await addContacts({ accountId: req.accountId!, socialAccountId: body.social_account_id, recordedBy: userIdFromToken(req.rawToken) }, [{ phone: body.phone, name: body.name, evidence }], { dryRun: false });
      if (result.status === "rejected") {
        res.status(400).json({ error: REJECT_MESSAGES[result.reason] ?? "That phone number is not valid. Use the international form, for example +27 82 123 4567.", reason: result.reason });
        return;
      }
      if (result.status === "suppressed") {
        res.status(409).json({ status: "suppressed", error: "This number has opted out and cannot be added." });
        return;
      }
      res.status(result.status === "accepted" ? 201 : 200).json({ status: result.status === "accepted" ? "created" : "duplicate" });
    } catch (e) {
      handle(res, e, "POST /whatsapp/contacts");
    }
  });

  router.post("/whatsapp/contacts/import", ...write, async (req: AuthedRequest, res) => {
    const parsed = importSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const body = parsed.data;
    const requestDate = consentDate(body.capturedAt);
    if (!requestDate) {
      res.status(400).json({ error: "capturedAt must be a date like 2026-10-01 that is not in the future." });
      return;
    }
    try {
      if (!contactStorageReady()) throw new ContactStorageNotConfiguredError();
      if (!(await ownsConnection(req.accountId!, body.social_account_id))) {
        res.status(404).json({ error: "That WhatsApp connection was not found." });
        return;
      }
      const batchId = randomUUID();
      const base = { source: body.source, consentText: body.consentText, proofReference: body.proofReference || null, attestationVersion: ATTESTATION_VERSION, importBatchId: batchId };
      const items: AddContactItem[] = body.rows.map((raw) => {
        const r = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
        if (!r) return { phone: "", evidence: { ...base, capturedAt: requestDate }, rejectReason: "row_invalid" };
        const evidence: OptInEvidence = { ...base, capturedAt: requestDate };
        const date = r.opt_in_date;
        let rejectReason: string | undefined;
        if (!isAffirmative(r.opted_in)) rejectReason = "opt_in_not_affirmative";
        else if (typeof date === "string" && date.trim() !== "") {
          const parsedDate = parseConsentDate(date);
          if (!parsedDate) rejectReason = "opt_in_date_invalid";
          else evidence.capturedAt = parsedDate;
        } else if (date !== undefined && date !== null && date !== "") rejectReason = "opt_in_date_invalid";
        return { phone: r.phone, name: r.name, evidence, rejectReason };
      });
      const dryRun = body.dryRun === true;
      const results = await addContacts({ accountId: req.accountId!, socialAccountId: body.social_account_id, recordedBy: userIdFromToken(req.rawToken) }, items, { dryRun });
      const count = (status: AddResult["status"]) => results.filter((r) => r.status === status).length;
      res.json({
        dryRun,
        accepted: count("accepted"),
        duplicates: count("duplicate"),
        suppressed: count("suppressed"),
        rejected: results.flatMap((r, i) => (r.status === "rejected" ? [{ row: i + 1, reason: r.reason }] : [])),
      });
    } catch (e) {
      handle(res, e, "POST /whatsapp/contacts/import");
    }
  });

  router.post("/whatsapp/contacts/:id/opt-out", ...write, async (req: AuthedRequest, res) => {
    try {
      if (!(await optOutContact(req.accountId!, String(req.params.id)))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      handle(res, e, "POST /whatsapp/contacts/:id/opt-out");
    }
  });

  router.delete("/whatsapp/contacts/:id", ...write, async (req: AuthedRequest, res) => {
    try {
      if (!(await eraseContact(req.accountId!, String(req.params.id)))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      handle(res, e, "DELETE /whatsapp/contacts/:id");
    }
  });

  router.get("/whatsapp/opt-outs", ...read, async (req: AuthedRequest, res) => {
    const counted = await req.db!.from("whatsapp_opt_outs").select("id", { count: "exact", head: true }).eq("account_id", req.accountId!);
    if (counted.error) {
      dbError(res, counted.error, "GET /whatsapp/opt-outs (count)");
      return;
    }
    const { data, error } = await req.db!.from("whatsapp_opt_outs").select(OPT_OUT_COLUMNS).eq("account_id", req.accountId!).order("occurred_at", { ascending: false }).limit(200);
    if (error) {
      dbError(res, error, "GET /whatsapp/opt-outs");
      return;
    }
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    res.json({
      count: counted.count ?? rows.length,
      optOuts: rows.map((r) => ({ id: r.id, contactDisplay: r.contact_display, scope: r.scope, source: r.source, keyword: r.keyword, occurredAt: r.occurred_at })),
    });
  });

  return router;
}
