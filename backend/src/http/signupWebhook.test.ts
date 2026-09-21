import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// A tiny in-memory stand-in for the one table the handler touches. It only
// implements the exact chain signupWebhook.ts uses, and — importantly — the
// same atomic semantics as the real thing: an UPDATE ... WHERE
// welcome_email_sent_at IS NULL only matches (and changes) a row that is
// still un-welcomed.
type Row = { id: string; email: string | null; created_at: string; welcome_email_sent_at: string | null };

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  sendResult: { ok: true } as { ok: true } | { ok: false; error: string },
  sends: [] as string[],
}));

vi.mock("../supabase.js", () => {
  function from(_table: string) {
    let mode: "select" | "update" = "select";
    let patch: Partial<Row> = {};
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => {
      const matched = state.rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") matched.forEach((r) => Object.assign(r, patch));
      return matched;
    };
    const b: any = {
      select: () => b,
      update: (p: Partial<Row>) => {
        mode = "update";
        patch = p;
        return b;
      },
      eq: (col: keyof Row, val: unknown) => {
        filters.push((r) => r[col] === val);
        return b;
      },
      is: (col: keyof Row, val: unknown) => {
        filters.push((r) => r[col] === val);
        return b;
      },
      maybeSingle: async () => {
        const matched = run();
        return { data: matched[0] ? { ...matched[0] } : null, error: null };
      },
      // For `await supabase.from().update().eq()` with no terminal call.
      then: (resolve: (v: { error: null }) => void) => {
        run();
        resolve({ error: null });
      },
    };
    return b;
  }
  return { supabase: { from }, createUserClient: () => ({}) };
});

vi.mock("../email.js", () => ({
  sendWelcomeEmailNow: vi.fn(async (to: string) => {
    state.sends.push(to);
    return state.sendResult;
  }),
}));

import { processNewAccountWelcome, handleSignupWebhook } from "./signupWebhook.js";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-21T10:00:00.000Z");
const fresh = (over: Partial<Row> = {}): Row => ({
  id: ID,
  email: "real.person@gmail.com",
  created_at: "2026-09-21T09:59:30.000Z",
  welcome_email_sent_at: null,
  ...over,
});

beforeEach(() => {
  state.rows = [];
  state.sends = [];
  state.sendResult = { ok: true };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("processNewAccountWelcome", () => {
  it("sends once to the stored address and marks the account welcomed", async () => {
    state.rows = [fresh()];
    expect(await processNewAccountWelcome(ID, NOW)).toBe("sent");
    expect(state.sends).toEqual(["real.person@gmail.com"]);
    expect(state.rows[0].welcome_email_sent_at).toBe(NOW.toISOString());
  });

  it("does nothing for an unknown account", async () => {
    expect(await processNewAccountWelcome(ID, NOW)).toBe("not_found");
    expect(state.sends).toEqual([]);
  });

  it("does not re-send to an account that was already welcomed", async () => {
    state.rows = [fresh({ welcome_email_sent_at: "2026-09-21T09:59:40.000Z" })];
    expect(await processNewAccountWelcome(ID, NOW)).toBe("already_welcomed");
    expect(state.sends).toEqual([]);
  });

  it.each([
    "sectest-1@lazyrelay.invalid",
    "someone@example.com",
    "goss.werner.1+lrtest1@gmail.com",
    "team@lazyrelay.com",
  ])("never emails the internal test account %s, and leaves it unmarked", async (email) => {
    state.rows = [fresh({ email })];
    expect(await processNewAccountWelcome(ID, NOW)).toBe("internal_test_account");
    expect(state.sends).toEqual([]);
    expect(state.rows[0].welcome_email_sent_at).toBeNull();
  });

  it("refuses an account older than 24 hours (the ops sweep owns those)", async () => {
    state.rows = [fresh({ created_at: "2026-09-20T09:00:00.000Z" })];
    expect(await processNewAccountWelcome(ID, NOW)).toBe("too_old");
    expect(state.sends).toEqual([]);
  });

  it("sends exactly one email when two triggers race for the same account", async () => {
    state.rows = [fresh()];
    const outcomes = await Promise.all([processNewAccountWelcome(ID, NOW), processNewAccountWelcome(ID, NOW)]);
    expect([...outcomes].sort()).toEqual(["claim_lost", "sent"]);
    expect(state.sends).toHaveLength(1);
  });

  it("releases the claim when the email fails, so the ops sweep can retry", async () => {
    state.rows = [fresh()];
    state.sendResult = { ok: false, error: "resend is down" };
    expect(await processNewAccountWelcome(ID, NOW)).toBe("send_failed");
    expect(state.rows[0].welcome_email_sent_at).toBeNull();
  });
});

describe("handleSignupWebhook", () => {
  const call = async (body: unknown) => {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (c: number) => ((res.statusCode = c), res);
    res.json = (b: unknown) => ((res.body = b), res);
    await handleSignupWebhook({ body } as any, res);
    return res;
  };

  it.each([undefined, {}, { record: {} }, { record: { id: "not-a-uuid" } }, { record: { id: 42 } }, { id: ID }])(
    "rejects a malformed body with 400: %j",
    async (body) => {
      const res = await call(body);
      expect(res.statusCode).toBe(400);
      expect(state.sends).toEqual([]);
    },
  );

  it("gives the identical 200 body whether or not the account exists (no probing)", async () => {
    state.rows = [fresh({ id: "22222222-2222-4222-8222-222222222222" })];
    const missing = await call({ record: { id: ID } });
    const present = await call({ record: { id: "22222222-2222-4222-8222-222222222222" } });
    expect(missing.statusCode).toBe(200);
    expect(present.statusCode).toBe(200);
    expect(missing.body).toEqual(present.body);
  });
});

describe("POST /api/webhooks/signup is mounted on the real app", () => {
  it("rejects a bad body with 400 through the real route stack", async () => {
    const { buildApp } = await import("./app.js");
    const { StubMorAdapter } = await import("../billing/stub.js");
    const app = buildApp(new StubMorAdapter(), new Map());
    const res = await request(app).post("/api/webhooks/signup").send({ record: { id: "nope" } });
    expect(res.status).toBe(400);
  });
});
