// The same rule the backend applies (backend/src/platforms/nostrSigner.ts, looksLikeSecretKey): LazyRelay never accepts
// a Nostr private key. Anything that looks like one is refused here, before it is sent anywhere, and cleared from the
// form. The backend refuses it again, so this is a courtesy for the person, not the only defence.

/** True for an nsec, an encrypted ncryptsec, a bare 64 character hex secret, or a 12 to 24 word recovery phrase. A
 *  bunker:// link is never one of these. */
export function looksLikeNostrSecret(input: string): boolean {
  const text = input.trim();
  if (/nsec1[02-9ac-hj-np-z]{20,}/i.test(text) || /ncryptsec1[02-9ac-hj-np-z]{20,}/i.test(text)) return true;
  if (/^(0x)?[0-9a-f]{64}$/i.test(text)) return true;
  if (/^[a-z]+(\s+[a-z]+){11,23}$/i.test(text) && [12, 15, 18, 21, 24].includes(text.split(/\s+/).length)) return true;
  return false;
}

export const NOSTR_SECRET_MESSAGE =
  "That looks like a private key (or a recovery phrase). LazyRelay never accepts one and never needs one, so please do not paste it anywhere. Open your Nostr signer app instead (for example Amber, nsec.app or Alby), create a connection there, and paste the link that starts with bunker://.";
