// The competitor client the app uses. Kept out of competitorMode.ts so that file (and its tests) never load the LazyRelay API
// helper. Only the lazily loaded competitor section imports this file, so a build without the setting never carries it.

import { authedFetch } from "./api";
import { CompetitorError, createCompetitorClient, type CompetitorClient } from "./competitorMode";
import { createSessionTokenProvider, type SessionGrant } from "./contentSources";

const notConnected = (): CompetitorClient => ({ blueprint: () => Promise.reject(new CompetitorError("not_connected")) });

/**
 * baseUrl is the service address from the build setting (the same one the Content Sources tab uses). Unset or blank: not
 * switched on yet, and nothing goes over the network. Not plain https: the same, and the mistake is shown in the console.
 */
export function buildCompetitorClient(baseUrl: string | undefined): CompetitorClient {
  const address = baseUrl?.trim();
  if (!address) return notConnected();

  const session = createSessionTokenProvider({
    // The LazyRelay API's own authenticated call: it signs the request with the customer's sign in.
    fetchSession: () => authedFetch("/content-sources/session", { method: "POST" }) as Promise<SessionGrant>,
  });
  try {
    return createCompetitorClient({ baseUrl: address, getToken: session.getToken, onUnauthorized: session.invalidate });
  } catch (err) {
    console.error(err); // a wrong build setting must be seen, not hidden
    return notConnected();
  }
}

export const defaultCompetitorClient: CompetitorClient = buildCompetitorClient(import.meta.env.VITE_CONTENT_SOURCES_API_URL as string | undefined);
