/**
 * The wallet is off unless WALLET_ENABLED is exactly the word true. While it is off nothing calls the wallet functions and nothing is
 * charged, whatever else is deployed. Same rule as the other switches in this service.
 */
export function walletEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.WALLET_ENABLED === "true";
}
