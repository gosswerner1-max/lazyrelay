// Competitor mode, the thin client side. It checks the pasted link, sends it to the companion service for reading and
// building a blueprint, and turns every answer into plain words. Nothing here reads a page: the reading and the blueprint
// happen in the companion service. Nothing is saved anywhere; the customer reads the blueprint and can copy it.
// Only the lazily loaded competitor section imports this file, and only when VITE_COMPETITOR_MODE_ENABLED is "true".

import { readBlueprint, type CompetitorBlueprint } from "./competitorBlueprint";
import { ContentSourcesError, URL_MAX_LENGTH, hostIsInternal } from "./contentSources";

/** The screen gives up after this long and says so. It never waits on a spinner. */
export const ANALYZE_TIMEOUT_MS = 90_000;

export const CONSENT_TEXT = "AI can make mistakes. I confirm this tool is used for public market analysis and research purposes.";
export const CLOSED_NETWORK_MESSAGE = "This network blocks public reading, so we can't analyze it. Paste a page from their website instead.";
export const VIDEO_NOT_SUPPORTED_MESSAGE = "Blueprints work on web pages and posts for now. Paste a page from their website.";
export const BLUEPRINT_FAILED_MESSAGE = "We could not build a blueprint for that page, try another page";

export interface CompetitorClient {
  /** Reads the page and builds a blueprint. Rejects with a CompetitorError and nothing else. */
  blueprint(input: string, signal?: AbortSignal, idempotencyKey?: string): Promise<CompetitorBlueprint>;
}

// ---------- The pasted link ----------

const CLOSED_NETWORKS = [
  "tiktok.com",
  "instagram.com",
  "instagr.am",
  "facebook.com",
  "fb.com",
  "fb.watch",
  "fb.me",
  "x.com",
  "twitter.com",
  "t.co",
  "linkedin.com",
  "lnkd.in",
];

const isClosedNetwork = (hostname: string) => {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  return CLOSED_NETWORKS.some((d) => host === d || host.endsWith(`.${d}`));
};

const VIDEO_SITES = ["youtube.com", "youtu.be", "youtube-nocookie.com"];

const isVideoSite = (hostname: string) => {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  return VIDEO_SITES.some((d) => host === d || host.endsWith(`.${d}`));
};

export type InputCheck = { ok: true; input: string } | { ok: false; error: string; closedNetwork?: true; videoLink?: true };

const reject = (error: string): InputCheck => ({ ok: false, error });

/** The link box's rules. The service checks everything again; this spares the customer a round trip and keeps closed networks off the wire. */
export function normalizeCompetitorInput(raw: string): InputCheck {
  const value = raw.trim();
  if (!value) return reject("Paste a competitor link or website first.");
  if (value.length > URL_MAX_LENGTH) return reject(`That link is too long. Use ${URL_MAX_LENGTH} characters or fewer.`);
  const withScheme = value.includes("://") ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return reject("That does not look like a website. Paste a full link, for example https://example.com/page");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return reject("Use a web link that starts with https://");
  if (parsed.username || parsed.password) return reject("Remove the username and password from the link.");
  if (isClosedNetwork(parsed.hostname)) return { ok: false, error: CLOSED_NETWORK_MESSAGE, closedNetwork: true };
  if (isVideoSite(parsed.hostname)) return { ok: false, error: VIDEO_NOT_SUPPORTED_MESSAGE, videoLink: true };
  if (hostIsInternal(parsed.hostname) || !parsed.hostname.includes(".")) return reject("Use the public address of a website, not a private or local one.");
  return { ok: true, input: withScheme };
}

// ---------- Plain words for errors ----------
// Only the stable code is read, and every sentence the customer sees is written here. The one exception is
// network_not_supported, where the service's own sentence is used (short, plain text only), with the built in sentence as backup.

const MESSAGES = {
  not_connected: "This feature is not switched on yet.",
  competitor_mode_unavailable: "This feature is not switched on yet.",
  sign_in: "Please sign in again to analyze a page.",
  try_later: "This is busy right now. Please try again in a moment.",
  network: "We could not reach the service. Check your connection and try again.",
  timeout: "That took too long, so we stopped. Please try again, or try a different page.",
  bad_response: "We got an answer we could not read. Please try again in a moment.",
  unknown: "Something went wrong. Please try again in a moment.",
  unavailable: "We could not do that right now. Please try again in a moment.",
  network_not_supported: CLOSED_NETWORK_MESSAGE,
  plan_limit: "You have reached the limit on your plan. Upgrade your plan to analyze more pages.",
  cooldown: "Please wait a moment before analyzing another page, then try again.",
  daily_limit: "You have reached today's limit. Please come back tomorrow.",
  rate_limited: "Too many requests. Please wait a moment and try again.",
  page_blocked: "That page does not let us read it. Try a different page from their website.",
  reader_timeout: "That page took too long to read. Please try again, or try a different page.",
  reader_unavailable: "We could not read pages right now. Please try again in a moment.",
  blueprint_not_supported: VIDEO_NOT_SUPPORTED_MESSAGE,
  blueprint_failed: BLUEPRINT_FAILED_MESSAGE,
  invalid_input: "We could not use that link. Paste the full address of a public web page, for example https://example.com/page.",
} as const;

/** The codes the paid (credits) route adds. Their sentences live with that route, so a build without it carries none of them. */
export type BillingErrorCode = "insufficient_credits" | "in_flight" | "idempotency_conflict" | "already_charged";
export type CompetitorErrorCode = keyof typeof MESSAGES | BillingErrorCode;

/** The only error the client rejects with. A stable code and a plain sentence, never a token, a key or service text. */
export class CompetitorError extends Error {
  readonly code: CompetitorErrorCode;

  constructor(code: CompetitorErrorCode, message?: string) {
    super(message ?? MESSAGES[code as keyof typeof MESSAGES] ?? MESSAGES.unknown);
    this.name = "CompetitorError";
    this.code = code;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const CODE_WORD = /^[a-z][a-z0-9_]{0,39}$/;
const SERVER_SENTENCE_MAX = 200;

function codeFromStatus(status: number): CompetitorErrorCode {
  if (status === 400) return "invalid_input";
  if (status === 401) return "sign_in";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "unknown";
}

function plainServerSentence(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v.replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  return text !== "" && text.length <= SERVER_SENTENCE_MAX ? text : null;
}

/** A service code plus the HTTP status turned into the one error this page shows. Shared with the paid route. */
export function errorFor(code: string | undefined, status: number, serverMessage: unknown): CompetitorError {
  if (code === undefined) return new CompetitorError(codeFromStatus(status));
  if (code === "network_not_supported") return new CompetitorError("network_not_supported", plainServerSentence(serverMessage) ?? CLOSED_NETWORK_MESSAGE);
  if (code === "blueprint_not_supported") return new CompetitorError("blueprint_not_supported");
  if (code.startsWith("draft_") || code.startsWith("blueprint_")) return new CompetitorError("blueprint_failed");
  if (code.startsWith("invalid_") || code === "bad_request") return new CompetitorError("invalid_input");
  if (Object.hasOwn(MESSAGES, code) && code !== "unknown" && code !== "blueprint_failed") return new CompetitorError(code as CompetitorErrorCode);
  return new CompetitorError(codeFromStatus(status)); // a code this page does not know: the status decides
}

async function errorFromResponse(res: Response): Promise<CompetitorError> {
  let code: string | undefined;
  let message: unknown;
  try {
    const body: unknown = await res.json();
    const inner = isObject(body) && isObject(body.error) ? body.error : body;
    if (isObject(inner) && typeof inner.code === "string" && CODE_WORD.test(inner.code)) code = inner.code;
    if (isObject(inner)) message = inner.message;
  } catch {
    code = undefined; // not JSON (a gateway page, for example): the status below still decides, so nothing is hidden
  }
  return errorFor(code, res.status, message);
}

function fromSession(err: ContentSourcesError): CompetitorError {
  if (err.code === "not_connected") return new CompetitorError("not_connected");
  if (err.code === "sign_in") return new CompetitorError("sign_in");
  if (err.code === "try_later") return new CompetitorError("try_later");
  if (err.code === "network") return new CompetitorError("network");
  return new CompetitorError("unavailable");
}

// ---------- Reading the service's answer ----------

const bad = () => new CompetitorError("bad_response");
function readAnswer(v: unknown): CompetitorBlueprint {
  const result = readBlueprint(v);
  if (!result) throw bad();
  return result;
}

// ---------- The service client ----------

function checkedBase(raw: string): string {
  const text = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("The competitor service address is not a web address.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The competitor service address must be a plain https address.");
  }
  return text;
}

/** Bearer token on the call, JSON, no cookies. Every failure is a CompetitorError; nothing from a response body but its code is kept. */
export function createCompetitorClient(opts: {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Called when the service answers 401, so the caller can drop the token it kept. */
  onUnauthorized?: () => void;
}): CompetitorClient {
  const base = checkedBase(opts.baseUrl);
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  async function token(): Promise<string> {
    try {
      return await opts.getToken();
    } catch (err) {
      if (err instanceof ContentSourcesError) throw fromSession(err);
      console.error(err); // not one of ours: the raw error stays in the console, the customer gets the plain line
      throw new CompetitorError("unknown");
    }
  }

  return {
    async blueprint(input, signal) {
      const bearer = await token();
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/blueprint`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" },
          credentials: "omit",
          cache: "no-store",
          body: JSON.stringify({ input }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new CompetitorError("timeout");
        console.error(err); // the raw error stays visible in the console; it never holds the token
        throw new CompetitorError("network");
      }
      if (res.status === 401) opts.onUnauthorized?.();
      if (!res.ok) throw await errorFromResponse(res);
      try {
        return readAnswer(await res.json());
      } catch (err) {
        if (err instanceof CompetitorError) throw err;
        throw bad(); // the answer is not JSON; nothing from it is echoed
      }
    },
  };
}
