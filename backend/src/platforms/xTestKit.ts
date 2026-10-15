// Test-only helpers for the X bring-your-own-key code. The values are obviously fake and are not secrets.

import { serializeXBundle, type XByokBundle } from "./xByok.js";

export const X_TEST_BUNDLE: XByokBundle = {
  apiKey: "TESTapiKEY0123456789abcd",
  apiSecret: "TESTapiSECRET0123456789abcdefghijklmnopqrstuvw",
  accessToken: "1234567890-TESTaccessTOKEN0123456789abcdef",
  accessTokenSecret: "TESTaccessSECRET0123456789abcdefghijklmnop",
};

/** What the Vault holds (and the adapter is handed as its "access token") for a test BYOK connection. */
export const X_TEST_LOGIN = serializeXBundle(X_TEST_BUNDLE);
