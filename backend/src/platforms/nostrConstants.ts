// Nostr settings that more than one place needs. Kept in a file with no imports so that the scheduling check
// (postCreation.ts) and the platform rules lookup can use them without loading the socket and crypto code.

/** Plain text notes only (kind 1). Relays commonly cap an event at 8 to 16 KB (NIP-11 max_message_length and
 *  max_content_length), so 4,000 characters leaves room for the JSON envelope. Characters are counted the way
 *  JavaScript counts them (UTF-16 units), which already means at most 12,000 bytes; the byte cap is a backstop. */
export const NOSTR_TEXT_LIMIT = 4000;
export const NOSTR_TEXT_LIMIT_BYTES = 12_000;

/** Where a note goes when the customer has published no NIP-65 relay list (kind 10002) we can find. Large, long
 *  running public relays; changing them is a one line edit here. */
export const NOSTR_DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

/** Where the proof link points. njump.me is a third party convenience viewer, NOT the proof: the proof is the
 *  read-back by event id done in NostrAdapter.verifyPublished. If the viewer disappears, the nevent in the link still
 *  identifies the note on any Nostr client. */
export const NOSTR_PROOF_VIEWER = "https://njump.me/";
