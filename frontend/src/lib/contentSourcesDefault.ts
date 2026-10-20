// The client the Content Sources status panel uses in the shipped app. Kept out of contentSources.ts so that file (and the
// tab's own tests) stay free of the build setting. Only the lazily loaded Content Sources page imports this file. The readiness
// check needs no sign in, so there is no LazyRelay session here; the competitor box has its own client for the signed in calls.

import { createNotConnectedClient, createServiceClient, type ContentSourcesClient } from "./contentSources";

/**
 * baseUrl is the service address from the build setting. Unset or blank: no readiness check (the panel says Unknown), and
 * nothing goes over the network. Not https: the same, and the mistake is shown in the console.
 */
export function buildContentSourcesClient(baseUrl: string | undefined): ContentSourcesClient {
  const address = baseUrl?.trim();
  if (!address) return createNotConnectedClient();
  try {
    return createServiceClient({ baseUrl: address });
  } catch (err) {
    console.error(err); // a wrong build setting must be seen, not hidden
    return createNotConnectedClient();
  }
}

/** The address comes from the build setting only. Unset means no service yet. */
export const defaultContentSourcesClient: ContentSourcesClient = buildContentSourcesClient(
  import.meta.env.VITE_CONTENT_SOURCES_API_URL as string | undefined,
);
