import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TermsOfService } from "./TermsOfService";
import { DataDeletion } from "./DataDeletion";

const NOTICE =
  "LazyCredits are purely operational tokens for software features, hold no independent cash value, and are strictly non-refundable.";
const FOOTNOTE = "Except as required under local consumer protection laws or our payment processor's mandatory terms.";
const NON_REFUNDABLE = "All purchases, credit packages and subscription cycles are strictly non-refundable.";
const SUBSCRIPTION_RULE = "30 days after the subscription ends or is cancelled";
const INACTIVITY_RULE =
  "Data is maintained as long as the account remains active, and is subject to deletion after 6 consecutive months of total inactivity.";
const BANNED_REFUND_LANGUAGE = [/case[- ]by[- ]case/i, /individually/i, /outside (this|the standard) policy/i, /we'll review it/i];
const flat = (t: string) => t.replace(/\s+/g, " ");
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

  it("Terms and Refund Policy state strict non-refundability with the footnote and no case-by-case language", () => {
    const terms = flat(render(<TermsOfService onBack={() => {}} />).container.textContent ?? "");
    for (const text of [terms, flat(refunds)]) {
      expect(text).toContain(NON_REFUNDABLE);
      expect(count(text, FOOTNOTE)).toBe(1);
      for (const re of BANNED_REFUND_LANGUAGE) expect(text, String(re)).not.toMatch(re);
    }
  });

  it("Terms, Data Deletion page and public copy carry both deletion rules", () => {
    const terms = flat(render(<TermsOfService onBack={() => {}} />).container.textContent ?? "");
    const deletion = flat(render(<DataDeletion onBack={() => {}} />).container.textContent ?? "");
    for (const text of [terms, deletion, flat(deletionHtml)]) {
      expect(text).toContain(SUBSCRIPTION_RULE);
      expect(text).toContain(INACTIVITY_RULE);
      expect(text).toContain("6 consecutive months of total inactivity");
      expect(text).not.toMatch(/12 consecutive months/);
      expect(text).not.toMatch(/drops to the Free plan/);
    }
  });

  it("support macros carry the footnote and the inactivity phrase exactly as on the legal pages, with no em or en dashes", () => {
    const macros = readFileSync(resolve(__dirname, "../../../support/SUPPORT_MACROS.md"), "utf8");
    const terms = flat(render(<TermsOfService onBack={() => {}} />).container.textContent ?? "");
    const INACTIVITY_PHRASE = "6 consecutive months of total inactivity";
    const [, m1, m2, m3] = macros.split(/^## MACRO /m);
    for (const page of [terms, flat(refunds)]) expect(page).toContain(FOOTNOTE);
    for (const macro of [m1, m2]) expect(flat(macro)).toContain(FOOTNOTE);
    for (const page of [terms, flat(deletionHtml)]) expect(page).toContain(INACTIVITY_PHRASE);
    expect(flat(m3)).toContain(INACTIVITY_PHRASE);
    expect(macros).not.toMatch(/[–—]/);
  });
});
