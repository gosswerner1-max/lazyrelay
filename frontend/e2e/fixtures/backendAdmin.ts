import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

// E2E tests are dev-only tooling that never ships — reading the backend's
// own .env directly (rather than duplicating the service-role key into the
// frontend) keeps there being exactly one place these real credentials
// live. There is no separate staging Supabase project for either app; this
// is the same real production project every manual QA session already
// uses, via the same disposable-account-then-delete pattern.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../../backend/.env") });

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env for E2E tests to run.");
}

export const supabaseAdmin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const STALE_MS = 60 * 60 * 1000;
const EMAIL_PREFIX = "e2e-";
const EMAIL_SUFFIX = "@lazyrelay.invalid";

/** Deletes any fixture from a run that crashed before its own teardown ran
 *  (mirrors generate-test-login-link.ts's cleanup rule) — only ever
 *  matches this exact prefix/suffix, never a real account. */
export async function cleanupStaleFixtures(): Promise<void> {
  const { data: rows, error } = await supabaseAdmin
    .from("accounts")
    .select("id, email, created_at")
    .like("email", `${EMAIL_PREFIX}%${EMAIL_SUFFIX}`);
  if (error) {
    console.error("[e2e cleanup] listing stale fixtures failed:", error.message);
    return;
  }
  const stale = (rows ?? []).filter((row) => Date.now() - new Date(row.created_at).getTime() > STALE_MS);
  for (const row of stale) {
    await deleteDisposableAccount(row.id);
    console.log(`[e2e cleanup] removed stale fixture: ${row.email} (${row.id})`);
  }
}

export interface DisposableAccount {
  accountId: string;
  email: string;
}

export async function createDisposableAccount(): Promise<DisposableAccount> {
  const email = `${EMAIL_PREFIX}${Date.now()}${EMAIL_SUFFIX}`;
  const { data: user, error } = await supabaseAdmin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !user.user) throw error ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabaseAdmin.from("accounts").upsert({ id: accountId, email });
  return { accountId, email };
}

export async function generateMagicLink(email: string, redirectTo: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (error || !data) throw error ?? new Error("no link returned");
  return data.properties.action_link;
}

/** Seeds a social_accounts row with a real Vault secret backing it (the
 *  same store_social_token RPC the backend's own test-account-limits.ts
 *  script uses) — a plain insert fails because access_token_vault_id is
 *  NOT NULL, referencing vault.secrets. The token itself is a harmless
 *  placeholder; nothing in these tests ever attempts a real "Post Now"
 *  (which would try to actually publish), only "Schedule", which just
 *  writes a pending row. */
export async function seedSocialAccount(accountId: string, platform: string, displayName: string): Promise<string> {
  const { data: vaultId, error: vaultError } = await supabaseAdmin.rpc("store_social_token", { p_token: "e2e-fixture-token" });
  if (vaultError) throw vaultError;
  const { data: row, error } = await supabaseAdmin
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform,
      platform_account_id: `e2e-${platform}-${Date.now()}`,
      display_name: displayName,
      access_token_vault_id: vaultId,
    })
    .select("id")
    .single();
  if (error || !row) throw error ?? new Error("no social_accounts row returned");
  return row.id;
}

/** Seeds a real subscriptions row so resolveTier() (backend/src/tier.ts)
 *  sees a paid tier instead of the free-tier default a disposable account
 *  otherwise gets -- needed for anything gated above free (recurring
 *  schedules are free:0 slots, pro:3). Bypasses real Paddle entirely, same
 *  spirit as seedSocialAccount bypassing real OAuth. "pro" here is the DB
 *  code, which displays to customers as "Starter" (see tier.ts's own
 *  comment on the naming split) -- 3 recurring-schedule slots, plenty for
 *  a test that only creates one. */
export async function seedProSubscription(accountId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("subscriptions").insert({
    account_id: accountId,
    tier: "pro",
    status: "active",
    mor_subscription_id: `e2e-fixture-${Date.now()}`,
    current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
}

/** Deletes the account row + auth user. social_accounts, scheduled_posts,
 *  and subscriptions all cascade on accounts(id), so nothing seeded during
 *  a test needs tracking or deleting separately. */
export async function deleteDisposableAccount(accountId: string): Promise<void> {
  await supabaseAdmin.from("accounts").delete().eq("id", accountId);
  await supabaseAdmin.auth.admin.deleteUser(accountId);
}
