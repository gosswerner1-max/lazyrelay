import type { createWalletLedger } from "./ledger.js";
import type { WalletMode } from "./mode.js";

type Ledger = ReturnType<typeof createWalletLedger>;

/** How often the expiry jobs run. Holds live 15 minutes, so this keeps a stale hold from blocking credits for long. */
export const WALLET_EXPIRY_INTERVAL_MS = 5 * 60_000;

/**
 * Expires credit lots past their end date and holds past their 15 minute life (the SQL functions do the work and write the ledger
 * entries). Off does nothing and asks nothing. A failure is logged without database text and never thrown, and one job failing does
 * not stop the other.
 */
export async function runWalletExpiryCycle(input: {
  ledger: Pick<Ledger, "expire" | "expireHolds">;
  mode: WalletMode;
  now: Date;
  log: (line: string) => void;
}): Promise<void> {
  const { ledger, mode, now, log } = input;
  if (mode === "off") return;
  try {
    const r = await ledger.expire(now);
    if (r.expiredLots > 0) log(`[wallet] expired ${r.expiredLots} lot(s)`);
  } catch (error) {
    log(`[wallet] the lot expiry job failed (${error instanceof Error ? error.name : "error"})`);
  }
  try {
    const r = await ledger.expireHolds(now);
    if (r.expiredHolds > 0) log(`[wallet] expired ${r.expiredHolds} stale hold(s)`);
  } catch (error) {
    log(`[wallet] the stale hold job failed (${error instanceof Error ? error.name : "error"})`);
  }
}
