import { walletMode, type WalletMode } from "./mode.js";
import { getWalletService, type SignupGrantOutcome } from "./service.js";

/**
 * Safety net for the one time signup credits. Accounts are created by the database trigger on auth.users and e-mail confirmation
 * happens inside Supabase Auth, so the backend never sees either event. The first authenticated request of a confirmed owner is the
 * earliest moment the backend can act, and ensureSignupGrant is idempotent (key signup:{accountId}), so this simply asks on every
 * dashboard login and remembers the answer per process so the database is not asked again on every request.
 *
 * Only runs when the wallet is fully on. A failure never reaches the caller: it is logged with the raw error and retried later.
 */
const RETRY_AFTER_MS = 60_000;

export interface SignupGrantTriggerDeps {
  mode(): WalletMode;
  grant(accountId: string): Promise<SignupGrantOutcome>;
  now(): number;
  log(message: string, error: unknown): void;
}

export function createSignupGrantTrigger(deps: SignupGrantTriggerDeps) {
  const settled = new Set<string>();
  const inFlight = new Set<string>();
  const retryAt = new Map<string, number>();

  return async function triggerSignupGrant(accountId: string): Promise<void> {
    if (deps.mode() !== "on") return;
    if (settled.has(accountId) || inFlight.has(accountId)) return;
    if ((retryAt.get(accountId) ?? 0) > deps.now()) return;
    inFlight.add(accountId);
    try {
      const outcome = await deps.grant(accountId);
      if (outcome.granted || outcome.reason !== "email_unconfirmed") settled.add(accountId);
      else retryAt.set(accountId, deps.now() + RETRY_AFTER_MS);
    } catch (err) {
      retryAt.set(accountId, deps.now() + RETRY_AFTER_MS);
      deps.log(`[wallet] signup grant failed for account ${accountId}, will retry:`, err);
    } finally {
      inFlight.delete(accountId);
    }
  };
}

export const triggerSignupGrant = createSignupGrantTrigger({
  mode: () => walletMode(),
  grant: (id) => getWalletService().ensureSignupGrant(id),
  now: () => Date.now(),
  log: (message, error) => console.error(message, error),
});
