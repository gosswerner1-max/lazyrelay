import type { EmailForAccount } from "./checkout.js";

// The account owner's confirmed email, read with the service role, so the Paddle checkout can show it. Same reads as the wallet's
// emailConfirmedFromDatabase. An unconfirmed address is not used (null); a failed read is thrown, never turned into "no email".

export interface EmailLookupClient {
  from(table: string): { select(cols: string): { eq(col: string, v: string): { eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: { user_id: unknown } | null; error: { message: string } | null }> } } } };
  auth: { admin: { getUserById(id: string): PromiseLike<{ data: { user: { email?: string | null; email_confirmed_at?: string | null } | null }; error: { message: string } | null }> } };
}

export function createOwnerEmailLookup(client: EmailLookupClient): EmailForAccount {
  return async (accountId) => {
    const owner = await client.from("account_members").select("user_id").eq("account_id", accountId).eq("role", "owner").maybeSingle();
    if (owner.error) throw new Error(`account owner read failed: ${owner.error.message}`);
    if (!owner.data) return null;
    const user = await client.auth.admin.getUserById(owner.data.user_id as string);
    if (user.error) throw new Error(`auth user read failed: ${user.error.message}`);
    const found = user.data.user;
    return found?.email && found.email_confirmed_at ? found.email : null;
  };
}
