import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import indexHtml from "../../index.html?raw";
import htaccess from "../../public/.htaccess?raw";
import consentJs from "../../public/consent.js?raw";
import prerender from "../../scripts/prerender.mjs?raw";
import landing from "../pages/Landing.tsx?raw";
import main from "../main.tsx?raw";

// Third-party scripts must not delay the browser's load event (2026-10-16), without touching the privacy default,
// the CSP hashes of the inline scripts, or the directory badges crawlers look for.

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, "readyState", { value: state, configurable: true });
}

async function sha256Base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let bin = "";
  digest.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

describe("index.html", () => {
  it("has no external gtag.js script tag", () => {
    expect(indexHtml).not.toMatch(/<script[^>]*googletagmanager\.com/);
  });

  it("keeps the inline consent snippet unchanged: its hash is still allowed by the CSP in .htaccess", async () => {
    const doc = new DOMParser().parseFromString(indexHtml, "text/html");
    const snippet = [...doc.querySelectorAll("script:not([src])")].find((s) => (s.textContent ?? "").includes("Consent Mode v2 default"));
    expect(snippet).toBeDefined();
    const hash = await sha256Base64(snippet!.textContent ?? "");
    expect(htaccess).toContain(`'sha256-${hash}'`);
  });

  it("main.tsx loads the Google tag after load", () => {
    expect(main).toMatch(/loadScriptAfterLoad\(\s*["'`]https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-CNVBJ2076F/);
  });
});

describe("Landing SourceForge badge script", () => {
  it("is injected through the after-load helper, with the placeholder link logic untouched", () => {
    expect(landing).toMatch(/loadScriptAfterLoad\(\s*["']https:\/\/b\.sf-syn\.com\/badge_js/);
    expect(landing).toContain('a.href = "https://sourceforge.net/software/product/LazyRelay/";');
  });
});

describe("prerender.mjs", () => {
  it("removes both third-party script hosts from the baked HTML", () => {
    expect(prerender).toContain("googletagmanager.com");
    expect(prerender).toContain("b.sf-syn.com");
  });
});

describe("public/consent.js", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).dataLayer;
    delete (window as unknown as Record<string, unknown>).gtag;
    setReadyState("loading");
  });
  afterEach(() => {
    vi.useRealTimers();
    setReadyState("complete");
  });

  it("denies consent first, adds no gtag script until load, then exactly one", () => {
    new Function(consentJs)();
    const gtagTags = () => document.querySelectorAll('script[src*="googletagmanager.com"]');
    expect(gtagTags()).toHaveLength(0);

    const layer = (window as unknown as { dataLayer: IArguments[] }).dataLayer;
    const first = Array.from(layer[0]);
    expect(first.slice(0, 2)).toEqual(["consent", "default"]);
    expect(first[2]).toEqual({
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied",
      personalization_storage: "denied",
    });

    vi.advanceTimersByTime(10_000);
    expect(gtagTags()).toHaveLength(0);

    setReadyState("complete");
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(10_000);
    expect(gtagTags()).toHaveLength(1);
  });
});
