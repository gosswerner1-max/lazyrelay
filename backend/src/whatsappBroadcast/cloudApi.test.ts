// The WhatsApp Cloud API calls a broadcast needs: send one approved template message, and list the customer's templates. Every
// test uses an injected fake HTTP client: nothing here can reach Meta or any network. The customer's token goes in the
// Authorization header only (never a URL, a body, an error or a return value), Meta's error TEXT is never returned, and a request
// that got no usable answer is reported as "no response" so the sender never retries it blindly.

import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTemplate, listTemplates, sanitizeTemplateParam, fetchHttpClient, type HttpClient } from "./cloudApi.js";
import { WHATSAPP_GRAPH_BASE } from "../platforms/whatsapp/adapter.js";
import type { WhatsAppBundle } from "../platforms/whatsapp/credentials.js";

const TOKEN = "EAAFAKEtokenFAKEtokenFAKEtoken0123456789";
const bundle: WhatsAppBundle = { systemUserToken: TOKEN, wabaId: "1234567890", phoneNumberId: "9876543210" };

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };
function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra HTTP call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { http, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("sendTemplate", () => {
  const req = { toDigits: "27821234567", templateName: "spring_offer", language: "en_US", params: ["Thandi", "20%"] };

  it("POSTs the template to the customer's own phone number id, token in the header only, and returns Meta's message id", async () => {
    const { http, calls } = fakeHttp([{ status: 200, json: { messaging_product: "whatsapp", contacts: [{ wa_id: "27821234567" }], messages: [{ id: "wamid.HBgLabc123" }] } }]);
    const out = await sendTemplate(http, bundle, req);
    expect(out).toEqual({ ok: true, wamid: "wamid.HBgLabc123" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${WHATSAPP_GRAPH_BASE}/9876543210/messages`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].init.body).not.toContain(TOKEN);
    const body = JSON.parse(calls[0].init.body!);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "27821234567",
      type: "template",
      template: { name: "spring_offer", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Thandi" }, { type: "text", text: "20%" }] }] },
    });
  });

  it("a template with no variables sends no components", async () => {
    const { http, calls } = fakeHttp([{ status: 200, json: { messages: [{ id: "wamid.X1234" }] } }]);
    await sendTemplate(http, bundle, { ...req, params: [] });
    expect(JSON.parse(calls[0].init.body!).template.components).toBeUndefined();
  });

  it("an error answer returns Meta's numeric code and the HTTP status, never its text", async () => {
    const { http } = fakeHttp([{ status: 400, json: { error: { message: "(#131050) Users number +27821234567 has opted out", type: "OAuthException", code: 131050, error_data: { details: "secret detail" } } } }]);
    const out = await sendTemplate(http, bundle, req);
    expect(out).toEqual({ ok: false, httpStatus: 400, code: 131050 });
    expect(JSON.stringify(out)).not.toMatch(/opted out|27821234567|secret/);
  });

  it("an error answer with no readable JSON still returns the HTTP status", async () => {
    const { http } = fakeHttp([{ status: 502, json: null }]);
    expect(await sendTemplate(http, bundle, req)).toEqual({ ok: false, httpStatus: 502, code: null });
  });

  it("a network failure or timeout is 'no response' (the message may have gone out)", async () => {
    const { http } = fakeHttp([new Error("socket hang up")]);
    expect(await sendTemplate(http, bundle, req)).toEqual({ ok: false, noResponse: true });
  });

  it("a 200 without a message id cannot be confirmed, so it is also 'no response'", async () => {
    const { http } = fakeHttp([{ status: 200, json: { messages: [] } }]);
    expect(await sendTemplate(http, bundle, req)).toEqual({ ok: false, noResponse: true });
    const second = fakeHttp([{ status: 200, json: { messages: [{ id: "<script>" }] } }]);
    expect(await sendTemplate(second.http, bundle, req)).toEqual({ ok: false, noResponse: true });
  });

  it("refuses a recipient that is not plain digits, before any request is made", async () => {
    const { http, calls } = fakeHttp([]);
    await expect(sendTemplate(http, bundle, { ...req, toDigits: "+27 82 123 4567" })).rejects.toThrow(/recipient/i);
    await expect(sendTemplate(http, bundle, { ...req, toDigits: "123" })).rejects.toThrow(/recipient/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses a template name or language that could change the request shape", async () => {
    const { http, calls } = fakeHttp([]);
    await expect(sendTemplate(http, bundle, { ...req, templateName: "Bad Name" })).rejects.toThrow(/template/i);
    await expect(sendTemplate(http, bundle, { ...req, language: "en US" })).rejects.toThrow(/template/i);
    expect(calls).toHaveLength(0);
  });
});

describe("sanitizeTemplateParam", () => {
  it("removes newlines and tabs and long runs of spaces (Meta rejects them in a template variable) and trims", () => {
    expect(sanitizeTemplateParam("  line one\nline two\t\tend     x ")).toBe("line one line two end x");
  });
  it("keeps ordinary text, symbols and emoji", () => {
    expect(sanitizeTemplateParam("20% off at Café ☕")).toBe("20% off at Café ☕");
  });
  it("caps at 1024 characters", () => {
    expect(sanitizeTemplateParam("a".repeat(2000))).toHaveLength(1024);
  });
});

describe("listTemplates", () => {
  const item = (n: number) => ({ id: String(1000 + n), name: `t_${n}`, language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hi {{1}}" }] });

  it("reads the customer's templates from THEIR WhatsApp Business Account with their token, following Meta's cursors", async () => {
    const { http, calls } = fakeHttp([
      { status: 200, json: { data: [item(1), item(2)], paging: { cursors: { after: "QVFIabc=" }, next: "https://graph.facebook.com/next" } } },
      { status: 200, json: { data: [item(3)], paging: { cursors: { after: "QVFIdef=" } } } },
    ]);
    const out = await listTemplates(http, bundle);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.templates.map((t) => t.name)).toEqual(["t_1", "t_2", "t_3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url.startsWith(`${WHATSAPP_GRAPH_BASE}/1234567890/message_templates?`)).toBe(true);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[1].url).toContain("after=QVFIabc%3D");
  });

  it("never follows a 'next' link Meta returns (only its cursor), and ignores a cursor with odd characters", async () => {
    const { http, calls } = fakeHttp([{ status: 200, json: { data: [item(1)], paging: { cursors: { after: "x&access_token=evil" }, next: "https://evil.example/steal" } } }]);
    const out = await listTemplates(http, bundle);
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("stops after 10 pages", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ status: 200, json: { data: [item(i)], paging: { cursors: { after: `CUR${i}` }, next: "https://graph.facebook.com/more" } } }));
    const { http, calls } = fakeHttp(pages);
    await listTemplates(http, bundle);
    expect(calls).toHaveLength(10);
  });

  it("skips entries that are not well formed instead of failing the whole sync", async () => {
    const { http } = fakeHttp([{ status: 200, json: { data: [item(1), { id: 5 }, null, "x", { ...item(2), name: "Bad Name!" }] } }]);
    const out = await listTemplates(http, bundle);
    expect(out.ok && out.templates.map((t) => t.name)).toEqual(["t_1"]);
  });

  it("reports why it failed, as a code, without Meta's text", async () => {
    const bad = fakeHttp([{ status: 401, json: { error: { code: 190, message: "token EAAFAKE expired" } } }]);
    expect(await listTemplates(bad.http, bundle)).toEqual({ ok: false, reason: "credentials" });
    const down = fakeHttp([new Error("ECONNRESET")]);
    expect(await listTemplates(down.http, bundle)).toEqual({ ok: false, reason: "unreachable" });
    const other = fakeHttp([{ status: 400, json: { error: { code: 100 } } }]);
    expect(await listTemplates(other.http, bundle)).toEqual({ ok: false, reason: "rejected" });
  });
});

describe("fetchHttpClient (the production client)", () => {
  it("never follows redirects, always has a timeout, and returns the status and parsed body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchHttpClient(`${WHATSAPP_GRAPH_BASE}/x`, { method: "GET", headers: { Authorization: "Bearer t" } });
    expect(out).toEqual({ status: 200, json: { ok: 1 } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses any host except Meta's Graph API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHttpClient("https://evil.example/x", { method: "GET", headers: {} })).rejects.toThrow(/graph/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a null body for an unreadable answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await fetchHttpClient(`${WHATSAPP_GRAPH_BASE}/x`, { method: "GET", headers: {} })).toEqual({ status: 502, json: null });
  });
});
