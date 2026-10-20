// The paid competitor client the app uses. Kept out of competitorBilling.ts so that file (and its tests) never load the
// LazyRelay API helper, and the helper itself is fetched only when a person actually runs a paid analysis.
// Only the competitor section imports this file, and it builds the client only when VITE_BILLING_ENABLED is "true".

import { createBillingCompetitorClient } from "./competitorBilling";
import type { CompetitorClient } from "./competitorMode";

/** authedFetch signs the request with the customer's sign in. It is loaded on first use so nothing else waits on it. */
export function defaultBillingClient(): CompetitorClient {
  return createBillingCompetitorClient(async (path, options) => (await import("./api")).authedFetch(path, options));
}
