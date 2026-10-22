import { supabase } from "../supabase.js";

// Partner codes are made by ops/reports/referral_report.js as 3 to 40 lowercase letters, digits and hyphens. Anything else cannot be a
// real code, so it never reaches the database (this also keeps LIKE wildcards out of the case insensitive lookup below).
const PLAIN_CODE = /^[a-z0-9-]{1,40}$/i;

/** The approved partner's stored code for whatever the browser sent, or null for anything that is not an approved partner (unknown,
 *  paused, malformed). A bad code is never an error. A database failure IS thrown, so the caller decides (checkout and claim both
 *  treat it as "no code" and log it). The same approved-partner rule as the signup trigger (migration 0079) and recordPartnerAttribution. */
export async function resolveApprovedPartnerCode(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  if (!PLAIN_CODE.test(code)) return null;
  const { data, error } = await supabase.from("referral_partners").select("code").ilike("code", code).eq("status", "approved").limit(1).maybeSingle();
  if (error) throw new Error(`partner code lookup failed: ${error.message}`);
  return data?.code ?? null;
}
