import { describe, it, expect } from "vitest";
import { createOwnerEmailLookup, type EmailLookupClient } from "./accountEmail.js";

function fake(opts: { owner?: { data: { user_id: string } | null; error: { message: string } | null }; user?: { data: { user: { email?: string; email_confirmed_at?: string | null } | null }; error: { message: string } | null } }): EmailLookupClient {
  const owner = opts.owner ?? { data: { user_id: "u1" }, error: null };
  const user = opts.user ?? { data: { user: { email: "a@b.co", email_confirmed_at: "2026-01-01" } }, error: null };
  return {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => owner }) }) }) }),
    auth: { admin: { getUserById: async () => user } },
  };
}

describe("owner email lookup", () => {
  it("returns the confirmed email of the account owner", async () => {
    expect(await createOwnerEmailLookup(fake({}))("acc")).toBe("a@b.co");
  });
  it("returns null when the email is not confirmed, or there is no owner or no email", async () => {
    expect(await createOwnerEmailLookup(fake({ user: { data: { user: { email: "a@b.co", email_confirmed_at: null } }, error: null } }))("acc")).toBeNull();
    expect(await createOwnerEmailLookup(fake({ owner: { data: null, error: null } }))("acc")).toBeNull();
    expect(await createOwnerEmailLookup(fake({ user: { data: { user: { email_confirmed_at: "2026-01-01" } }, error: null } }))("acc")).toBeNull();
  });
  it("throws the raw read failure instead of returning null", async () => {
    await expect(createOwnerEmailLookup(fake({ owner: { data: null, error: { message: "owner boom" } } }))("acc")).rejects.toThrow(/owner boom/);
    await expect(createOwnerEmailLookup(fake({ user: { data: { user: null }, error: { message: "auth boom" } } }))("acc")).rejects.toThrow(/auth boom/);
  });
});
