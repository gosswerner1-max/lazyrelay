// MOCK Content Sources client. For tests and for manual development only: never imported by shipped code, and it never
// touches the network. The real client is createServiceClient in ./contentSources.

import type { ContentSourcesClient } from "./contentSources";

/** Sensible answers for every call. A test replaces only the calls it cares about. */
export function createMockContentSourcesClient(overrides: Partial<ContentSourcesClient> = {}): ContentSourcesClient {
  return {
    getCredentials: async () => ({ registered: true, keyHint: "abcd" }),
    saveKey: async (apiKey) => ({ keyHint: apiKey.slice(-4) }),
    removeKey: async () => undefined,
    listSources: async () => [],
    createSource: async (input) => ({
      source: {
        id: "00000000-0000-4000-8000-000000000001",
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        syncInterval: input.syncInterval ?? "daily",
        brandId: input.brandId ?? null,
        lastSyncedAt: null,
        domainVerified: false,
        verificationMethod: null,
        lastError: null,
        consecutiveFailures: 0,
        verificationToken: "mock-proof-token",
      },
      verification: {
        token: "mock-proof-token",
        methods: {
          well_known: { url: "https://example.com/.well-known/proof-example.txt", content: "mock-proof-token" },
          meta_tag: { html: '<meta name="proof-example" content="mock-proof-token">', placement: "inside <head> of https://example.com/" },
          dns_txt: { name: "_proof-example.example.com", value: "proof-example=mock-proof-token" },
        },
      },
    }),
    verifySource: async () => ({ verified: true, method: "well_known" }),
    updateSource: async () => {
      throw new Error("The mock client has no source to update. Override updateSource in the test.");
    },
    deleteSource: async () => undefined,
    runSource: async () => undefined,
    ...overrides,
  };
}
