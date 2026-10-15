// The WhatsApp BYOK adapter and its stored login. Everything here runs against a stubbed fetch: no network, and Meta's
// real Graph API is NOT exercised. That is stated on purpose: these tests prove LazyRelay's side of the contract (what
// is sent, what is never sent, how answers map to reasons, that nothing is kept between calls), not Meta's behaviour.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WhatsAppAdapter, WHATSAPP_GRAPH_BASE } from "./adapter.js";
import {
  META_ID_PATTERN,
  parseWhatsAppBundle,
  serializeWhatsAppBundle,
  whatsappKeyHint,
  WHATSAPP_BUNDLE_INVALID_CODE,
  WHATSAPP_SEND_NOT_BUILT_CODE,
  type WhatsAppBundle,
} from "./credentials.js";
import { classifyPostError } from "../../postErrors.js";
import type { PostRequest } from "../types.js";

// Fake values that merely look the right shape. None is a real Meta credential.
export const WA_TEST_TOKEN = "test_whatsapp_system_user_token_not_real_0123456789";
const WABA = "123456789012345";
const PHONE = "109876543210987";
const BUNDLE: WhatsAppBundle = { systemUserToken: WA_TEST_TOKEN, wabaId: WABA, phoneNumberId: PHONE };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call {
  url: string;
  auth: string | null;
}
function metaStub(answers: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const phoneOk = () => json({ id: PHONE, verified_name: "Acme Cafe", display_phone_number: "+27 82 000 0000" });
const wabaOk = () => json({ data: [{ id: "999999999999999" }, { id: PHONE }] });

afterEach(() => vi.restoreAllMocks());

describe("the stored login", () => {
  it("round-trips, and is a small versioned JSON string", () => {
    const stored = serializeWhatsAppBundle(BUNDLE);
    expect(JSON.parse(stored)).toEqual({ v: 1, systemUserToken: WA_TEST_TOKEN, wabaId: WABA, phoneNumberId: PHONE });
    expect(parseWhatsAppBundle(stored)).toEqual(BUNDLE);
  });

  it("carries an optional app secret additively: absent changes nothing, a good one round-trips, a malformed one is dropped, not fatal", () => {
    const SECRET = "AppSecretNotReal0123456789abcdefAB";
    expect(JSON.parse(serializeWhatsAppBundle({ ...BUNDLE, appSecret: SECRET }))).toEqual({ v: 1, systemUserToken: WA_TEST_TOKEN, wabaId: WABA, phoneNumberId: PHONE, appSecret: SECRET });
    expect(parseWhatsAppBundle(serializeWhatsAppBundle({ ...BUNDLE, appSecret: SECRET }))).toEqual({ ...BUNDLE, appSecret: SECRET });
    // an old stored bundle (no appSecret key) still parses to exactly what it did before
    expect(parseWhatsAppBundle(JSON.stringify({ v: 1, systemUserToken: WA_TEST_TOKEN, wabaId: WABA, phoneNumberId: PHONE }))).toEqual(BUNDLE);
    const good = JSON.parse(serializeWhatsAppBundle(BUNDLE));
    for (const bad of ["short", "has spaces 0123456789abc", 12345678901234567890, "a".repeat(100), "", null]) {
      expect(parseWhatsAppBundle(JSON.stringify({ ...good, appSecret: bad })), String(bad)).toEqual(BUNDLE);
    }
  });

  it("rejects anything that is not a complete, well formed version 1 login, and never throws", () => {
    const good = JSON.parse(serializeWhatsAppBundle(BUNDLE));
    const bad: unknown[] = [
      null,
      undefined,
      "",
      "not json",
      "{broken",
      WA_TEST_TOKEN, // a bare token, as an OAuth platform would store it
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, systemUserToken: "short" }),
      JSON.stringify({ ...good, systemUserToken: "has spaces in the token value 0123456789" }),
      JSON.stringify({ ...good, wabaId: "12ab" }),
      JSON.stringify({ ...good, phoneNumberId: "not-numeric-id" }),
      JSON.stringify({ ...good, wabaId: undefined }),
      JSON.stringify({ ...good, phoneNumberId: 109876543210987 }), // a number, not a string
    ];
    for (const stored of bad) expect(parseWhatsAppBundle(stored as string), String(stored)).toBeNull();
  });

  it("Meta ids are numeric strings", () => {
    expect(META_ID_PATTERN.test(WABA)).toBe(true);
    for (const v of ["", "1234", "abc12345", "123 456 789", "1234567890123456789012345678"]) expect(META_ID_PATTERN.test(v), v).toBe(false);
  });

  it("the display hint is the end of the phone number id, fits the 8 character column and never shows the token", () => {
    const hint = whatsappKeyHint(PHONE);
    expect(hint).toBe("****0987");
    expect(hint.length).toBeLessThanOrEqual(8);
    expect(hint).not.toContain(WA_TEST_TOKEN.slice(-4));
  });
});

describe("adapter shape", () => {
  it("is bring-your-own-key, has no sign-in redirect, and needs nothing from the environment", async () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter.platform).toBe("whatsapp");
    expect(adapter.byok).toBe(true);
    expect(adapter.skipConnectConfirmation).toBe(true);
    await expect(adapter.getAuthorizeUrl()).rejects.toThrow(/own Meta credentials/);
    await expect(adapter.exchangeCode()).rejects.toThrow(/own Meta credentials/);
  });

  it("holds no credential and reads no environment variable: no process.env in the adapter or the login helpers", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ["adapter.ts", "credentials.ts"]) {
      const code = readFileSync(join(here, file), "utf8")
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(code, file).not.toMatch(/process\.env/);
    }
  });

  it("can be built with no arguments at all (the registry gives it nothing)", () => {
    expect(() => new WhatsAppAdapter()).not.toThrow();
  });
});

describe("verifyCredentials", () => {
  it("proves the token can read the phone number, then that the number belongs to the stated WABA", async () => {
    const meta = metaStub([phoneOk, wabaOk]);
    const check = await new WhatsAppAdapter(meta.fetchImpl).verifyCredentials(BUNDLE);
    expect(check).toEqual({ ok: true, phoneNumberId: PHONE, verifiedName: "Acme Cafe", displayPhoneNumber: "+27 82 000 0000" });
    expect(meta.calls).toHaveLength(2);
    expect(meta.calls[0].url).toBe(`${WHATSAPP_GRAPH_BASE}/${PHONE}?fields=verified_name,display_phone_number`);
    expect(meta.calls[1].url).toBe(`${WHATSAPP_GRAPH_BASE}/${WABA}/phone_numbers?fields=id&limit=200`);
  });

  it("only ever talks to graph.facebook.com, with the token in the Authorization header and never in a URL", async () => {
    const meta = metaStub([phoneOk, wabaOk]);
    await new WhatsAppAdapter(meta.fetchImpl).verifyCredentials(BUNDLE);
    for (const c of meta.calls) {
      expect(new URL(c.url).host).toBe("graph.facebook.com");
      expect(c.url).not.toContain(WA_TEST_TOKEN);
      expect(c.url).not.toMatch(/access_token/i);
      expect(c.auth).toBe(`Bearer ${WA_TEST_TOKEN}`);
    }
  });

  const reasons: Array<[string, () => Response, string]> = [
    ["HTTP 401", () => json({}, 401), "invalid"],
    ["OAuth error code 190 (token expired or revoked)", () => json({ error: { code: 190, type: "OAuthException" } }, 400), "invalid"],
    ["permission error code 10", () => json({ error: { code: 10 } }, 400), "forbidden"],
    ["permission error code 200", () => json({ error: { code: 200 } }, 403), "forbidden"],
    ["HTTP 429", () => json({}, 429), "rate_limited"],
    ["throttle error code 4", () => json({ error: { code: 4 } }, 400), "rate_limited"],
    ["throttle error code 80007", () => json({ error: { code: 80007 } }, 400), "rate_limited"],
    ["unknown id, code 100", () => json({ error: { code: 100 } }, 400), "not_found"],
    ["HTTP 404", () => json({}, 404), "not_found"],
    ["HTTP 500", () => json({}, 500), "unreachable"],
    ["an unrecognised 400", () => json({ error: { code: 12345 } }, 400), "invalid"],
  ];
  for (const [label, reply, reason] of reasons) {
    it(`maps ${label} on the first call to "${reason}"`, async () => {
      const check = await new WhatsAppAdapter(metaStub([reply]).fetchImpl).verifyCredentials(BUNDLE);
      expect(check).toEqual({ ok: false, reason });
    });
  }

  it("a network failure is 'unreachable', on either call", async () => {
    const boom = (): Response => {
      throw new Error(`network down for ${WA_TEST_TOKEN}`);
    };
    expect(await new WhatsAppAdapter(metaStub([boom]).fetchImpl).verifyCredentials(BUNDLE)).toEqual({ ok: false, reason: "unreachable" });
    expect(await new WhatsAppAdapter(metaStub([phoneOk, boom]).fetchImpl).verifyCredentials(BUNDLE)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("refuses a phone number that Meta answers with a different id", async () => {
    const meta = metaStub([() => json({ id: "555555555555555", verified_name: "Someone Else" })]);
    expect(await new WhatsAppAdapter(meta.fetchImpl).verifyCredentials(BUNDLE)).toEqual({ ok: false, reason: "not_found" });
    expect(meta.calls).toHaveLength(1); // stopped before the second call
  });

  it("refuses a phone number that is not in the stated WhatsApp Business Account", async () => {
    const meta = metaStub([phoneOk, () => json({ data: [{ id: "999999999999999" }] })]);
    expect(await new WhatsAppAdapter(meta.fetchImpl).verifyCredentials(BUNDLE)).toEqual({ ok: false, reason: "not_found" });
    const empty = metaStub([phoneOk, () => json({})]);
    expect(await new WhatsAppAdapter(empty.fetchImpl).verifyCredentials(BUNDLE)).toEqual({ ok: false, reason: "not_found" });
  });

  it("maps a failure on the second call the same way", async () => {
    expect(await new WhatsAppAdapter(metaStub([phoneOk, () => json({ error: { code: 10 } }, 400)]).fetchImpl).verifyCredentials(BUNDLE)).toEqual({ ok: false, reason: "forbidden" });
  });

  it("no result ever carries the token or Meta's own text", async () => {
    const meta = metaStub([() => json({ error: { code: 190, message: `Invalid token ${WA_TEST_TOKEN}` } }, 401)]);
    const check = await new WhatsAppAdapter(meta.fetchImpl).verifyCredentials(BUNDLE);
    expect(JSON.stringify(check)).not.toContain(WA_TEST_TOKEN);
    expect(JSON.stringify(check)).not.toMatch(/Invalid token/);
  });

  it("is stateless: each call uses the login it was given and keeps nothing for the next", async () => {
    const meta = metaStub([phoneOk, wabaOk, () => json({ id: "222222222222222" }), () => json({ data: [{ id: "222222222222222" }] })]);
    const adapter = new WhatsAppAdapter(meta.fetchImpl);
    const other: WhatsAppBundle = { systemUserToken: "another_fake_system_user_token_value_9876543210", wabaId: "888888888888888", phoneNumberId: "222222222222222" };
    await adapter.verifyCredentials(BUNDLE);
    await adapter.verifyCredentials(other);
    expect(meta.calls.map((c) => c.auth)).toEqual([
      `Bearer ${BUNDLE.systemUserToken}`,
      `Bearer ${BUNDLE.systemUserToken}`,
      `Bearer ${other.systemUserToken}`,
      `Bearer ${other.systemUserToken}`,
    ]);
  });
});

describe("sending is not built: post() and verifyPublished() never call Meta", () => {
  const request = (accessToken: string): PostRequest => ({ socialAccountId: "sa1", content: "hello", mediaUrl: null, coverImageUrl: null, accessToken }) as PostRequest;

  it("reports the fixed not-built code for a good stored login, without any network call", async () => {
    const meta = metaStub([phoneOk]);
    const adapter = new WhatsAppAdapter(meta.fetchImpl);
    expect(await adapter.post(request(serializeWhatsAppBundle(BUNDLE)))).toEqual({ success: false, platformPostId: null, errorMessage: WHATSAPP_SEND_NOT_BUILT_CODE });
    expect(await adapter.verifyPublished("anything", serializeWhatsAppBundle(BUNDLE))).toEqual({ verifiedLive: false, platformPostUrl: null, errorMessage: WHATSAPP_SEND_NOT_BUILT_CODE });
    expect(meta.calls).toHaveLength(0);
  });

  it("reports the bundle-invalid code for a damaged or non-WhatsApp login", async () => {
    const meta = metaStub([phoneOk]);
    const adapter = new WhatsAppAdapter(meta.fetchImpl);
    for (const stored of ["", "plain-oauth-token", "{}", '{"v":1}']) {
      expect(await adapter.post(request(stored))).toEqual({ success: false, platformPostId: null, errorMessage: WHATSAPP_BUNDLE_INVALID_CODE });
      expect((await adapter.verifyPublished("x", stored)).errorMessage).toBe(WHATSAPP_BUNDLE_INVALID_CODE);
    }
    expect(meta.calls).toHaveLength(0);
  });

  it("the error text never contains the token", async () => {
    const out = await new WhatsAppAdapter(metaStub([phoneOk]).fetchImpl).post(request(serializeWhatsAppBundle(BUNDLE)));
    expect(JSON.stringify(out)).not.toContain(WA_TEST_TOKEN);
  });
});

describe("how those codes are classified", () => {
  it("not-built is fatal: it never retries and never counts toward the shared circuit breaker", () => {
    const c = classifyPostError("whatsapp", WHATSAPP_SEND_NOT_BUILT_CODE);
    expect(c.kind).toBe("fatal");
    expect(c.message).toMatch(/not available yet/i);
    expect(c.message).toMatch(/Nothing was sent/i);
  });

  it("a damaged login asks the customer to reconnect", () => {
    const c = classifyPostError("whatsapp", WHATSAPP_BUNDLE_INVALID_CODE);
    expect(c.kind).toBe("reconnect");
    expect(c.message).toMatch(/Reconnect WhatsApp/);
  });

  it("a Meta app-secret style error is never blamed on LazyRelay for a customer's own WhatsApp credentials", () => {
    expect(classifyPostError("whatsapp", "invalid_client app secret").kind).not.toBe("ours");
  });
});
