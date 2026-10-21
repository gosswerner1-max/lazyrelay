// The "what happens to my connected accounts" line in the cancel dialog. It says only what the backend does when a plan ends:
//   - nothing disconnects, deletes or pauses a connected account at that moment (billing/sync.ts only sets cancelled_at on a cancel
//     and only enforces an account cap on an ACTIVE subscription; the 30 day data deletion in ops/accounts/data_retention_ops.js
//     removes scheduled posts and media files, never connected accounts);
//   - the account then resolves to the Free plan (tier.ts resolveTier), whose cap is 3 connected accounts (accountLimits.ts), and
//     checkAccountLimit refuses a NEW connection once the number connected, paused ones included, is at or over the cap;
//   - nothing pauses the accounts above Free's 3 when the plan ends, so it is not known which of them will keep posting. No promise.

export const FREE_ACCOUNT_LIMIT = 3;

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
  agency: "Agency",
  agency_plus: "Agency Plus",
  growth: "Growth",
  lazy_pro: "Pro",
  payg: "Pay as you go",
};

/** The plan's public name: the wallet plan when the credit wallet is live, else the subscription tier code. */
export function cancelPlanName(tier: string | undefined, walletPlan?: string | null): string {
  if (walletPlan === "growth" || walletPlan === "pro") return PLAN_NAMES[walletPlan]!;
  return (tier && PLAN_NAMES[tier]) || "current";
}

export function CancelAccountsNote({ count, planName }: { count: number; planName: string }) {
  if (count === 0) {
    return <>You have no connected accounts. When your {planName} plan ends, your account returns to the Free plan, which includes up to {FREE_ACCOUNT_LIMIT} connected accounts.</>;
  }
  const shown = count.toLocaleString("en-US");
  return (
    <>
      Your <strong>{shown}</strong> connected account{count === 1 ? " is" : "s are"} not disconnected or deleted when your {planName} plan ends. Your account
      returns to the Free plan, which includes up to {FREE_ACCOUNT_LIMIT} connected accounts.
      {count === FREE_ACCOUNT_LIMIT && " That limit is full, so you can't connect another account until you disconnect one or resubscribe."}
      {count > FREE_ACCOUNT_LIMIT &&
        " You have more than that, so you can't connect another account until you disconnect some or resubscribe, and we can't promise all of them will keep posting."}
    </>
  );
}
