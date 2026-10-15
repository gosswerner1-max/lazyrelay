import { describe, it, expect, vi, beforeEach } from "vitest";

// Fail-closed tier (see tierResolution.ts): when a webhook's tier cannot be
// resolved safely, syncSubscriptionFromWebhook must keep the stored tier, still
// sync status/period/cancellation, and never invent a row.
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  subscriptions: [] as Array<Record<string, any>>,
  accounts: [{ id: "acct_1" }] as Array<Record<string, any>>,
  updates: [] as Array<Record<string, any>>,
  inserts: [] as Array<Record<string, any>>,
}));

vi.mock("../supabase.js", () => {
  function from(table: string) {
    const rows: Row[] = table === "subscriptions" ? state.subscriptions : table === "accounts" ? state.accounts : [];
    let mode: "select" | "update" | "upsert" = "select";
    let patch: Row = {};
    const filters: Array<(r: Row) => boolean> = [];
    const matched = () => rows.filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select: () => b,
      update: (p: Row) => {
        mode = "update";
        patch = p;
        return b;
      },
      upsert: (p: Row) => {
        mode = "upsert";
        state.inserts.push(p);
        return b;
      },
      eq: (c: string, v: unknown) => {
        filters.push((r) => r[c] === v);
        return b;
      },
      is: () => b,
      or: () => b,
      single: async () => ({ data: matched()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        const m = matched();
        if (mode === "update") {
          if (table === "subscriptions") state.updates.push(patch);
          m.forEach((r) => Object.assign(r, patch));
        }
        resolve({ data: mode === "upsert" ? [] : m, error: null });
      },
    };
    return b;
  }
  return { supabase: { from } };
});
vi.mock("../email.js", () => ({ sendPartnerConversionAlert: vi.fn() }));

import { syncSubscriptionFromWebhook } from "./sync.js";

const baseEvent = {
  kind: "tier" as const,
  morSubscriptionId: "sub_1",
  accountEmail: "a@example.com",
  accountId: "acct_1",
  status: "past_due" as const,
  currentPeriodEnd: "2026-11-10T00:00:00.000Z",
  occurredAt: "2026-10-10T00:00:00.000Z",
  cancelAtPeriodEnd: false,
};

beforeEach(() => {
  state.subscriptions = [{ account_id: "acct_1", mor_subscription_id: "sub_1", tier: "starter", status: "active" }];
  state.updates = [];
  state.inserts = [];
});

describe("syncSubscriptionFromWebhook with an unresolved tier", () => {
  it("keeps the stored tier and still syncs the status", async () => {
    await syncSubscriptionFromWebhook({ ...baseEvent });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).not.toHaveProperty("tier");
    expect(state.subscriptions[0].tier).toBe("starter");
    expect(state.subscriptions[0].status).toBe("past_due");
  });

  it("writes the tier when it is resolved (control)", async () => {
    await syncSubscriptionFromWebhook({ ...baseEvent, tier: "pro" });
    expect(state.subscriptions[0].tier).toBe("pro");
  });

  it("never inserts a row without a tier, and fails loudly for an entitlement-granting event on an account with no row", async () => {
    state.subscriptions = [];
    await expect(syncSubscriptionFromWebhook({ ...baseEvent, status: "active" })).rejects.toThrow(/tier could not be resolved/);
    expect(state.inserts).toHaveLength(0);
  });

  it("does not apply an unresolved event from a different (replaced) subscription over the stored row", async () => {
    await expect(syncSubscriptionFromWebhook({ ...baseEvent, morSubscriptionId: "sub_new", status: "active" })).rejects.toThrow(/tier could not be resolved/);
    expect(state.subscriptions[0]).toMatchObject({ mor_subscription_id: "sub_1", tier: "starter", status: "active" });
  });

  it("quietly skips a non-entitlement event (e.g. cancellation) for a subscription we do not hold", async () => {
    state.subscriptions = [];
    await expect(syncSubscriptionFromWebhook({ ...baseEvent, status: "cancelled" })).resolves.toBeUndefined();
    expect(state.inserts).toHaveLength(0);
  });
});
