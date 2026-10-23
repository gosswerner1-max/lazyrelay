import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../lib/api", () => ({ api: {} }));

import { Partners } from "./Partners";

afterEach(cleanup);

// Werner's partner terms (2026-10-22 and 2026-10-23): ONE plan. 20% of the sale excluding tax, for 6 months from the customer's first paid
// purchase; Growth and Pro pay monthly in that window; Pay as you go pays once; commission stops if the customer cancels; viewers get 10% off
// the first month of Growth or Pro; the partner labels posts as a paid link or #ad. The terms text is a DRAFT summary until a lawyer reads it.
describe("partner terms copy", () => {
  const page = () => render(<Partners onBack={() => {}} />).container.textContent ?? "";

  it("states the one flat plan", () => {
    const text = page();
    expect(text).toContain("You earn 20% of what your customers pay, before tax, for 6 months from their first paid purchase");
    expect(text).toContain("Growth and Pro subscriptions pay you every month inside those 6 months");
    expect(text).toContain("If the customer cancels, commission on that subscription stops when it is cancelled");
    expect(text).toContain("Pay as you go credit packs pay you once, on the customer's first paid purchase");
    expect(text).toContain("Your audience gets 10% off their first month of Growth or Pro when they type your code at checkout");
  });

  it("has no second plan and no old terms", () => {
    expect(page()).not.toMatch(/Plan A|Plan B|30%|12 months|lifetime|next 9|next 3/i);
  });

  it("shows the terms as a clearly marked draft summary with the labelling rule and no invented legal clauses", () => {
    const text = page();
    expect(text).toContain("Partner terms (draft summary)");
    expect(text).toMatch(/not final|being read by a lawyer/i);
    expect(text).toContain("paid link or #ad");
    expect(text).toContain("You cannot earn commission on your own purchases");
  });

  it("no dash characters in the partner copy", () => {
    expect(page()).not.toMatch(/[\u2013\u2014]/);
  });

  it("the application form and the in-the-works page match", () => {
    const modal = readFileSync(resolve(__dirname, "../components/ReferralApplicationModal.tsx"), "utf8");
    const inTheWorks = readFileSync(resolve(__dirname, "../../public/in-the-works/index.html"), "utf8");
    expect(modal).not.toMatch(/Plan A|Plan B|12 months|then 20%/);
    expect(modal).toContain("I agree to the partner terms");
    expect(inTheWorks).not.toMatch(/lifetime|30%/i);
    expect(inTheWorks).toContain("flat 20% commission for 6 months from a customer's first purchase");
  });
});
