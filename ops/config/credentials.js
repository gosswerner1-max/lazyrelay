// Single source of truth for every credential the ops/ modules need.
//
// Mirrors The Lazy Download's automation2/config/credentials.py pattern —
// typed getters, nothing outside this file reads a secrets source
// directly — but adapted so nothing is duplicated: Supabase and the
// Merchant-of-Record credentials already live in backend/.env (the real
// backend app needs them too), so this module reads that file rather than
// keeping a second copy that could drift out of sync. Genuinely ops-only
// credentials (e.g. the LazyRelay product API key below) get their own
// local JSON file instead, same as email-agent/credentials.local.json
// already does for IMAP.

const fs = require("fs");
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

const OPS_CREDS_PATH = path.join(__dirname, "credentials.local.json");

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

/** LazyRelay's own product API key — used to call LazyRelay's customer-
 * facing API the same way a customer's own AI agent would (bring-your-own-
 * agent auth, see backend/src/http/auth.ts), rather than the local scripts'
 * usual direct-Supabase-service-role access. Lives in its own local JSON
 * file, not backend/.env, since it's an ops-only credential the running
 * backend process itself never needs to read. */
function getLazyRelayApiKey() {
  if (!fs.existsSync(OPS_CREDS_PATH)) return null;
  const creds = JSON.parse(fs.readFileSync(OPS_CREDS_PATH, "utf8"));
  return creds.lazyRelayApiKey ?? null;
}

/** The admin-tier key (lzr_admin_ prefix) — acts across every account, not
 * just one tenant. See backend/src/http/auth.ts's requireAuth admin path
 * and backend/src/create-admin-key.ts (the one-off script that minted it). */
function getLazyRelayAdminApiKey() {
  if (!fs.existsSync(OPS_CREDS_PATH)) return null;
  const creds = JSON.parse(fs.readFileSync(OPS_CREDS_PATH, "utf8"));
  return creds.lazyRelayAdminApiKey ?? null;
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

/** LEGACY -- do not use this for new work. See mcp-server/PUBLISHING.md.
 *
 * npm Granular Access Token for the @lazyrelay org (Read/write, bypasses
 * 2FA, 90-day expiry) -- used to publish 0.1.0 (2026-08-07) and 0.1.1
 * (2026-08-17) headlessly. As of 2026-08-17, publishing goes through
 * .github/workflows/publish-mcp-server.yml instead (npm trusted
 * publishing / OIDC, no stored token at all) -- proven working with a
 * real release (0.1.2), and preferred because npm is actively
 * restricting this exact "bypass 2FA" token class: account-management
 * actions (including revoking a token, even itself) were already
 * blocked 2026-07-31 -- confirmed live, this token got a real 403
 * trying to revoke itself -- and direct publishing goes away entirely
 * around January 2027.
 *
 * May return null if Werner has since revoked this token now that the
 * replacement is proven. That is expected, not a bug -- don't
 * regenerate a replacement token, use the GitHub Actions path above. */
function getNpmAccessToken() {
  if (!fs.existsSync(OPS_CREDS_PATH)) return null;
  const creds = JSON.parse(fs.readFileSync(OPS_CREDS_PATH, "utf8"));
  return creds.npmAccessToken ?? null;
}

/** Supabase Personal Access Token (account-level, not project-scoped) —
 * added 2026-08-08 so migrations can be applied directly via the Supabase
 * CLI instead of Werner hand-pasting SQL into the dashboard each time. This
 * is a real account credential (can manage any project on the account), not
 * just data access like the service-role key above — keep it out of
 * anything that isn't this gitignored file. */
function getSupabaseAccessToken() {
  if (!fs.existsSync(OPS_CREDS_PATH)) return null;
  const creds = JSON.parse(fs.readFileSync(OPS_CREDS_PATH, "utf8"));
  return creds.supabaseAccessToken ?? null;
}

/** Resend credentials, already in backend/.env for the deployed app's own
 * transactional emails (backend/src/email.ts) — reused here, not duplicated,
 * for the data-retention reaper's reminder email (2026-08-15). Returns
 * null, not a throw, so a missing key degrades to "skip sending, still run
 * the sweep" rather than crash the whole ops task. */
function getResendCredentials() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS ?? "noreply@mail.lazyrelay.com";
  if (!apiKey) return null;
  return { apiKey, fromAddress };
}

module.exports = {
  getSupabaseCredentials,
  getMorCredentials,
  getEmailAgentCredentialsPath,
  getRenderCredentials,
  getLazyRelayApiKey,
  getLazyRelayAdminApiKey,
  getNpmAccessToken,
  getSupabaseAccessToken,
  getResendCredentials,
};
