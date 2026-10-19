import { minActionPriceMicro } from "./rules.js";
import type { WalletMode } from "./mode.js";
import type { WalletRpc } from "./ledger.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The accounts whose queue the publisher must leave alone this cycle: those with a wallet that cannot pay for the next action.
 * Their posts stay pending (not failed) and come back the moment a top up lands.
 *   off     returns nothing and does not ask the database.
 *   shadow  returns nothing, and logs how many accounts WOULD have been paused.
 *   on      returns the ids. If the wallet cannot be read, nobody is paused: publishing must never stop because the wallet is down.
 * Only well formed uuids are ever returned, because the ids end up inside a query filter.
 */
export async function fetchPausedAccountIds(client: WalletRpc, mode: WalletMode, log: (line: string) => void): Promise<string[]> {
  if (mode === "off") return [];
  let ids: string[] = [];
  try {
    const { data, error } = await client.rpc("wallet_paused_account_ids", { p_min: minActionPriceMicro() });
    if (error) throw new Error("wallet read failed");
    if (Array.isArray(data)) {
      ids = data
        .map((row) => (typeof row === "string" ? row : row && typeof row === "object" ? (row as Record<string, unknown>).wallet_paused_account_ids : undefined))
        .filter((v): v is string => typeof v === "string" && UUID.test(v));
    }
  } catch {
    log("[wallet] could not read paused accounts, pausing nobody this cycle");
    return [];
  }
  if (mode === "shadow") {
    if (ids.length > 0) log(`[wallet-shadow] ${ids.length} account(s) would have their queue paused (balance below the cheapest action)`);
    return [];
  }
  return ids;
}
