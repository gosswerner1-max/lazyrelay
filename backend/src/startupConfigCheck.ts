import { notifyOps } from "./notify.js";

/** Catches the ways config drift silently broke LazyRelay in production before
 *  anyone noticed. All of them happened when Render's environment was rebuilt
 *  from a local backend/.env, which DELIBERATELY differs from production:
 *   - FRONTEND_URL missing (app.ts's CORS allowlist falls back to localhost
 *     only, so every real browser request from lazyrelay.com is rejected and
 *     customers see a generic "Failed to fetch"; found 2026-09-29);
 *   - TIKTOK_CLIENT_KEY still the Sandbox app's key (TikTok's own "sb" prefix)
 *     eight days after the Production app was approved (2026-09-29);
 *   - the Bluesky/Telegram/Discord connect-page URLs left pointing at
 *     http://localhost:5173, which would send a real customer to localhost
 *     (2026-09-29; the reason this check is now generic).
 *  Everything already connected kept working while these were wrong, which is
 *  why they sat unnoticed: only a brand-new session or connect ever hit them.
 *  The problems are raised through the same notifyOps() path the incident
 *  responder already watches, so drift like this surfaces in minutes, not days.
 *
 *  Gated on RENDER (set automatically by Render on every deployed service) so
 *  local dev boots, which never set these the same way, stay quiet. */

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/** Pure: every production-config problem in this environment, as plain
 *  sentences. Empty when nothing looks wrong. */
export function findProductionConfigProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];

  if (!env.FRONTEND_URL) {
    problems.push(
      "FRONTEND_URL is not set on this deploy. The CORS allowlist falls back to http://localhost:5173 only -- every real browser request from lazyrelay.com/www.lazyrelay.com will be rejected and customers will see a generic \"Failed to fetch\". Set it to https://lazyrelay.com.",
    );
  }

  if (env.TIKTOK_CLIENT_KEY?.startsWith("sb")) {
    problems.push(
      'TIKTOK_CLIENT_KEY looks like a Sandbox app key (TikTok\'s own "sb" prefix), not the Production key. Any TikTok account not manually added as a sandbox target user will fail to connect or refresh. Set it to the Production key from developers.tiktok.com.',
    );
  }

  // WhatsApp broadcast contacts store customer phone numbers encrypted. With the feature switched on but a secret missing or
  // unusable, every add would be refused (fail closed): say so at boot. Names only, never a value.
  if (env.WHATSAPP_BROADCASTS_ENABLED === "true") {
    const missing = ["WHATSAPP_CONTACT_HASH_KEY", "WHATSAPP_CONTACT_ENC_KEY", "WHATSAPP_CONTACT_ENC_KEY_ID"].filter((k) => !env[k]?.trim());
    if (missing.length > 0) {
      problems.push(`WHATSAPP_BROADCASTS_ENABLED is on but these settings are missing: ${missing.join(", ")}. Contacts cannot be stored until they are set (the contact tab stays hidden).`);
    } else if (Buffer.from(env.WHATSAPP_CONTACT_ENC_KEY!.trim(), "base64").length !== 32) {
      problems.push("WHATSAPP_BROADCASTS_ENABLED is on but WHATSAPP_CONTACT_ENC_KEY is not a base64 encoded key of exactly 32 bytes. Contacts cannot be stored until it is fixed (the contact tab stays hidden).");
    }
  }

  // Broadcast and chat sending needs the feature switches on and the webhook verify token (receipts and replies arrive on that
  // webhook). Names only, never a value.
  if (env.WHATSAPP_SEND_ENABLED === "true") {
    const off = ["WHATSAPP_BYOK_ENABLED", "WHATSAPP_BROADCASTS_ENABLED"].filter((k) => env[k] !== "true");
    if (off.length > 0) {
      problems.push(`WHATSAPP_SEND_ENABLED is on but these settings are not "true": ${off.join(", ")}. Nothing can be sent until they are.`);
    } else if (!env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim()) {
      problems.push("WHATSAPP_SEND_ENABLED is on but WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set. Delivery receipts and replies cannot arrive until it is.");
    }
  }

  // Any URL-valued setting that points at this machine is a local value that
  // leaked into production (a customer would be sent to localhost). Only the
  // names are reported, never the values.
  const local = Object.entries(env)
    .filter(([key, value]) => /(_URL|_URI|_ORIGIN|_HOST)$/.test(key) && typeof value === "string" && LOCAL_URL.test(value.trim()))
    .map(([key]) => key)
    .sort();
  if (local.length > 0) {
    problems.push(
      `These settings point at localhost on this deploy: ${local.join(", ")}. That is a local development value; a real customer would be sent to localhost. Set each to its lazyrelay.com value. (Render's environment must never be rebuilt from a local backend/.env.)`,
    );
  }

  return problems;
}

export async function checkProductionConfig(): Promise<void> {
  if (process.env.RENDER !== "true") return;
  for (const problem of findProductionConfigProblems(process.env)) {
    await notifyOps(problem);
  }
}
