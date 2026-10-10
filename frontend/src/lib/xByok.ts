// X "bring your own key": the pieces the connect page, the platform tile and their tests share.

/** The consent the customer must tick before their keys are sent. BYTE FOR BYTE what Werner approved (2026-10-10):
 *  straight apostrophes, no extra spaces. Used by the component and by its test; change it nowhere else. */
export const X_BYOK_CONSENT_TEXT =
  "I understand that by using my own custom keys, all publishing and media upload charges are billed directly to my personal X developer wallet according to X's pay-per-use consumption rates. I accept full responsibility for managing my own credit balance and agree to X's Developer terms.";

export const X_BYOK_GUIDE_URL = "/guides/x-developer-keys/";
export const X_CONNECT_PATH = "/connect/x";

export interface XKeyFields {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export const EMPTY_X_KEYS: XKeyFields = { apiKey: "", apiSecret: "", accessToken: "", accessTokenSecret: "" };

/** What the X tile does. The backend decides (GET /platforms: allowed, requiresPlan); the UI only reflects it. */
export function xTileState(info: { allowed?: boolean; requiresPlan?: string }): { kind: "connect" } | { kind: "upgrade"; label: string } {
  if (info.allowed === false) return { kind: "upgrade", label: `Upgrade to ${info.requiresPlan ?? "Pro"}` };
  return { kind: "connect" };
}

/** A badge for a connected X account whose own keys have a problem, or null when all is well. */
export function byokBadge(status: string | null | undefined): { text: string; hint: string } | null {
  if (status === "invalid") return { text: "Keys not accepted", hint: "X no longer accepts your keys. Connect X again with fresh keys." };
  if (status === "out_of_credit") return { text: "Out of X credit", hint: "Your X developer account has no credits or hit its spending limit. Add credits in the X Developer Console." };
  return null;
}

/** All four filled in (spaces do not count). */
export function xKeysComplete(k: XKeyFields): boolean {
  return Object.values(k).every((v) => v.trim().length > 0);
}
