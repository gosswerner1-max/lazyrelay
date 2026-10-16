// Message templates: read from the customer's OWN Meta account with their own token and copied into whatsapp_message_templates.
// Only an APPROVED, supported template can ever be sent. A template that vanished from Meta is disabled here (fail closed).
// The HTTP client is a fake: nothing reaches Meta.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "../testFakeSupabase.js";
import type { HttpClient } from "./cloudApi.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { normalizeTemplate, syncTemplates, listStoredTemplates } = await import("./templates.js");
const { ACC, ACC_OTHER, SA, TOKEN, seedWorld, resetTables, setTestEnv } = await import("./testKit.js");

const NOW = new Date("2026-10-16T12:00:00.000Z");
const meta = (over: Record<string, unknown> = {}) => ({
  id: "777",
  name: "welcome_offer",
  language: "en_US",
  status: "APPROVED",
  category: "MARKETING",
  components: [{ type: "BODY", text: "Hi {{1}}, enjoy {{2}} off" }],
  ...over,
});

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  tables.whatsapp_message_templates = [];
});

describe("normalizeTemplate", () => {
  it("maps an approved marketing template with two body variables", () => {
    expect(normalizeTemplate(meta())).toEqual({
      meta_template_id: "777",
      name: "welcome_offer",
      language: "en_US",
      category: "marketing",
      status: "approved",
      body_text: "Hi {{1}}, enjoy {{2}} off",
      variable_count: 2,
      supported: true,
      unsupported_reason: null,
    });
  });

  it.each([
    ["APPROVED", "approved"],
    ["PENDING", "pending"],
    ["REJECTED", "rejected"],
    ["PAUSED", "paused"],
    ["DISABLED", "disabled"],
    ["IN_APPEAL", "in_appeal"],
    ["PENDING_DELETION", "other"],
    ["something_new", "other"],
  ])("status %s -> %s (anything unknown is 'other', which can never be sent)", (from, to) => {
    expect(normalizeTemplate(meta({ status: from }))?.status).toBe(to);
  });

  it("variable_count is the highest placeholder number; no placeholders means 0", () => {
    expect(normalizeTemplate(meta({ components: [{ type: "BODY", text: "Hello" }] }))?.variable_count).toBe(0);
    expect(normalizeTemplate(meta({ components: [{ type: "BODY", text: "{{3}} {{1}}" }] }))?.variable_count).toBe(3);
  });

  it("a media header, a header or button variable, an authentication template or a template with no body is stored but unsupported", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }] }, "media_header"],
      [{ components: [{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "Hi" }] }, "header_variable"],
      [{ components: [{ type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://x.example/{{1}}" }] }] }, "button_variable"],
      [{ category: "AUTHENTICATION", components: [{ type: "BODY", text: "Code {{1}}" }] }, "authentication_not_supported"],
      [{ components: [{ type: "FOOTER", text: "bye" }] }, "no_body"],
    ];
    for (const [over, reason] of cases) {
      expect(normalizeTemplate(meta(over))).toMatchObject({ supported: false, unsupported_reason: reason });
    }
  });

  it("a plain text header and static buttons are fine", () => {
    const t = normalizeTemplate(meta({ components: [{ type: "HEADER", format: "TEXT", text: "Sale" }, { type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://x.example/sale" }, { type: "QUICK_REPLY", text: "Stop" }] }] }));
    expect(t).toMatchObject({ supported: true, unsupported_reason: null });
  });

  it("drops a template whose category is not one we can model, and a body over 1024 characters is cut", () => {
    expect(normalizeTemplate(meta({ category: "SOMETHING_ELSE" }))).toBeNull();
    expect(normalizeTemplate(meta({ components: [{ type: "BODY", text: "x".repeat(2000) }] }))?.body_text).toHaveLength(1024);
  });
});

function http(templates: unknown[], status = 200): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    http: async (url, init) => {
      calls.push(`${init.method} ${url} ${init.headers.Authorization}`);
      return { status, json: status === 200 ? { data: templates } : { error: { code: 190 } } };
    },
  };
}

describe("syncTemplates", () => {
  it("stores the customer's templates for that connection, using their token, and keeps no token in the rows", async () => {
    const h = http([meta(), meta({ id: "778", name: "pending_one", status: "PENDING" })]);
    const out = await syncTemplates(h.http, ACC, SA, NOW);
    expect(out).toEqual({ ok: true, synced: 2, approved: 1, unsupported: 0, disabled: 0 });
    expect(h.calls[0]).toContain(`Bearer ${TOKEN}`);
    expect(tables.whatsapp_message_templates).toHaveLength(2);
    expect(tables.whatsapp_message_templates[0]).toMatchObject({ account_id: ACC, social_account_id: SA, name: "welcome_offer", status: "approved", synced_at: NOW.toISOString() });
    expect(JSON.stringify(tables.whatsapp_message_templates)).not.toContain(TOKEN);
  });

  it("a second sync updates in place (no duplicates) and picks up a status change", async () => {
    await syncTemplates(http([meta()]).http, ACC, SA, NOW);
    await syncTemplates(http([meta({ status: "PAUSED" })]).http, ACC, SA, NOW);
    expect(tables.whatsapp_message_templates).toHaveLength(1);
    expect(tables.whatsapp_message_templates[0].status).toBe("paused");
  });

  it("a template that is no longer in the customer's Meta account is disabled here, so it can never be sent", async () => {
    await syncTemplates(http([meta(), meta({ id: "779", name: "old_one" })]).http, ACC, SA, NOW);
    const out = await syncTemplates(http([meta()]).http, ACC, SA, NOW);
    expect(out).toMatchObject({ ok: true, disabled: 1 });
    expect(tables.whatsapp_message_templates.find((t) => t.name === "old_one")?.status).toBe("disabled");
  });

  it("when Meta cannot be read, nothing already stored is changed", async () => {
    await syncTemplates(http([meta()]).http, ACC, SA, NOW);
    const out = await syncTemplates(http([], 401).http, ACC, SA, NOW);
    expect(out).toEqual({ ok: false, reason: "credentials" });
    expect(tables.whatsapp_message_templates[0].status).toBe("approved");
  });

  it("refuses without calling Meta when the plan is too low or the connection has no own login", async () => {
    tables.subscriptions = [];
    const h = http([meta()]);
    expect(await syncTemplates(h.http, ACC, SA, NOW)).toEqual({ ok: false, reason: "plan" });
    tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
    tables.social_accounts[0].access_token_vault_id = null;
    expect(await syncTemplates(h.http, ACC, SA, NOW)).toEqual({ ok: false, reason: "no_own_credentials" });
    expect(h.calls).toHaveLength(0);
  });

  it("a paused connection can still refresh its template list", async () => {
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: NOW.toISOString(), pause_reason: "quality" }];
    expect((await syncTemplates(http([meta()]).http, ACC, SA, NOW)).ok).toBe(true);
  });
});

describe("listStoredTemplates", () => {
  it("returns only this account's templates for the connection, in a customer-safe shape", async () => {
    await syncTemplates(http([meta()]).http, ACC, SA, NOW);
    tables.whatsapp_message_templates.push({ id: "x", account_id: ACC_OTHER, social_account_id: SA, name: "other", language: "en_US", status: "approved", category: "marketing" });
    const list = await listStoredTemplates(ACC, SA);
    expect(list.map((t) => t.name)).toEqual(["welcome_offer"]);
    expect(list[0]).toMatchObject({ name: "welcome_offer", status: "approved", category: "marketing", variableCount: 2, usable: true });
  });

  it("marks a template usable only when it is approved AND supported", async () => {
    await syncTemplates(http([meta(), meta({ id: "2", name: "media_one", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }] }), meta({ id: "3", name: "waiting", status: "PENDING" })]).http, ACC, SA, NOW);
    const list = await listStoredTemplates(ACC, SA);
    expect(Object.fromEntries(list.map((t) => [t.name, t.usable]))).toEqual({ welcome_offer: true, media_one: false, waiting: false });
  });
});
