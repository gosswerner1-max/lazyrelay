import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { captureReferralCode, claimStoredReferral, readChannelParam, reportReferralClick } from "./referral";

describe("readChannelParam", () => {
  it("reads utm_content when it is a safe short word", () => {
    expect(readChannelParam("?ref=sarah&utm_content=YouTube")).toBe("youtube");
    expect(readChannelParam("?utm_content=news_letter-2")).toBe("news_letter-2");
  });
  it("ignores anything else", () => {
    expect(readChannelParam("")).toBeNull();
    expect(readChannelParam("?utm_content=")).toBeNull();
    expect(readChannelParam("?utm_content=You%20Tube")).toBeNull();
    expect(readChannelParam("?utm_content=" + "a".repeat(31))).toBeNull();
    expect(readChannelParam("?utm_content=%3Cscript%3E")).toBeNull();
  });
});

describe("reportReferralClick", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the code and the channel, with no cookies or ids", () => {
    reportReferralClick("sarah", "youtube");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/public\/referral\/click$/);
    expect(JSON.parse(init.body)).toEqual({ code: "sarah", channel: "youtube" });
    expect(init.credentials).toBeUndefined();
    expect(Object.keys(init.headers)).toEqual(["Content-Type"]);
  });
  it("does nothing without a code", () => {
    reportReferralClick(null, "youtube");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("counts a code once per tab session, but a different code again", () => {
    reportReferralClick("sarah", null);
    reportReferralClick("sarah", null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    reportReferralClick("sam", null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("never throws when the network call fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(() => reportReferralClick("sarah", null)).not.toThrow();
    await Promise.resolve();
  });
});

describe("claimStoredReferral (keeps the code for a Google sign in)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("posts the stored code to /referral/claim", async () => {
    captureReferralCode("sarah");
    const fetcher = vi.fn(async () => ({ claimed: true }));
    await claimStoredReferral(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/referral/claim", { method: "POST", body: JSON.stringify({ code: "sarah" }) });
  });

  it("does nothing when no code is stored", async () => {
    const fetcher = vi.fn(async () => ({ claimed: false }));
    await claimStoredReferral(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks the server once per browser session for the same code", async () => {
    captureReferralCode("sarah");
    const fetcher = vi.fn(async () => ({ claimed: false }));
    await claimStoredReferral(fetcher);
    await claimStoredReferral(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a failed call is swallowed (it must never break sign in) and is tried again next time", async () => {
    captureReferralCode("sarah");
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ claimed: true });
    await expect(claimStoredReferral(fetcher)).resolves.toBeUndefined();
    await claimStoredReferral(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
