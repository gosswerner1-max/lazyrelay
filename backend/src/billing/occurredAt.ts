// SECURITY FIX (2026-09-14): sync.ts builds a raw PostgREST .or() filter
// string with event.occurredAt template-interpolated directly into it
// (`last_webhook_occurred_at.lt.${event.occurredAt}`) -- postgrest-js's
// .or() syntax has no parameterized/escaped form, so anything landing in
// that string reaches the query as literal filter syntax. StubMorAdapter
// passes occurredAt straight from parsed attacker-supplied JSON with no
// validation (parsed.occurredAt ?? ...) -- gated behind a shared-secret
// signature check and never reachable in real production (the app
// refuses to boot with PADDLE_ENVIRONMENT=production without real MoR
// credentials, confirmed live), but it's a real filter-injection
// primitive sitting in shipped code regardless of today's reachability.
//
// Fixed at the actual point of use rather than only at the stub: parses
// the value as a real Date and re-serializes it via toISOString(), which
// both validates it (throws on anything that doesn't parse to a real
// instant) and normalizes it to a fixed, safe character set no filter
// syntax could hide inside. Protects every current and future caller of
// the .or() pattern, not just the one call site that happened to be
// audited.
export function normalizeOccurredAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid webhook occurredAt value: ${JSON.stringify(value)}`);
  }
  return parsed.toISOString();
}
