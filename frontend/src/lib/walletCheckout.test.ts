import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

import { checkPartnerCode, startCheckout } from "./walletCheckout";
import { catalogReasonLine } from "./walletWords";

const refusal = (status: number, code?: string, message = "raw words from the server") => async () => {
  throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
};

describe("startCheckout", () => {
  it("posts the sku as JSON to /wallet/checkout-intent and returns the transaction", async () => {
    const fetcher = vi.fn(async () => ({ transactionId: "txn_1", checkoutUrl: "https://pay.example/txn_1", sku: "pack_small" }));
    const result = await startCheckout("pack_small", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/wallet/checkout-intent", { method: "POST", body: JSON.stringify({ sku: "pack_small" }) });
    expect(result).toEqual({ ok: true, transactionId: "txn_1", checkoutUrl: "https://pay.example/txn_1", sku: "pack_small", partner: "none", discount: false });
  });

  it("sends the code from the box with the sku so the sale can be credited to the partner", async () => {
    const fetcher = vi.fn(async () => ({ transactionId: "txn_1", checkoutUrl: "https://pay.example/txn_1", sku: "pack_small" }));
    await startCheckout("pack_small", fetcher, "sarah");
    expect(fetcher).toHaveBeenCalledWith("/wallet/checkout-intent", { method: "POST", body: JSON.stringify({ sku: "pack_small", partnerCode: "sarah" }) });
  });

  it("sends no partnerCode field when the box is empty or blank, even if a link code is stored in the browser", async () => {
    localStorage.setItem("lazyrelay_ref", JSON.stringify({ code: "stored", capturedAt: Date.now() }));
    const fetcher = vi.fn(async () => ({ transactionId: "txn_1", checkoutUrl: "https://pay.example/txn_1", sku: "pack_small" }));
    await startCheckout("pack_small", fetcher, "   ");
    expect(fetcher).toHaveBeenLastCalledWith("/wallet/checkout-intent", { method: "POST", body: JSON.stringify({ sku: "pack_small" }) });
    localStorage.clear();
    await startCheckout("pack_small", fetcher, null);
    expect(fetcher).toHaveBeenCalledWith("/wallet/checkout-intent", { method: "POST", body: JSON.stringify({ sku: "pack_small" }) });
  });

  it.each([
    ["needs_pro", 403, "The Pro top-up is only for active Pro plan subscribers."],
    ["legacy_account", 409, "Credit purchases are not available on your current account type."],
    ["already_subscribed", 409, "You are already subscribed to this plan."],
    ["plan_ending", 409, "Your Pro plan is set to end, so a top-up would lapse in days."],
  ])("says %s in plain words", async (code, status, words) => {
    const result = await startCheckout("x", refusal(status, code));
    expect(result).toMatchObject({ ok: false, message: words, code });
  });

  it("treats a 404 as billing being off", async () => {
    expect(await startCheckout("x", refusal(404))).toMatchObject({ ok: false, message: "Credit purchases are not switched on yet." });
  });

  it("asks for a fresh sign-in on a 401 or with no session", async () => {
    const noSession = async () => {
      throw new Error("Not signed in");
    };
    for (const fetcher of [refusal(401), noSession]) {
      expect(await startCheckout("x", fetcher)).toMatchObject({ ok: false, message: "Please sign in again to buy credits." });
    }
  });

  it("never shows a raw error: an unknown failure gets the try-again line and keeps the cause", async () => {
    const result = await startCheckout("x", refusal(500, undefined, "duplicate key value violates constraint"));
    expect(result).toMatchObject({ ok: false, message: "We could not start the checkout. Please try again." });
    if (!result.ok) expect(result.message).not.toContain("constraint");
    if (!result.ok) expect((result.cause as { status: number }).status).toBe(500);
  });

  it("treats an unknown refusal code as the try-again line, not as the server's words", async () => {
    const result = await startCheckout("x", refusal(403, "something_new", "Server says no"));
    expect(result).toMatchObject({ ok: false, message: "We could not start the checkout. Please try again." });
  });

  it.each([null, 7, {}, { transactionId: "" }, { transactionId: 4, checkoutUrl: "u", sku: "x" }, { transactionId: "t", checkoutUrl: 3, sku: "x" }])(
    "does not open a payment window for a wrong answer: %j",
    async (body) => {
      const result = await startCheckout("x", async () => body);
      expect(result).toMatchObject({ ok: false, message: "We could not start the checkout. Please try again." });
    },
  );
});

describe("startCheckout reports what the server did with the code", () => {
  const answer = (partner: unknown) => async () => ({ transactionId: "t", checkoutUrl: "u", sku: "lazyrelay-growth-plan", partner });

  it("applied with the discount", async () => {
    expect(await startCheckout("x", answer({ status: "applied", discount: true }), "sarah")).toMatchObject({ ok: true, partner: "applied", discount: true });
  });
  it("invalid still opens the checkout", async () => {
    expect(await startCheckout("x", answer({ status: "invalid", discount: false }), "nope")).toMatchObject({ ok: true, partner: "invalid", discount: false });
  });
  it("a missing or odd partner answer reads as none", async () => {
    expect(await startCheckout("x", answer(undefined))).toMatchObject({ partner: "none", discount: false });
    expect(await startCheckout("x", answer({ status: "weird", discount: "yes" }))).toMatchObject({ partner: "none", discount: false });
  });
});

describe("checkPartnerCode", () => {
  it("posts the typed code and returns the verdict", async () => {
    const fetcher = vi.fn(async () => ({ valid: true, discount: true }));
    expect(await checkPartnerCode("sarah", fetcher)).toEqual({ kind: "valid", discount: true });
    expect(fetcher).toHaveBeenCalledWith("/wallet/partner-code/check", { method: "POST", body: JSON.stringify({ code: "sarah" }) });
  });
  it("an unknown code is invalid", async () => {
    expect(await checkPartnerCode("nope", async () => ({ valid: false, discount: false }))).toEqual({ kind: "invalid" });
  });
  it("a failure or a wrong answer is an error, with the raw cause kept and never shown", async () => {
    const boom = new Error("socket hang up");
    const a = await checkPartnerCode("sarah", async () => { throw boom; });
    expect(a).toMatchObject({ kind: "error", cause: boom });
    expect(await checkPartnerCode("sarah", async () => 7)).toMatchObject({ kind: "error" });
  });
  it("an empty box is not sent anywhere", async () => {
    const fetcher = vi.fn();
    expect(await checkPartnerCode("  ", fetcher)).toEqual({ kind: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("catalogReasonLine", () => {
  it("has one short line per reason, and a generic one for none", () => {
    expect(catalogReasonLine("needs_pro")).toBe("Only for active Pro plan subscribers.");
    expect(catalogReasonLine("already_subscribed")).toBe("You are already subscribed to this plan.");
    expect(catalogReasonLine("legacy_account")).toBe("Not available on your current account type.");
    expect(catalogReasonLine("plan_ending")).toBe("Your Pro plan is set to end, so a top-up would lapse in days.");
    expect(catalogReasonLine(null)).toBe("Not available right now.");
  });
});
