import { supabase } from "../supabase.js";

// Partner codes are made by ops/reports/referral_report.js as 3 to 40 lowercase letters, digits and hyphens. Anything else cannot be a
// real code, so it never reaches the database (this also keeps LIKE wildcards out of the case insensitive lookup below).
const PLAIN_CODE = /^[a-z0-9-]{1,40}$/i;

/** The approved partner's stored code for whatever the browser sent, or null for anything that is not an approved partner (unknown,
 *  paused, malformed). A bad code is never an error. A database failure IS thrown, so the caller decides (checkout and claim both
 *  treat it as "no code" and log it). The same approved-partner rule as the signup trigger (migration 0079) and recordPartnerAttribution.
 *
 *  Self referral: when accountId is given and that account's email is the partner's registered email (any letter case), the code is
 *  treated as not valid, so a partner can never earn on their own purchase. The buyer just checks out without the code. */
export async function resolveApprovedPartnerCode(raw: unknown, accountId?: string): Promise<string | null> {
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  if (!PLAIN_CODE.test(code)) return null;
  const { data, error } = await supabase.from("referral_partners").select("code, email").ilike("code", code).eq("status", "approved").limit(1).maybeSingle();
  if (error) throw new Error(`partner code lookup failed: ${error.message}`);
  if (!data) return null;
  if (accountId && typeof data.email === "string" && data.email) {
    const { data: account, error: accountError } = await supabase.from("accounts").select("email").eq("id", accountId).maybeSingle();
    if (accountError) throw new Error(`partner code self check failed: ${accountError.message}`);
    if (typeof account?.email === "string" && account.email.trim().toLowerCase() === data.email.trim().toLowerCase()) return null;
  }
  return data.code;
}

/** True when the one shared partner discount (10% off the first payment of Growth or Pro) is configured in Paddle and named in env. */
export function partnerDiscountConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.PADDLE_PARTNER_DISCOUNT_ID);
}
