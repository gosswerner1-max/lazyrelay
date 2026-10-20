import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TermsOfService } from "./TermsOfService";
import { DataDeletion } from "./DataDeletion";

const NOTICE =
  "LazyCredits are purely operational tokens for software features, hold no independent cash value, and are strictly non-refundable.";
const OLD = ["Agency Plus", "Business", "$29.99", "$59.99", "$99.99", "$149.99", "storage add-on", "seat add-on"];

function count(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe("legal pages use the credits model", () => {
  const refunds = readFileSync(resolve(__dirname, "../../public/refunds/index.html"), "utf8");
  const deletionHtml = readFileSync(resolve(__dirname, "../../public/data-deletion/index.html"), "utf8");

  it("Terms of Service has the notice once and no old tiers", () => {
    const text = render(<TermsOfService onBack={() => {}} />).container.textContent ?? "";
    expect(count(text.replace(/\s+/g, " "), NOTICE)).toBe(1);
    for (const old of OLD) expect(text.includes(old), old).toBe(false);
    expect(text).not.toMatch(/[–—]/);
  });

  it("Terms of Service says Starter and Growth packs never expire but the Pro top-up is bound to the Pro plan", () => {
    const text = (render(<TermsOfService onBack={() => {}} />).container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).not.toContain("Extra credit packs never expire");
    expect(text).toContain("never expire. Pro top-up $30 for 1,500 credits (bound to active subscription status, expires if canceled;");
  });

  it("Refund Policy has the notice once and no old tiers", () => {
    expect(count(refunds, NOTICE)).toBe(1);
    for (const old of OLD) expect(refunds.includes(old), old).toBe(false);
    expect(refunds).not.toMatch(/[–—]/);
  });

  it("Data Deletion pages have no add-on references", () => {
    const text = render(<DataDeletion onBack={() => {}} />).container.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("add-on");
    expect(deletionHtml.toLowerCase()).not.toContain("add-on");
  });
});
