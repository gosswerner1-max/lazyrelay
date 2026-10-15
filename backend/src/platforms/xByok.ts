// The four OAuth 1.0a values of a customer's own X developer app, as they are stored: ONE JSON string in the
// connection's Vault secret (social_accounts.access_token_vault_id, written through store_social_token). The X adapter
// reads that string back as the "access token" it is handed on every call and signs each request with it.
//
// Nothing in here ever puts a value in an error, a log line or a return the caller could forward: parse failures say
// only that the bundle is unusable.

export interface XByokBundle {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** Shown to the customer when an X connection does not hold their own keys (an old connection, a missing or damaged
 *  bundle). Fixed text, no values. */
export const X_NOT_BYOK_MESSAGE = "This X connection does not use your own keys. Reconnect X with your own developer keys.";

/** The code the adapter reports (never the bundle) when it cannot use the stored login. postErrors.ts turns it into
 *  X_NOT_BYOK_MESSAGE. */
export const X_BUNDLE_INVALID_CODE = "x_byok_bundle_invalid";

/** Strict charset, loose length: X's key formats are not documented as stable, so only the shape is enforced.
 *  Access tokens contain a hyphen (<user id>-<letters>). */
export const X_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
export const X_KEY_MIN_LENGTH = 8;
export const X_KEY_MAX_LENGTH = 200;

export function serializeXBundle(bundle: XByokBundle): string {
  return JSON.stringify({
    v: 1,
    apiKey: bundle.apiKey,
    apiSecret: bundle.apiSecret,
    accessToken: bundle.accessToken,
    accessTokenSecret: bundle.accessTokenSecret,
  });
}

/** Returns the bundle, or null for anything that is not a complete version 1 bundle. Never throws. */
export function parseXBundle(stored: string | null | undefined): XByokBundle | null {
  if (typeof stored !== "string" || !stored.startsWith("{")) return null;
  try {
    const p = JSON.parse(stored) as Record<string, unknown>;
    if (p.v !== 1) return null;
    const fields = [p.apiKey, p.apiSecret, p.accessToken, p.accessTokenSecret];
    if (!fields.every((f) => typeof f === "string" && f.length > 0)) return null;
    return {
      apiKey: p.apiKey as string,
      apiSecret: p.apiSecret as string,
      accessToken: p.accessToken as string,
      accessTokenSecret: p.accessTokenSecret as string,
    };
  } catch {
    return null;
  }
}

/** Display-only masked suffix of the PUBLIC api key (at most 8 characters, the column limit). */
export function xKeyHint(apiKey: string): string {
  return `****${apiKey.slice(-4)}`;
}

/** The four secrets that must never appear in any output, for scrubbing error text. */
export function bundleSecrets(bundle: XByokBundle): string[] {
  return [bundle.apiKey, bundle.apiSecret, bundle.accessToken, bundle.accessTokenSecret];
}
