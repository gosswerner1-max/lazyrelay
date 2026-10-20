import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import pricingPage from "../../public/pricing/index.html?raw";
import pricingMd from "../../public/pricing.md?raw";
import llms from "../../public/llms.txt?raw";
import indexHtml from "../../index.html?raw";

vi.mock("../lib/api", () => ({ api: {} }));

import { Landing } from "./Landing";

// The public pricing (Werner, 2026-10-20): Free, Pay-as-you-go, Growth and Pro, one wallet of credits, every price plus tax.
afterEach(cleanup);

function renderLanding() {
  const noop = () => {};
  return render(
    <Landing onSignIn={noop} onGetStarted={noop} onPrivacy={noop} onTerms={noop} onDpa={noop}
      onContact={noop} onPartners={noop} onDocs={noop} scrollToPricing={false} />,
  );
}

const OLD = ["$29.99", "$59.99", "$99.99", "$149.99", "$199.99", "Agency Plus", "Business", "Starter plan"];

describe("home page pricing section", () => {
  it("shows the four plans in order with the right prices and 'plus tax' beside each paid price", () => {
    renderLanding();
    const cards = [...document.querySelectorAll("#pricing .pricing-grid:not(.pricing-grid-packs) .pricing-card")];
    expect(cards.map((c) => c.querySelector("h3")?.textContent)).toEqual(["Free", "Pay-as-you-go", "Growth", "Pro"]);
    const prices = cards.map((c) => c.querySelector(".pricing-price")?.textContent ?? "");
    expect(prices[0]).toBe("$0");
    expect(prices[1]).toContain("$15");
    expect(prices[1]).toContain("one time");
    expect(prices[2]).toContain("$29");
    expect(prices[2]).toContain("a month");
    expect(prices[3]).toContain("$99");
    for (const p of prices.slice(1)) expect(p).toContain("(plus tax)");
  });

  it("shows the three credit packs, each plus tax, and the rates block", () => {
    renderLanding();
    const packs = [...document.querySelectorAll("#pricing .pricing-grid-packs .pricing-card")];
    expect(packs.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Starter pack$15(plus tax)300 credits"),
      expect.stringContaining("Growth pack$50(plus tax)1,500 credits"),
      expect.stringContaining("Pro top-up$30(plus tax)1,500 creditsActive Pro subscribers only. $30 for 1,500 credits (bound to active subscription status, expires if canceled). Plus tax."),
    ]);
    const text = document.querySelector("#pricing")!.textContent ?? "";
    expect(text).toContain("1 credit per channel destination");
    expect(text).toContain("5 channels × 1 credit = 5 credits");
    expect(text).toContain("10 credits");
  });

  it("Pay-as-you-go has the two wallet lines and no 'Pay once' note; Pro lists the top-up text; packs do not all 'never expire'", () => {
    renderLanding();
    const text = document.querySelector("#pricing")!.textContent ?? "";
    expect(text).toContain("300 credits that stay in your wallet until used");
    expect(text).toContain("Balance can be topped up at any time");
    expect(text).not.toContain("Pay once, use whenever");
    expect(text).not.toContain("the credits never expire");
    const pro = [...document.querySelectorAll("#pricing .pricing-grid:not(.pricing-grid-packs) .pricing-card")].find((c) => c.textContent?.startsWith("Pro"));
    expect(pro?.textContent).toContain("$30 for 1,500 credits (bound to active subscription status, expires if canceled). Plus tax.");
  });

  it("mentions no old plan, old price or dash", () => {
    renderLanding();
    const text = document.querySelector("#pricing")!.textContent ?? "";
    for (const old of OLD) expect(text.includes(old), old).toBe(false);
    expect(text).not.toMatch(/[–—]/);
    expect(document.querySelector(".pricing-agency-toggle")).toBeNull();
  });
});

describe("static pricing surfaces", () => {
  it.each([
    ["pricing page", pricingPage],
    ["pricing.md", pricingMd],
    ["llms.txt", llms],
    ["index.html", indexHtml],
  ])("%s carries no old plan or price", (_name, text) => {
    for (const old of ["$29.99", "$59.99", "$99.99", "$149.99", "$199.99", "Agency Plus"]) expect(text.includes(old), old).toBe(false);
  });

  it("the pricing page has the plan table, the packs and both rates, with no dashes", () => {
    for (const s of ["Pay-as-you-go", "Growth", "$15 one time", "$29 a month", "$99 a month", "Starter pack", "Growth pack", "Pro top-up", "1 credit per channel destination", "10 credits"]) {
      expect(pricingPage).toContain(s);
    }
    expect(pricingPage).toContain("5 channels &times; 1 credit = 5 credits");
    expect(pricingPage).not.toMatch(/[–—]|&mdash;|&ndash;/);
    expect(pricingPage).toContain('rel="canonical" href="https://lazyrelay.com/pricing/"');
    expect(pricingPage).toContain('name="robots"');
  });

  it("states the Pro top-up expiry exactly, in the visible text and the FAQ schema, and never says all packs never expire", () => {
    for (const [name, text] of [["pricing page", pricingPage], ["pricing.md", pricingMd]] as const) {
      expect(text, name).toContain("$30 for 1,500 credits (bound to active subscription status, expires if canceled). Plus tax.");
      expect(text, name).not.toMatch(/Packs are one-time purchases and the credits never expire|credit packs never expire|all with credits that never expire/);
    }
    const block = pricingPage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
    const faq = JSON.parse(block)["@graph"]?.filter((n: { "@type": string }) => n["@type"] === "FAQPage") ?? [JSON.parse(block)];
    const answers: string[] = faq.flatMap((f: { mainEntity: { acceptedAnswer: { text: string } }[] }) => f.mainEntity.map((q) => q.acceptedAnswer.text));
    const packs = answers.find((a) => a.startsWith("Three packs"))!;
    expect(packs).toContain("$30 for 1,500 credits (bound to active subscription status, expires if canceled). Plus tax.");
    const expiry = answers.find((a) => a.includes("Pro top-up credits are bound"))!;
    expect(expiry).toBeTruthy();
    const visible = pricingPage.split("</script>").slice(-1)[0];
    expect(visible).toContain(packs);
    expect(visible).toContain(expiry);
  });

  it("index.html has one valid schema block whose offers match the four plans", () => {
    const blocks = [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks).toHaveLength(1);
    const graph = JSON.parse(blocks[0][1])["@graph"];
    const offers = graph.find((n: { "@type": string }) => n["@type"] === "SoftwareApplication").offers;
    expect(offers.offerCount).toBe(4);
    expect(offers.offers.map((o: { name: string; price: string }) => [o.name, o.price])).toEqual([
      ["Free", "0"],
      ["Pay-as-you-go", "15"],
      ["Growth", "29"],
      ["Pro", "99"],
    ]);
  });
});
