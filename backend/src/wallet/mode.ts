/**
 * The wallet has three positions.
 *   off     the default: nothing is charged, nobody is paused, the wallet is not even asked.
 *   shadow  WALLET_ENABLED is exactly true: everything is calculated and logged ("would charge", "would pause"), nothing is charged or paused.
 *   on      WALLET_ENABLED is exactly true AND WALLET_MODE is exactly on: charges and pauses are real.
 * Anything else, including a typo, is the safer position, so a typo can never charge or pause anyone.
 */
export type WalletMode = "off" | "shadow" | "on";

export function walletMode(env: Record<string, string | undefined> = process.env): WalletMode {
  if (env.WALLET_ENABLED !== "true") return "off";
  return env.WALLET_MODE === "on" ? "on" : "shadow";
}
