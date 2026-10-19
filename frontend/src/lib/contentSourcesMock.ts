// MOCK Content Sources client. For tests and for manual development only: never imported by shipped code, and it never
// touches the network. The real client is createContentSourcesClient in ./contentSources.

import type { AddResult, ContentSourcesClient, VerifyResult } from "./contentSources";

export function createMockContentSourcesClient(outcomes: { verify?: VerifyResult; add?: AddResult } = {}): ContentSourcesClient {
  return {
    verifySource: async () => outcomes.verify ?? { status: "verified" },
    addSource: async () => outcomes.add ?? { status: "added" },
  };
}
