// The real hasPriorSale used by the wallet webhook, against an in-memory stand in for the database. "Paid" means the sale actually paid
// something: a 100% discounted sale does not make a later purchase "not the first" (the commission report starts its window at the first
// sale that paid).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("../notify.js", () => ({ notifyOps: async () => {} }));

const { tables } = await import("../testFakeSupabase.js");
const { defaultWalletWebhookDeps } = await import("./webhook.js");

const ACCOUNT = "6f1d0a52-3c1e-4e0a-9d6e-0b4b8d8f2a11";
const row = (txn: string, total: number, kind = "sale", account = ACCOUNT) => ({ account_id: account, kind, paddle_transaction_id: txn, total });

beforeEach(() => {
  tables.billing_records = [];
});

describe("defaultWalletWebhookDeps().partnerAttribution.hasPriorSale", () => {
  const has = (txn: string) => defaultWalletWebhookDeps().partnerAttribution!.hasPriorSale(ACCOUNT, txn);

  it("false when the account has no sale at all", async () => {
    expect(await has("txn_1")).toBe(false);
  });

  it("the sale of the transaction being processed does not count (a webhook retry stays the first purchase)", async () => {
    tables.billing_records = [row("txn_1", 1500)];
    expect(await has("txn_1")).toBe(false);
  });

  it("true when an earlier paid sale exists", async () => {
    tables.billing_records = [row("txn_0", 1500)];
    expect(await has("txn_1")).toBe(true);
  });

  it("a 100% discounted sale (total 0) is not a paid purchase", async () => {
    tables.billing_records = [row("txn_0", 0)];
    expect(await has("txn_1")).toBe(false);
  });

  it("refund rows and other accounts' sales do not count", async () => {
    tables.billing_records = [row("txn_0", 1500, "refund"), row("txn_9", 1500, "sale", "someone-else")];
    expect(await has("txn_1")).toBe(false);
  });
});
