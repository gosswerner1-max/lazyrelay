import { describe, it, expect } from "vitest";
import { HOME_FAQ, homeFaqSchema, homeFaqSchemaJson } from "./homeFaq";

const words = (s: string) => s.trim().split(/\s+/).length;

describe("home page FAQ", () => {
  it("has 13 distinct questions", () => {
    expect(HOME_FAQ).toHaveLength(13);
    expect(new Set(HOME_FAQ.map((i) => i.q)).size).toBe(13);
  });

  it("every answer is 40 to 60 words", () => {
    for (const item of HOME_FAQ) {
      const n = words(item.a);
      expect(n, item.q).toBeGreaterThanOrEqual(40);
      expect(n, item.q).toBeLessThanOrEqual(60);
    }
  });

  it("is plain ASCII with no long dashes or curly quotes", () => {
    for (const item of HOME_FAQ) {
      for (const text of [item.q, item.a]) {
        expect(/^[\x20-\x7E]+$/.test(text), text).toBe(true);
      }
    }
  });

  it("makes no praise or ranking promise", () => {
    const all = HOME_FAQ.map((i) => `${i.q} ${i.a}`).join(" ").toLowerCase();
    for (const bad of ["best", "fastest", "powerful", "guarantee", "rank higher", "loved by"]) {
      expect(all.includes(bad), bad).toBe(false);
    }
  });

  it("states the platform count and the plan prices that are on the site", () => {
    const all = HOME_FAQ.map((i) => i.a).join(" ");
    expect(all).toContain("17 platforms");
    for (const price of ["$29.99", "$59.99", "$99.99", "$149.99", "$199.99"]) expect(all).toContain(price);
  });
});

describe("FAQPage structured data", () => {
  it("has one Question per visible question, in the same order, with the same text", () => {
    const schema = homeFaqSchema();
    expect(schema["@type"]).toBe("FAQPage");
    expect(schema.mainEntity.map((e) => [e.name, e.acceptedAnswer.text])).toEqual(HOME_FAQ.map((i) => [i.q, i.a]));
  });

  it("serialises to JSON that parses back to the same schema and cannot close its script tag", () => {
    const json = homeFaqSchemaJson();
    expect(json.includes("<")).toBe(false);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(homeFaqSchema())));
  });

  it("escapes a less-than sign instead of letting it through", () => {
    const json = homeFaqSchemaJson([{ q: "Is 1 < 2?", a: "Yes </script>" }]);
    expect(json.includes("<")).toBe(false);
    expect(JSON.parse(json).mainEntity[0].name).toBe("Is 1 < 2?");
  });
});
