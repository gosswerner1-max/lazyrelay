// A Facebook or Instagram connect that Meta refused. The error's own message is a fixed, plain sentence, so every route that
// echoes err.message to the customer (the callback's JSON and redirect, finalize-selection) is safe by construction. Meta's raw
// text can echo a token, so it goes to the server log only, with the known secrets and any Meta-looking token scrubbed out.

import { scrubSecrets } from "./xApi.js";

export const META_CONNECT_FAILED_MESSAGE = "We could not finish connecting that account. Please try again, and contact support if it keeps happening.";

export class MetaConnectError extends Error {
  constructor() {
    super(META_CONNECT_FAILED_MESSAGE);
    this.name = "MetaConnectError";
  }
}

/** Meta access tokens start with EAA; also catches an access_token=... fragment. */
const META_TOKEN_PATTERN = /\bEAA[A-Za-z0-9]{12,}\b|access_token=[^&\s"']+/g;

export function scrubMetaText(text: string, secrets: string[]): string {
  return scrubSecrets(text, secrets).replace(META_TOKEN_PATTERN, "[removed]");
}

/** Logs Meta's own text (scrubbed) under `tag` and returns the error to throw. */
export function metaConnectError(tag: string, status: number, rawMessage: string | undefined, secrets: string[]): MetaConnectError {
  console.error(`[${tag}] Meta refused the call (HTTP ${status}):`, scrubMetaText(rawMessage ?? "(no error text)", secrets));
  return new MetaConnectError();
}
