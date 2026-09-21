import type { Request, Response } from "express";
import { supabase } from "../supabase.js";
import { sendWelcomeEmailNow } from "../email.js";
import { isInternalTestAccount } from "../internalTestAccounts.js";

// Instant welcome email (2026-09-21). A database trigger on public.accounts
// (migration 0088) POSTs the new account's id here the moment a signup
// creates the row. Before this, the welcome email only went out from the
// hourly ops sweep (ops/accounts/welcome_onboarding_ops.js), so a new customer
// could wait up to an hour. That sweep is now the SAFETY NET, not the main
// path: if this endpoint or the email fails, the account is left un-welcomed
// and the sweep picks it up.
//
// Why this endpoint carries no shared secret (a deliberate choice, not an
// omission): the trigger cannot hold one without committing it to a public
// repo, so the endpoint is instead safe by construction. The request body is
// used for exactly one thing — an account id. Everything else is read from
// the database, never from the request:
//   - the recipient is the email stored on that account, never one from the body
//   - it only acts on an account created in the last 24 hours that has NEVER
//     been welcomed (welcome_email_sent_at IS NULL), so it cannot be used to
//     re-send to an old customer
//   - the "claim" is one atomic UPDATE ... WHERE welcome_email_sent_at IS NULL,
//     so two simultaneous calls (or this plus the ops sweep) can never send twice
//   - a forged request can therefore do nothing a real signup would not already
//     do, at most sending one email that was already owed
//   - every non-error outcome returns the identical body, so the response
//     cannot be used to probe whether an id exists
// Account ids are random UUIDs, not guessable. publicRateLimit sits in front.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

export type WelcomeOutcome =
  | "sent"
  | "not_found"
  | "already_welcomed"
  | "internal_test_account"
  | "too_old"
  | "claim_lost"
  | "send_failed";

/** The whole decision, separated from Express so it can be tested directly. */
export async function processNewAccountWelcome(accountId: string, now: Date = new Date()): Promise<WelcomeOutcome> {
  const { data: account, error: readError } = await supabase
    .from("accounts")
    .select("id, email, created_at, welcome_email_sent_at")
    .eq("id", accountId)
    .maybeSingle();
  if (readError) throw readError;
  if (!account) return "not_found";
  if (account.welcome_email_sent_at) return "already_welcomed";
  if (!account.email || isInternalTestAccount(account.email)) return "internal_test_account";
  if (now.getTime() - new Date(account.created_at).getTime() > MAX_ACCOUNT_AGE_MS) return "too_old";

  // Atomic claim: only one caller can flip NULL -> timestamp.
  const { data: claimed, error: claimError } = await supabase
    .from("accounts")
    .update({ welcome_email_sent_at: now.toISOString() })
    .eq("id", accountId)
    .is("welcome_email_sent_at", null)
    .select("id, email")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return "claim_lost";

  const result = await sendWelcomeEmailNow(claimed.email);
  if (result.ok) return "sent";

  // Release the claim so the hourly ops sweep retries this account.
  console.error(`[signup-welcome] email to account ${accountId} failed, releasing claim: ${result.error}`);
  const { error: releaseError } = await supabase
    .from("accounts")
    .update({ welcome_email_sent_at: null })
    .eq("id", accountId);
  if (releaseError) {
    console.error(`[signup-welcome] could NOT release claim for account ${accountId}:`, releaseError);
  }
  return "send_failed";
}

export async function handleSignupWebhook(req: Request, res: Response) {
  const id = req.body?.record?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(400).json({ error: "invalid request" });
    return;
  }
  try {
    const outcome = await processNewAccountWelcome(id);
    console.log(`[signup-welcome] account ${id}: ${outcome}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    // Never throw back into Express. Leaving the account un-welcomed is the
    // safe failure: the hourly ops sweep will pick it up.
    console.error(`[signup-welcome] account ${id}: unexpected error`, err);
    res.status(200).json({ ok: true });
  }
}
