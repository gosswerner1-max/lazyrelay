// The client the Content Sources tab uses in the shipped app. Kept out of contentSources.ts so that file (and the tab's own
// tests) never load the LazyRelay API helper. Only the lazily loaded Content Sources page imports this file.

import { authedFetch } from "./api";
import {
  createNotConnectedClient,
  createServiceClient,
  createSessionTokenProvider,
  type ContentSourcesClient,
  type SessionGrant,
} from "./contentSources";

/**
 * baseUrl is the service address from the build setting. Unset or blank: Not connected yet, and nothing goes over the network.
 * Not https: the same, and the mistake is shown in the console. Otherwise the real client, signed with a LazyRelay session.
 */
export function buildContentSourcesClient(baseUrl: string | undefined): ContentSourcesClient {
  const address = baseUrl?.trim();
  if (!address) return createNotConnectedClient();

  const session = createSessionTokenProvider({
    // The LazyRelay API's own authenticated call: it signs the request with the customer's sign in.
    fetchSession: () => authedFetch("/content-sources/session", { method: "POST" }) as Promise<SessionGrant>,
  });
  try {
    return createServiceClient({ baseUrl: address, getToken: session.getToken, onUnauthorized: session.invalidate });
  } catch (err) {
    console.error(err); // a wrong build setting must be seen, not hidden
    return createNotConnectedClient();
  }
}

/** The address comes from the build setting only. Unset means no service yet. */
export const defaultContentSourcesClient: ContentSourcesClient = buildContentSourcesClient(
  import.meta.env.VITE_CONTENT_SOURCES_API_URL as string | undefined,
);
