import { createWalletLedger, type WalletRpc } from "./ledger.js";
import { runWalletExpiryCycle, WALLET_EXPIRY_INTERVAL_MS } from "./expiry.js";
import { walletMode } from "./mode.js";

/** Registers the periodic expiry of credit lots and stale holds. The mode is read on every run, so the switch takes effect without a
 *  restart; off does nothing. A run still in progress is never overlapped. Returns the timer so a test can stop it. */
export function startWalletExpiryJob(client: WalletRpc, log: (line: string) => void = (line) => console.log(line)): NodeJS.Timeout {
  const ledger = createWalletLedger(client);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runWalletExpiryCycle({ ledger, mode: walletMode(), now: new Date(), log })
      .catch((error) => console.error("Wallet expiry error:", error instanceof Error ? error.name : "error"))
      .finally(() => {
        running = false;
      });
  }, WALLET_EXPIRY_INTERVAL_MS);
  return timer;
}
