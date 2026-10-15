import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import posthogSource from "./posthog.ts?raw";

// posthog-js was about 276 KB of source (12.6% of the main entry) imported at the top of lib/posthog.ts, yet PostHog
// only starts after a visitor grants analytics consent. It is now loaded with a dynamic import() on the first grant,
// so a visitor who never consents never downloads it. These tests pin the behaviour that must not change: nothing
// loads or starts before consent, init runs once with the same options, and a revoke always ends opted out.
const init = vi.fn();
const optIn = vi.fn();
const optOut = vi.fn();
let loads = 0;

function mockPostHog(opts: { delayMs?: number; fail?: boolean } = {}) {
  vi.doMock("posthog-js", async () => {
    loads += 1;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) throw new Error("chunk load failed");
    return { default: { init, opt_in_capturing: optIn, opt_out_capturing: optOut } };
  });
}

async function freshModule() {
  vi.resetModules();
  return import("./posthog.ts");
}

beforeEach(() => {
  init.mockClear();
  optIn.mockClear();
  optOut.mockClear();
  loads = 0;
});
afterEach(() => {
  vi.doUnmock("posthog-js");
  vi.restoreAllMocks();
});

describe("posthog-js is not in the entry bundle", () => {
  it("is loaded with a dynamic import, never a top-level import", () => {
    expect(posthogSource).not.toMatch(/^import\s[^;]*from\s+["']posthog-js["']/m);
    expect(posthogSource).toContain('import("posthog-js")');
  });
});

describe("setPostHogConsent", () => {
  it("loads and starts nothing until consent is granted", async () => {
    mockPostHog();
    const { setPostHogConsent } = await freshModule();
    setPostHogConsent(false);
    await Promise.resolve();
    expect(loads).toBe(0);
    expect(init).not.toHaveBeenCalled();
    expect(optOut).not.toHaveBeenCalled();
  });

  it("on grant, initializes once with the project options and opts in", async () => {
    mockPostHog();
    const { setPostHogConsent } = await freshModule();
    setPostHogConsent(true);
    await vi.waitFor(() => expect(optIn).toHaveBeenCalledTimes(1));
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      "phc_nQhXtkXVvt3PCem6AWcRywgGZhR53Hkr6uvrqskYomwB",
      expect.objectContaining({
        api_host: "https://us.i.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: true,
        autocapture: true,
      }),
    );
    setPostHogConsent(true);
    await vi.waitFor(() => expect(optIn).toHaveBeenCalledTimes(2));
    expect(init).toHaveBeenCalledTimes(1);
    expect(loads).toBe(1);
  });

  it("opts out when consent is revoked after PostHog started", async () => {
    mockPostHog();
    const { setPostHogConsent } = await freshModule();
    setPostHogConsent(true);
    await vi.waitFor(() => expect(optIn).toHaveBeenCalledTimes(1));
    setPostHogConsent(false);
    expect(optOut).toHaveBeenCalledTimes(1);
  });

  it("ends opted out when consent is revoked while PostHog is still loading", async () => {
    mockPostHog({ delayMs: 20 });
    const { setPostHogConsent } = await freshModule();
    setPostHogConsent(true);
    setPostHogConsent(false);
    await vi.waitFor(() => expect(optOut).toHaveBeenCalled());
    expect(optIn).not.toHaveBeenCalled();
  });

  it("reports a failed load on the console and retries on the next grant", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPostHog({ fail: true });
    const { setPostHogConsent } = await freshModule();
    setPostHogConsent(true);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(init).not.toHaveBeenCalled();
    vi.doUnmock("posthog-js");
    mockPostHog();
    setPostHogConsent(true);
    await vi.waitFor(() => expect(optIn).toHaveBeenCalledTimes(1));
    expect(init).toHaveBeenCalledTimes(1);
  });
});
