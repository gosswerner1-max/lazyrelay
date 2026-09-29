import { describe, it, expect, vi, beforeEach } from "vitest";

// Same in-memory-mock technique as http/signupWebhook.test.ts -- a tiny
// stand-in for the two tables recordPartnerAttribution touches
// (referral_partners, accounts), implementing only the exact chains the
// function uses, with the same atomic guard semantics real Postgres has:
// .is("partner_code_redeemed", null) only matches (and updates) a row that
// hasn't already been credited.
type Partner = { code: string; name: string; email: string; status: string };
type Account = { id: string; partner_code_redeemed: string | null; partner_code_redeemed_at: string | null };

const state = vi.hoisted(() => ({
  partners: [] as Partner[],
  accounts: [] as Account[],
  sentEmails: [] as Array<{ to: string; name: string; code: string }>,
}));

vi.mock("../supabase.js", () => {
  function from(table: "referral_partners" | "accounts") {
    const rows = table === "referral_partners" ? state.partners : state.accounts;
    let mode: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};
    const filters: Array<(r: any) => boolean> = [];
    const run = () => {
      const matched = rows.filter((r: any) => filters.every((f) => f(r)));
      if (mode === "update") matched.forEach((r: any) => Object.assign(r, patch));
      return matched;
    };
    const b: any = {
      select: () => b,
      update: (p: Record<string, unknown>) => {
        mode = "update";
        patch = p;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return b;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return b;
      },
      maybeSingle: async () => {
        const matched = run();
        return { data: matched[0] ? { ...matched[0] } : null, error: null };
      },
    };
    return b;
  }
  return { supabase: { from } };
});

vi.mock("../email.js", () => ({
  sendPartnerConversionAlert: vi.fn((to: string, name: string, code: string) => {
    state.sentEmails.push({ to, name, code });
  }),
}));

import { recordPartnerAttribution } from "./sync.js";

const APPROVED_PARTNER: Partner = { code: "bigboyslzy", name: "Big Boys Channel", email: "bigboys@example.com", status: "approved" };
const FRESH_ACCOUNT = (id: string): Account => ({ id, partner_code_redeemed: null, partner_code_redeemed_at: null });

beforeEach(() => {
  state.partners = [{ ...APPROVED_PARTNER }];
  state.accounts = [FRESH_ACCOUNT("acct_1")];
  state.sentEmails = [];
});

describe("recordPartnerAttribution", () => {
  it("records the code and emails the partner, on a fresh account with a real approved code", async () => {
    await recordPartnerAttribution("acct_1", "bigboyslzy");
    const account = state.accounts.find((a) => a.id === "acct_1")!;
    expect(account.partner_code_redeemed).toBe("bigboyslzy");
    expect(account.partner_code_redeemed_at).not.toBeNull();
    expect(state.sentEmails).toEqual([{ to: "bigboys@example.com", name: "Big Boys Channel", code: "bigboyslzy" }]);
  });

  it("silently does nothing for a code that matches no real partner (e.g. the generic launch-discount code)", async () => {
    await recordPartnerAttribution("acct_1", "LAUNCH20");
    const account = state.accounts.find((a) => a.id === "acct_1")!;
    expect(account.partner_code_redeemed).toBeNull();
    expect(state.sentEmails).toEqual([]);
  });

  it("silently does nothing for a paused (not approved) partner's code", async () => {
    state.partners[0].status = "paused";
    await recordPartnerAttribution("acct_1", "bigboyslzy");
    const account = state.accounts.find((a) => a.id === "acct_1")!;
    expect(account.partner_code_redeemed).toBeNull();
    expect(state.sentEmails).toEqual([]);
  });

  it("never overwrites an already-credited account, and never sends a second email", async () => {
    state.accounts = [{ id: "acct_1", partner_code_redeemed: "some-other-partner", partner_code_redeemed_at: "2026-01-01T00:00:00.000Z" }];
    await recordPartnerAttribution("acct_1", "bigboyslzy");
    const account = state.accounts.find((a) => a.id === "acct_1")!;
    // Untouched -- the .is("partner_code_redeemed", null) guard means this
    // update matches zero rows for an account that's already credited.
    expect(account.partner_code_redeemed).toBe("some-other-partner");
    expect(state.sentEmails).toEqual([]);
  });

  it("never throws, even for a nonexistent account id -- this must never break the webhook it's attached to", async () => {
    await expect(recordPartnerAttribution("acct_does_not_exist", "bigboyslzy")).resolves.toBeUndefined();
  });
});
