// POST /migrate/csv: bring posts over from a Buffer or Hootsuite CSV export as LazyRelay DRAFTS. Two steps on one route:
//   step "preview" (the default): parse and report. Creates nothing.
//   step "confirm": creates the drafts (never scheduled, approved or published), in one batch, idempotent.
// The column layouts are assumptions from public documentation, not verified against real exports (see docs/CSV-MIGRATION.md).
//
// Gate, in this order: CSV_MIGRATION_ENABLED exactly "true" (else 404), a signed-in HUMAN (an API key is refused), the normal
// tiered limit, then the stricter per-user hourly limit for the step. The caller's account comes from the session, never from
// the request. The file is read from memory, never stored, and cell contents are never logged (counts only).

import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { dbError } from "./shared.js";
import { validateBody } from "../validation.js";
import { analyzeCsv, buildPreview, type Analysis } from "../../csvMigration/analyze.js";
import { importDrafts } from "../../csvMigration/importDrafts.js";
import { CsvMigrationError } from "../../csvMigration/parseCsv.js";
import { MAX_CSV_BYTES } from "../../csvMigration/limits.js";
import { csvConfirmRateLimit, csvPreviewRateLimit } from "../../csvMigration/rateLimits.js";

const TOO_LARGE = { error: "That file is over 2 MB. Split it into smaller files.", code: "file_too_large" };

/** A 2 MB JSON parser of its own, mounted in app.ts BEFORE the global one. Its error answer never echoes the body. */
export const csvMigrationJsonParser = [
  express.json({ limit: "2mb" }),
  (err: { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large") res.status(413).json(TOO_LARGE);
    else res.status(400).json({ error: "That request could not be read.", code: "invalid_request" });
  },
];

const columnName = z.string().max(200).nullish();
const fieldsSchema = z.object({
  step: z.enum(["preview", "confirm"], { error: "step must be preview or confirm" }).default("preview"),
  dateOrder: z.enum(["dmy", "mdy"], { error: "dateOrder must be dmy or mdy" }).optional(),
  timezone: z.string().max(64).optional(),
  fileFingerprint: z.string().max(100).optional(),
  mapping: z.object({ text: columnName, link: columnName, time: columnName }, { error: "mapping must name the text, link and time columns" }).optional(),
});
type Fields = z.output<typeof fieldsSchema>;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CSV_BYTES, files: 1, fields: 10, fieldSize: 10_000 } });

function flagGate(_req: Request, res: Response, next: NextFunction): void {
  if (process.env.CSV_MIGRATION_ENABLED !== "true") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

function refuse(res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error, code, ...extra });
}

/** The text fields of the request as one validated object. Empty values count as not sent. */
function readFields(raw: Record<string, unknown>): { ok: true; fields: Fields } | { ok: false; code: string; error: string } {
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== "" && v !== undefined && v !== null));
  if (typeof cleaned.mapping === "string") {
    try {
      cleaned.mapping = JSON.parse(cleaned.mapping);
    } catch {
      return { ok: false, code: "invalid_mapping", error: "The column choice could not be read." };
    }
  }
  const fields = validateBody(fieldsSchema, cleaned);
  return fields.ok ? { ok: true, fields: fields.data } : { ok: false, code: "invalid_request", error: fields.error };
}

/** Multipart (field "file") or JSON ({csv}) into one buffer plus the validated fields. */
function readRequest(req: Request, res: Response, next: NextFunction): void {
  const finish = (raw: Record<string, unknown>, buffer: Buffer | null) => {
    const read = readFields(raw);
    if (!read.ok) return refuse(res, 400, read.code, read.error);
    if (!buffer) return refuse(res, 400, "no_file", 'No CSV was sent. Upload it as the form field "file", or send it as {"csv": "..."}.');
    res.locals.csv = { buffer, fields: read.fields };
    next();
  };
  if (req.is("multipart/form-data")) {
    upload.single("file")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return err.code === "LIMIT_FILE_SIZE" ? void res.status(413).json(TOO_LARGE) : refuse(res, 400, "no_file", "No CSV file was found in the upload.");
      }
      if (err) return refuse(res, 400, "invalid_request", "That upload could not be read.");
      finish(req.body ?? {}, req.file?.buffer ?? null);
    });
    return;
  }
  const { csv, ...rest } = (req.body ?? {}) as Record<string, unknown>;
  finish(rest, typeof csv === "string" ? Buffer.from(csv, "utf8") : null);
}

const stepLimit: RequestHandler = (req, res, next) => {
  const isConfirm = (res.locals.csv as { fields: Fields }).fields.step === "confirm";
  return (isConfirm ? csvConfirmRateLimit : csvPreviewRateLimit)(req, res, next);
};

const inFlight = new Set<string>();

async function confirm(req: AuthedRequest, res: Response, analysis: Analysis, fingerprint: string | undefined): Promise<void> {
  const accountId = req.accountId!;
  if (fingerprint !== analysis.fingerprint) return refuse(res, 409, "file_changed", "The file is not the one you previewed. Preview it again before confirming.");
  if (analysis.needsMapping) return refuse(res, 400, "mapping_required", "Choose which column holds the post text.", { headers: analysis.headers, sampleRows: analysis.sampleRows });
  if (analysis.dateOrderRequired) return refuse(res, 400, "date_order_required", "The dates could be day/month or month/day. Send dateOrder as dmy or mdy.");
  if (inFlight.has(accountId)) return refuse(res, 409, "import_in_progress", "An import is already running for this account. Wait for it to finish.");
  inFlight.add(accountId);
  try {
    const result = await importDrafts(req.db!, accountId, analysis);
    console.info("[csv-migration] confirm", { created: result.created, skipped: result.skipped.length, remaining: result.remaining });
    res.status(result.created > 0 ? 201 : 200).json(result);
  } catch (err) {
    dbError(res, { message: err instanceof Error ? err.message : "unknown error" }, "POST /migrate/csv");
  } finally {
    inFlight.delete(accountId);
  }
}

export function buildMigrateCsvRouter(): Router {
  const router = Router();
  router.post("/migrate/csv", flagGate, requireAuth, requireHumanAuth, tieredRateLimit, readRequest, stepLimit, async (req: AuthedRequest, res) => {
    const { buffer, fields } = res.locals.csv as { buffer: Buffer; fields: Fields };
    try {
      const analysis = analyzeCsv(buffer, { mapping: fields.mapping, timezone: fields.timezone, dateOrder: fields.dateOrder });
      if (fields.step === "preview") return void res.json(buildPreview(analysis));
      await confirm(req, res, analysis, fields.fileFingerprint);
    } catch (err) {
      if (!(err instanceof CsvMigrationError)) throw err;
      refuse(res, err.status, err.code, err.message);
    }
  });
  return router;
}
