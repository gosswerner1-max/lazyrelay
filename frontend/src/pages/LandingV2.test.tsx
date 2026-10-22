import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import landingV2Source from "./LandingV2.tsx?raw";
import motionSource from "./landingV2/useLandingMotion.ts?raw";
import dataSource from "./landingV2/landingV2Data.ts?raw";
import { readFileSync } from "node:fs";

vi.mock("../lib/api", () => ({ api: {} }));

// Read from disk: the css ?raw import is empty under the test runner.
const cssText = readFileSync("src/pages/LandingV2.css", "utf8");

import { LandingV2 } from "./LandingV2";

// The approved staged home page (Midnight Canvas), ported to React. Every claim on it is checked against the live product:
// pricing equals public/pricing.md, the platform count is the locked wording, and the motion engines respect the visitor's settings.

const BANNED_HUE_WORDS = ["pur" + "ple", "vio" + "let"];
const EXPECTED_PLATFORMS = [
  "TikTok", "Instagram", "Facebook", "YouTube", "LinkedIn", "Pinterest", "Mastodon", "Bluesky", "Threads", "Tumblr",
  "Telegram", "X", "Discord", "WordPress", "dev.to", "Hashnode", "Lemmy", "Slack",
];

type Handlers = { signup: ReturnType<typeof vi.fn>; signin: ReturnType<typeof vi.fn>; docs: ReturnType<typeof vi.fn> };

function setEnvironment(opts: { reduced: boolean; finePointer?: boolean }) {
  const fine = opts.finePointer ?? true;
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? opts.reduced : query.includes("hover: hover") ? fine : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  class FakeObserver {
    static made = 0;
    constructor() { FakeObserver.made += 1; }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
  const noop = () => {};
  const ctx = new Proxy({}, {
    get: (_t, key) => (key === "createRadialGradient" ? () => ({ addColorStop: noop }) : noop),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return FakeObserver;
}

function renderHome(): Handlers & { container: HTMLElement } {
  const h = { signup: vi.fn(), signin: vi.fn(), docs: vi.fn() };
  const noop = () => {};
  const { container } = render(
    <LandingV2 onSignIn={h.signin} onGetStarted={h.signup} onPrivacy={noop} onTerms={noop} onDpa={noop}
      onContact={noop} onPartners={noop} onDocs={h.docs} scrollToPricing={false} />,
  );
  return { ...h, container };
}

beforeEach(() => {
  setEnvironment({ reduced: false });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("locked wording", () => {
  it("always says exactly '18 distribution platforms plus WhatsApp', never another count", () => {
    renderHome();
    // The FAQ answer about the Mentions tab ("reads them from 9 platforms") is a different fact from the distribution count.
    const text = (document.body.textContent ?? "").replace(/It reads them from 9 platforms/g, "It reads them from the Mentions platforms");
    expect(text).toContain("18 distribution platforms plus WhatsApp");
    const counts = [...text.matchAll(/\b(\d+|seventeen|eighteen|nineteen|twenty)\s+(?:distribution\s+|more\s+|social\s+)?platforms\b/gi)];
    for (const m of counts) expect(m[0], m[0]).toMatch(/^18 distribution platforms$/);
    expect(text).not.toMatch(/14 more platforms|17 platforms|19 platforms|\b17\b distribution/i);
    expect(document.querySelector('[aria-label="The 18 distribution platforms plus WhatsApp"]')).not.toBeNull();
  });

  it("never mentions tax", () => {
    const { container } = renderHome();
    expect(container.textContent ?? "").not.toMatch(/\btax/i);
    expect(container.innerHTML).not.toMatch(/plus tax|\+ tax|before tax/i);
    expect(cssText).not.toMatch(/plus tax|\+ tax|before tax/i);
  });

  it("uses no banned words", () => {
    const { container } = renderHome();
    const all = (container.textContent ?? "") + landingV2Source + dataSource + cssText;
    expect(all).not.toMatch(/small business|\bsolo\w*|solopreneur/i);
  });

  it("uses no dash punctuation in the copy", () => {
    const { container } = renderHome();
    expect(container.textContent ?? "").not.toMatch(/[–—]/);
  });

  it("carries no banned hue word in any code or comment it adds", () => {
    for (const [name, text] of [["tsx", landingV2Source], ["motion", motionSource], ["data", dataSource], ["css", cssText]] as const) {
      for (const word of BANNED_HUE_WORDS) expect(text.toLowerCase().includes(word), `${name}: ${word}`).toBe(false);
    }
  });

  it("loads no external fonts or styles", () => {
    for (const text of [landingV2Source, cssText]) {
      expect(text).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
      expect(text).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
    }
  });
});

describe("structure and SEO", () => {
  it("has exactly one h1, the locked headline", () => {
    renderHome();
    const h1s = document.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Schedule everywhere. Know it's actually live.");
    expect(h1s[0].classList.contains("landing-hero-headline")).toBe(true);
  });

  it("keeps the FAQ section and its FAQPage structured data", () => {
    renderHome();
    const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
    expect(blocks).toHaveLength(1);
    const parsed = JSON.parse(blocks[0].textContent ?? "{}");
    expect(parsed["@type"]).toBe("FAQPage");
    expect(document.querySelector("#faq")).not.toBeNull();
  });

  it("does not touch the document title or add head tags", () => {
    const before = document.head.innerHTML;
    renderHome();
    expect(document.head.innerHTML).toBe(before);
  });
});

describe("pricing equals pricing.md", () => {
  it("lists the four plans in order with the real prices and credits", () => {
    renderHome();
    const cards = [...document.querySelectorAll("#pricing .lv2-rp")];
    expect(cards.map((c) => c.querySelector(".name")?.textContent)).toEqual(["Free", "Pay-as-you-go", "Growth", "Pro"]);
    const price = (i: number) => cards[i].querySelector(".price")?.textContent ?? "";
    expect(price(0)).toBe("$0");
    expect(price(1)).toBe("$15one time");
    expect(price(2)).toBe("$29a month");
    expect(price(3)).toBe("$99a month");
    expect(cards[0].textContent).toContain("30 credits once, at registration");
    expect(cards[0].textContent).toContain("3 connected accounts, 1 brand");
    expect(cards[1].textContent).toContain("300 credits");
    expect(cards[1].textContent).toContain("never expire");
    expect(cards[1].textContent).toContain("20 connected accounts, 2 brands");
    expect(cards[2].textContent).toContain("1,000");
    expect(cards[2].textContent).toContain("30 connected accounts, 4 brands");
    expect(cards[3].textContent).toContain("6,000");
    expect(cards[3].textContent).toContain("Up to 1,000 connected accounts");
    expect(cards[3].textContent).toContain("Unlimited brands");
    expect(cards[3].textContent).toContain("$30 for 1,500 credits (bound to active subscription status, expires if canceled).");
  });

  it("states the credit packs and rates truthfully", () => {
    renderHome();
    const packs = document.querySelector("#pricing .lv2-packs")?.textContent ?? "";
    expect(packs).toContain("Starter pack $15");
    expect(packs).toContain("300 credits, never expire");
    expect(packs).toContain("Growth pack $50");
    expect(packs).toContain("1,500 credits, never expire");
    expect(packs).toContain("Pro top-up $30");
    expect(packs).toContain("active Pro subscribers only");
    expect(packs).toContain("1 credit per channel destination");
    expect(packs).toContain("10 credits per competitor teardown");
    // The staged copy said the Growth pack needed a Growth subscription and expired. It does not.
    expect(packs).not.toMatch(/Growth plan subscribers|Growth pack[^.]*expire if/);
    expect(document.querySelector("#pricing")?.textContent).toContain("Prices are in US dollars");
  });

  it("shows the 27 actions in four groups", () => {
    renderHome();
    const panels = [...document.querySelectorAll(".lv2-ag-panel")];
    expect(panels.map((p) => p.querySelectorAll("li").length)).toEqual([8, 9, 6, 4]);
    expect(document.querySelector(".lv2-ag-top b")?.textContent).toBe("27");
  });
});

describe("calls to action keep the real destinations", () => {
  it("sign up buttons are real /signup links that call onGetStarted", () => {
    const h = renderHome();
    const links = [...document.querySelectorAll('a[href="/signup"]')];
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const a of links) fireEvent.click(a);
    expect(h.signup).toHaveBeenCalledTimes(links.length);
  });

  it("sign in is a real /login link that calls onSignIn", () => {
    const h = renderHome();
    const link = document.querySelector('header a[href="/login"]')!;
    fireEvent.click(link);
    expect(h.signin).toHaveBeenCalledTimes(1);
  });

  it("docs is a real /docs link that calls onDocs, and a modified click is left to the browser", () => {
    const h = renderHome();
    const link = document.querySelector('header a[href="/docs"]')!;
    fireEvent.click(link, { ctrlKey: true });
    expect(h.docs).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(h.docs).toHaveBeenCalledTimes(1);
  });

  it("links pricing, capabilities, guides and integrations to the same places as the current page", () => {
    renderHome();
    for (const href of ["#pricing", "/capabilities/", "/guides/", "/mcp/"]) {
      expect(document.querySelector(`header a[href="${href}"]`), href).not.toBeNull();
    }
    expect(document.querySelector("#pricing")).not.toBeNull();
  });

  it("uses no staged-only destination", () => {
    renderHome();
    const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h) => h.includes("mode=signup") || h.startsWith("/login/"))).toEqual([]);
  });
});

describe("platform ticker", () => {
  it("lists the 18 distribution platforms plus WhatsApp once, in the readable set", () => {
    renderHome();
    const names = [...document.querySelectorAll('.lv2-tick [data-set="primary"] .lv2-ic')].map((e) => e.getAttribute("aria-label"));
    expect(names).toEqual([...EXPECTED_PLATFORMS, "WhatsApp (messaging)"]);
    expect(names).toHaveLength(19);
  });

  it("repeats the set once, hidden from assistive tech, so the loop has no seam", () => {
    renderHome();
    const dups = document.querySelectorAll('.lv2-tick [data-set="copy"]');
    expect(dups).toHaveLength(2);
    for (const d of dups) expect(d.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws the violet-family logos in slate", () => {
    renderHome();
    for (const name of ["Mastodon", "Discord", "Slack"]) {
      const img = document.querySelector(`.lv2-tick [data-set="primary"] .lv2-ic[aria-label="${name}"] img`)!;
      expect(img.classList.contains("slate"), name).toBe(true);
    }
    expect(cssText).toMatch(/\.slate\s*\{[^}]*grayscale\(1\)/);
  });
});

describe("motion engines", () => {
  it("run when the visitor allows motion", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    renderHome();
    expect(window.requestAnimationFrame).toHaveBeenCalled();
    expect(addSpy.mock.calls.some(([type]) => type === "pointermove")).toBe(true);
    expect(document.querySelectorAll(".lv2-rv:not([data-in])").length).toBeGreaterThan(0);
  });

  it("are all off under prefers-reduced-motion", () => {
    const Observer = setEnvironment({ reduced: true });
    const addSpy = vi.spyOn(window, "addEventListener");
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const before = Observer.made;
    renderHome();
    expect(raf).not.toHaveBeenCalled();
    expect(addSpy.mock.calls.filter(([type]) => type === "pointermove")).toEqual([]);
    expect(Observer.made - before).toBe(0);
    // Nothing waits for a scroll to appear.
    expect(document.querySelectorAll(".lv2-rv:not([data-in])")).toHaveLength(0);
    // The orb that follows the cursor never moves.
    expect((document.querySelector(".lv2-orb") as HTMLElement | null)?.style.transform ?? "").toBe("");
    // The auto-playing proof shows its finished state straight away.
    expect(document.querySelectorAll(".lv2-pp-steps li[data-on]")).toHaveLength(3);
  });

  it("stop their listeners and frames when the page unmounts", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    renderHome();
    cleanup();
    expect(removeSpy.mock.calls.some(([type]) => type === "pointermove")).toBe(true);
    expect(removeSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it("skip the cursor effects on touch devices", () => {
    setEnvironment({ reduced: false, finePointer: false });
    const addSpy = vi.spyOn(window, "addEventListener");
    renderHome();
    expect(addSpy.mock.calls.filter(([type]) => type === "pointermove")).toEqual([]);
  });
});

describe("controls", () => {
  it("switches the proof outcome", () => {
    renderHome();
    const proof = document.querySelector(".lv2-proof")!;
    expect(proof.classList.contains("is-ok")).toBe(true);
    fireEvent.click(proof.querySelector('button[data-out="bad"]')!);
    expect(proof.classList.contains("is-bad")).toBe(true);
    expect(proof.querySelector('button[data-out="bad"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches the action group", () => {
    renderHome();
    fireEvent.click(document.querySelector('.lv2-ag-tabs button[data-g="posting"]')!);
    const shown = [...document.querySelectorAll(".lv2-ag-panel")].filter((p) => !(p as HTMLElement).hidden);
    expect(shown).toHaveLength(1);
    expect(shown[0].getAttribute("data-g")).toBe("posting");
  });
});

describe("no purple-family hue in the stylesheet", () => {
  function hue(r: number, g: number, b: number): number | null {
    const [R, G, B] = [r, g, b].map((v) => v / 255);
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const d = max - min;
    if (d < 0.06) return null;
    let h: number;
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  it("has no hex colour with a hue from 250 to 330", () => {
    const bad: string[] = [];
    for (const m of cssText.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      const h = hue(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
      if (h !== null && h >= 250 && h <= 330) bad.push(`${m[0]} (${h.toFixed(0)})`);
    }
    expect(bad).toEqual([]);
  });

  it("has no rgb or rgba colour with a hue from 250 to 330", () => {
    const bad: string[] = [];
    for (const m of cssText.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      const h = hue(Number(m[1]), Number(m[2]), Number(m[3]));
      if (h !== null && h >= 250 && h <= 330) bad.push(`${m[0]} (${h.toFixed(0)})`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps the locked orange", () => {
    expect(cssText.toLowerCase()).toContain("#ff5630");
    expect(cssText.toLowerCase()).toContain("#ff7a58");
  });

  it("has reduced-motion, reduced-transparency and contrast fallbacks", () => {
    expect(cssText).toMatch(/@media \(prefers-reduced-motion: ?reduce\)/);
    expect(cssText).toMatch(/@media \(prefers-reduced-transparency: ?reduce\)/);
    expect(cssText).toMatch(/@media \(prefers-contrast: ?more\)/);
  });
});
