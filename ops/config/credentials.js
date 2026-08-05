// Single source of truth for every credential the ops/ modules need.
//
// Mirrors The Lazy Download's automation2/config/credentials.py pattern —
// typed getters, nothing outside this file reads a secrets source
// directly — but adapted so nothing is duplicated: Supabase and the
// Merchant-of-Record credentials already live in backend/.env (the real
// backend app needs them too), so this module reads that file rather than
// keeping a second copy that could drift out of sync. Only genuinely
// ops-only credentials (none yet) would get their own local JSON file,
// same as email-agent/credentials.local.json already does for IMAP.

const path = require("path");
const dotenv = require("dotenv");

const BACKEND_ENV_PATH = path.join(__dirname, "..", "..", "backend", ".env");
dotenv.config({ path: BACKEND_ENV_PATH });

const EMAIL_AGENT_CREDS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "support",
  "email-agent",
  "credentials.local.json"
);

function getSupabaseCredentials() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      `SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in ${BACKEND_ENV_PATH}. ` +
        "Ops modules read the backend's own .env rather than keeping a duplicate."
    );
  }
  return { url, serviceRoleKey };
}

/**
 * Merchant-of-Record credentials (Stripe Managed Payments — see
 * backend/src/billing/types.ts for why). Returns null, not a throw, until
 * that account actually exists — Billing domain functions must check for
 * null and report "billing not live yet" rather than crash, same honesty
 * discipline the email agent already uses for "no billing system exists."
 */
function getMorCredentials() {
  const apiKey = process.env.MOR_API_KEY;
  const webhookSecret = process.env.MOR_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret) return null;
  return { apiKey, webhookSecret };
}

/** Path to the email agent's own credentials file — reused, not duplicated,
 * for any domain (e.g. Accounts nudge emails) that needs to draft through
 * the existing IMAP tool rather than open a new send path. */
function getEmailAgentCredentialsPath() {
  return EMAIL_AGENT_CREDS_PATH;
}

/** Render API credentials — added 2026-08-05 so billing_ops.js can check
 * what's actually DEPLOYED instead of trusting this local .env file, after
 * a real incident where local held live Paddle creds while Render was
 * still on sandbox for weeks with nobody noticing. Returns null, not a
 * throw, so callers can degrade to "deployed status unknown" rather than
 * crash if these ever go missing. */
function getRenderCredentials() {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) return null;
  return { apiKey, serviceId };
}

module.exports = { getSupabaseCredentials, getMorCredentials, getEmailAgentCredentialsPath, getRenderCredentials };
