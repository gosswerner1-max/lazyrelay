// Short wording for the plan limits the server reports. "No brand limit" appears only where brands is null.

import type { Wallet } from "./walletApi";

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function capsLine(caps: Wallet["plan"]["caps"]): string {
  const parts = [count(caps.accounts, "account", "accounts"), caps.brands === null ? "No brand limit" : count(caps.brands, "brand", "brands")];
  if (caps.queued !== null) parts.push(count(caps.queued, "queued post", "queued posts"));
  return parts.join(", ");
}
