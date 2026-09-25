import { z } from "zod";

// Request-body validation for the HTTP routes (2026-09-25). Replaces the
// hand-written per-field `typeof x !== "string"` / length / undefined checks
// that used to be repeated in every route under http/routes/. Written as a
// drop-in replacement, not a tightening: every schema keeps the exact
// error message, status code, and accept/reject rule the old if-statement
// had. Two mechanics make that possible:
//
//  1. validateBody() treats a missing or non-object body exactly the way the
//     old `const { a, b } = req.body ?? {}` destructure did -- every field
//     simply reads as undefined -- so a request with no body still gets the
//     same field-level message it always got, not a new generic one.
//  2. The error returned is the FIRST issue zod reports. zod walks object
//     keys in the order the schema declares them and runs each field's
//     checks in the order they're chained, so a schema whose keys and checks
//     are declared in the same order the old if-statements ran returns the
//     same message the old code returned for the same bad input -- including
//     when several fields are wrong at once.
//
// Where a route's old checks were interleaved with a DB lookup or a
// business rule (reserved business names, SSRF URL checks, auth-method
// checks), the schema only covers the pure shape checks around it and the
// route calls validateBody() at the same point the old checks ran, so the
// order in which a request can fail is unchanged.

export type BodyValidation<T> = { ok: true; data: T } | { ok: false; error: string };

export function validateBody<S extends z.ZodType>(schema: S, body: unknown): BodyValidation<z.output<S>> {
  const input = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.issues[0]?.message ?? "Invalid request body" };
}

/** A field the route reads but never validated -- passed through untouched,
 *  absent or not. (`.optional()` matters: zod 4 treats a bare z.unknown()
 *  object key as required.) */
export function unvalidated() {
  return z.unknown().optional();
}

/** Old check: `typeof v !== "string" || v.trim().length === 0` -> message.
 *  Chain `.max(...)` etc. after it for the follow-up length check. */
export function nonEmptyString(message: string) {
  return z.string({ error: message }).refine((s) => s.trim().length > 0, { message });
}

/** Old check: `v !== undefined && v !== null && typeof v !== "string"` -> message.
 *  Build the string part yourself (`z.string({ error }).max(...)`) and call
 *  `.nullish()` when a length limit is also needed. */
export function optionalNullableString(message: string) {
  return z.string({ error: message }).nullish();
}

/** Old check: `v !== undefined && typeof v !== "boolean"` -> message (so an
 *  explicit null is rejected, same as before). */
export function optionalBoolean(message: string) {
  return z.boolean({ error: message }).optional();
}
