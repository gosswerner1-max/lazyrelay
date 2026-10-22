import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../lib/api", () => ({ api: {} }));

import { Partners } from "./Partners";

afterEach(cleanup);

// Werner's partner terms (2026-10-22): 20% of the sale excluding tax, for 6 months from the customer's first paid purchase, and
// commission on a subscription stops when that subscription is cancelled. No page may still say 12 months or lifetime.
describe("partner terms copy", () => {
  it("the /partners page states the 6 month rule and the cancellation rule", () => {
    const { container } = render(<Partners onBack={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("20% of what they pay (before tax), for 6 months from their first purchase");
    expect(text).toContain("then 20% for the next 3");
    expect(text).toContain("If their subscription is cancelled before the 6 months are over, commission on that subscription stops when it is cancelled");
    expect(text).not.toMatch(/12 months|lifetime|next 9/i);
  });

  it("no dash characters in the partner copy", () => {
    const { container } = render(<Partners onBack={() => {}} />);
    expect(container.textContent ?? "").not.toMatch(/[–—]/);
  });

  it("the application form and the in-the-works page no longer promise 12 months or lifetime", () => {
    const modal = readFileSync(resolve(__dirname, "../components/ReferralApplicationModal.tsx"), "utf8");
    const inTheWorks = readFileSync(resolve(__dirname, "../../public/in-the-works/index.html"), "utf8");
    expect(modal).toContain("I earn 20% for 6 months");
    expect(modal).not.toMatch(/12 months|then 20% for 9/);
    expect(inTheWorks).not.toMatch(/lifetime commission/i);
    expect(inTheWorks).toContain("commission for 6 months from a customer's first purchase");
  });
});
