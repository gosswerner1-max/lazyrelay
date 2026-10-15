// WhatsApp, "bring your own key" only. LazyRelay has no WhatsApp app, no WhatsApp token and no environment credential:
// the customer links THEIR Meta WhatsApp Business Account and phone number, and Meta bills that account directly, so
// LazyRelay's own cost for the channel is nothing beyond the HTTP calls it makes.
//
// This adapter is STATELESS. It holds no credential and reads none from process.env. The customer's system user token
// lives encrypted in Supabase Vault (social_accounts.access_token_vault_id, written through store_social_token, see
// routes/whatsappByok.routes.ts). The scheduler decrypts it at run time (scheduler.ts getAccessToken, read_social_token,
// service role only) and hands it to every call as the "access token" string, which is a small JSON login
// (credentials.ts). Each call parses that login, uses it for that one call and drops it. Nothing is cached, logged or
// put in an error.
//
// There is no OAuth redirect and no refresh: getAuthorizeUrl and exchangeCode exist only because the PlatformAdapter
// interface requires them, and the connection is made through POST /social-accounts/whatsapp/byok.
//
// SCAFFOLD, WHAT IS BUILT AND WHAT IS NOT:
//   built:      verifyCredentials (proves the three values with Meta and returns the number's verified name), the
//               stored-login parsing, the connect route, the plan gate, the migration.
//   NOT built:  sending. post() does not call Meta. WhatsApp's Cloud API is not a "publish a post" API: a business-
//               initiated message goes to a named, opted-in recipient and, outside a 24 hour customer-service window,
//               has to be an approved message template. A LazyRelay post has no recipient and no template, so what a
//               "WhatsApp post" is (a broadcast list, a template picker, an opt-in record) is a product decision that
//               does not exist yet. Until it does, post() fails with a fixed, fatal code instead of guessing.
//   NOT proven: verifyCredentials has been run against mocks only. It has NOT been run against Meta's live Graph API.

import type { PlatformAdapter, PostRequest, PostAttemptResult, VerifyResult, OAuthExchangeResult } from "../types.js";
import { parseWhatsAppBundle, WHATSAPP_BUNDLE_INVALID_CODE, WHATSAPP_SEND_NOT_BUILT_CODE, type WhatsAppBundle } from "./credentials.js";

/** Same Graph API version the Facebook and Instagram adapters use. The host is fixed: a customer never supplies a URL,
 *  only numeric ids that are validated before they reach a path. */
export const WHATSAPP_GRAPH_BASE = "https://graph.facebook.com/v25.0";
const REQUEST_TIMEOUT_MS = 10_000;

const CONNECT_ELSEWHERE = "WhatsApp is connected with your own Meta credentials from Social Platforms, not through a sign-in redirect.";

export type WhatsAppCheck =
  | { ok: true; phoneNumberId: string; verifiedName: string | null; displayPhoneNumber: string | null }
  | { ok: false; reason: "invalid" | "forbidden" | "not_found" | "rate_limited" | "unreachable" };

type FailureReason = Extract<WhatsAppCheck, { ok: false }>["reason"];

interface GraphError {
  error?: { code?: number; type?: string };
}
interface PhoneNumberResponse extends GraphError {
  id?: string;
  verified_name?: string;
  display_phone_number?: string;
}
interface PhoneNumbersResponse extends GraphError {
  data?: Array<{ id?: string }>;
}

/** Meta's error CODE (a number), never its message text, decides the reason: the text can echo request details. */
function reasonFor(status: number, json: GraphError | null): FailureReason {
  const code = json?.error?.code;
  if (status === 401 || code === 190) return "invalid";
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80007) return "rate_limited";
  if (status === 403 || code === 10 || (typeof code === "number" && code >= 200 && code <= 299)) return "forbidden";
  if (code === 100 || status === 404) return "not_found";
  return status >= 500 ? "unreachable" : "invalid";
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform: "whatsapp" = "whatsapp";
  /** The customer's own credentials, billed by Meta to them (see the header). */
  readonly byok = true;
  /** The customer typed the account themselves: there is nothing to confirm after the credentials check out. */
  readonly skipConnectConfirmation = true;

  /** `fetchImpl` exists so tests can run with no network; production uses the global fetch. */
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  async getAuthorizeUrl(): Promise<string> {
    throw new Error(CONNECT_ELSEWHERE);
  }

  async exchangeCode(): Promise<OAuthExchangeResult> {
    throw new Error(CONNECT_ELSEWHERE);
  }

  /** One authenticated GET. The token goes in the Authorization header, never in the URL (URLs end up in logs). */
  private async get(path: string, token: string): Promise<{ res: Response; json: unknown } | null> {
    try {
      const res = await this.fetchImpl(`${WHATSAPP_GRAPH_BASE}/${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { res, json: await readJson(res) };
    } catch {
      return null;
    }
  }

  /** Proves the three values with Meta: the token can read the phone number, and that number belongs to the stated
   *  WhatsApp Business Account. Used by the connect route; the result never carries Meta's body or any value. */
  async verifyCredentials(bundle: WhatsAppBundle): Promise<WhatsAppCheck> {
    const phone = await this.get(`${bundle.phoneNumberId}?fields=verified_name,display_phone_number`, bundle.systemUserToken);
    if (!phone) return { ok: false, reason: "unreachable" };
    const phoneJson = phone.json as PhoneNumberResponse | null;
    if (!phone.res.ok) return { ok: false, reason: reasonFor(phone.res.status, phoneJson) };
    if (phoneJson?.id !== bundle.phoneNumberId) return { ok: false, reason: "not_found" };

    // The number must belong to the WABA the customer named, so the two ids the row stores can never disagree.
    const owned = await this.get(`${bundle.wabaId}/phone_numbers?fields=id&limit=200`, bundle.systemUserToken);
    if (!owned) return { ok: false, reason: "unreachable" };
    const ownedJson = owned.json as PhoneNumbersResponse | null;
    if (!owned.res.ok) return { ok: false, reason: reasonFor(owned.res.status, ownedJson) };
    if (!ownedJson?.data?.some((n) => n.id === bundle.phoneNumberId)) return { ok: false, reason: "not_found" };

    return {
      ok: true,
      phoneNumberId: bundle.phoneNumberId,
      verifiedName: phoneJson.verified_name?.trim() || null,
      displayPhoneNumber: phoneJson.display_phone_number?.trim() || null,
    };
  }

  /** Sending is not built (see the header). Parses the login first so a damaged one reports the right reason, then
   *  stops WITHOUT calling Meta. */
  async post(request: PostRequest): Promise<PostAttemptResult> {
    const bundle = parseWhatsAppBundle(request.accessToken);
    if (!bundle) return { success: false, platformPostId: null, errorMessage: WHATSAPP_BUNDLE_INVALID_CODE };
    return { success: false, platformPostId: null, errorMessage: WHATSAPP_SEND_NOT_BUILT_CODE };
  }

  /** Nothing is ever posted, so nothing can be confirmed. */
  async verifyPublished(_platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const bundle = parseWhatsAppBundle(accessToken);
    return {
      verifiedLive: false,
      platformPostUrl: null,
      errorMessage: bundle ? WHATSAPP_SEND_NOT_BUILT_CODE : WHATSAPP_BUNDLE_INVALID_CODE,
    };
  }
}
