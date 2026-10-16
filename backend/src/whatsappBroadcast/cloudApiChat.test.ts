// The free-form (service) messages of a two-way chat: text, interactive reply buttons and list messages. Only valid inside Meta's 24
// hour window (the caller checks that). Limits are from Meta's reference pages read 2026-10-16: reply buttons up to 3, id up to 256,
// title up to 20 and unique, body up to 1024; list messages up to 10 rows, button label up to 20, body up to 4096, row title up to 24,
// row id up to 200, section title up to 24. Injected fake HTTP client: nothing reaches Meta.

import { describe, it, expect } from "vitest";
import { sendText, sendInteractiveButtons, sendInteractiveList, type HttpClient } from "./cloudApi.js";
import { WHATSAPP_GRAPH_BASE } from "../platforms/whatsapp/adapter.js";
import type { WhatsAppBundle } from "../platforms/whatsapp/credentials.js";

const TOKEN = "EAAFAKEtokenFAKEtokenFAKEtoken0123456789";
const bundle: WhatsAppBundle = { systemUserToken: TOKEN, wabaId: "1234567890", phoneNumberId: "9876543210" };

function fake(response: { status: number; json: unknown } | Error = { status: 200, json: { messages: [{ id: "wamid.OUT12345" }] } }) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { http, calls };
}
const to = "27821110001";

describe("sendText", () => {
  it("POSTs a plain text message to the customer's own number id, token in the header only", async () => {
    const f = fake();
    expect(await sendText(f.http, bundle, { toDigits: to, text: "Your proof is ready." })).toEqual({ ok: true, wamid: "wamid.OUT12345" });
    expect(f.calls[0].url).toBe(`${WHATSAPP_GRAPH_BASE}/9876543210/messages`);
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0].init.body).not.toContain(TOKEN);
    expect(JSON.parse(f.calls[0].init.body!)).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: "Your proof is ready." } });
  });

  it("refuses an empty text, a text over 4096 characters, or a bad recipient, before any request", async () => {
    const f = fake();
    await expect(sendText(f.http, bundle, { toDigits: to, text: "   " })).rejects.toThrow(/text/i);
    await expect(sendText(f.http, bundle, { toDigits: to, text: "x".repeat(4097) })).rejects.toThrow(/text/i);
    await expect(sendText(f.http, bundle, { toDigits: "+27 82", text: "hi" })).rejects.toThrow(/recipient/i);
    expect(f.calls).toHaveLength(0);
  });

  it("reports Meta's numeric code only, and no-answer as noResponse", async () => {
    expect(await sendText(fake({ status: 400, json: { error: { code: 131047, message: "secret" } } }).http, bundle, { toDigits: to, text: "hi" })).toEqual({ ok: false, httpStatus: 400, code: 131047 });
    expect(await sendText(fake(new Error("reset")).http, bundle, { toDigits: to, text: "hi" })).toEqual({ ok: false, noResponse: true });
  });
});

describe("sendInteractiveButtons", () => {
  const options = [
    { id: "approve", title: "Approve" },
    { id: "changes", title: "Request changes" },
    { id: "question", title: "Question" },
  ];

  it("sends up to three reply buttons with their ids and titles", async () => {
    const f = fake();
    expect(await sendInteractiveButtons(f.http, bundle, { toDigits: to, body: "Please approve the logo proof.", options })).toEqual({ ok: true, wamid: "wamid.OUT12345" });
    expect(JSON.parse(f.calls[0].init.body!)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Please approve the logo proof." },
        action: { buttons: options.map((o) => ({ type: "reply", reply: { id: o.id, title: o.title } })) },
      },
    });
  });

  it.each([
    ["no buttons", { options: [] }],
    ["four buttons", { options: [...options, { id: "d", title: "Fourth" }] }],
    ["a title over 20 characters", { options: [{ id: "a", title: "x".repeat(21) }] }],
    ["an empty title", { options: [{ id: "a", title: " " }] }],
    ["an id over 256 characters", { options: [{ id: "i".repeat(257), title: "Ok" }] }],
    ["an empty id", { options: [{ id: "", title: "Ok" }] }],
    ["duplicate titles", { options: [{ id: "a", title: "Same" }, { id: "b", title: "same" }] }],
    ["duplicate ids", { options: [{ id: "a", title: "One" }, { id: "a", title: "Two" }] }],
    ["an empty body", { body: " " }],
    ["a body over 1024 characters", { body: "x".repeat(1025) }],
  ])("refuses %s before any request", async (_label, over) => {
    const f = fake();
    await expect(sendInteractiveButtons(f.http, bundle, { toDigits: to, body: "Body", options, ...over })).rejects.toThrow(/button|body|option/i);
    expect(f.calls).toHaveLength(0);
  });
});

describe("sendInteractiveList", () => {
  const sections = [{ title: "Updates", rows: [{ id: "r1", title: "Design", description: "Logo and colours" }, { id: "r2", title: "Content" }] }];

  it("sends a list with a button label, sections and rows", async () => {
    const f = fake();
    expect(await sendInteractiveList(f.http, bundle, { toDigits: to, body: "Pick a topic", buttonLabel: "Topics", sections })).toEqual({ ok: true, wamid: "wamid.OUT12345" });
    expect(JSON.parse(f.calls[0].init.body!).interactive).toEqual({
      type: "list",
      body: { text: "Pick a topic" },
      action: { button: "Topics", sections: [{ title: "Updates", rows: [{ id: "r1", title: "Design", description: "Logo and colours" }, { id: "r2", title: "Content" }] }] },
    });
  });

  it.each([
    ["no rows", { sections: [{ title: "S", rows: [] }] }],
    ["more than 10 rows in all", { sections: [{ title: "S", rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` })) }] }],
    ["a row title over 24 characters", { sections: [{ title: "S", rows: [{ id: "r", title: "x".repeat(25) }] }] }],
    ["a row id over 200 characters", { sections: [{ title: "S", rows: [{ id: "i".repeat(201), title: "Ok" }] }] }],
    ["a row description over 72 characters", { sections: [{ title: "S", rows: [{ id: "r", title: "Ok", description: "d".repeat(73) }] }] }],
    ["a section title over 24 characters", { sections: [{ title: "s".repeat(25), rows: [{ id: "r", title: "Ok" }] }] }],
    ["a button label over 20 characters", { buttonLabel: "b".repeat(21) }],
    ["an empty button label", { buttonLabel: " " }],
    ["a body over 4096 characters", { body: "x".repeat(4097) }],
    ["more than 10 sections", { sections: Array.from({ length: 11 }, (_, i) => ({ title: `S${i}`, rows: [{ id: `r${i}`, title: "Ok" }] })) }],
  ])("refuses %s before any request", async (_label, over) => {
    const f = fake();
    await expect(sendInteractiveList(f.http, bundle, { toDigits: to, body: "Body", buttonLabel: "Open", sections, ...over })).rejects.toThrow(/list|row|section|button|body/i);
    expect(f.calls).toHaveLength(0);
  });
});
