import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ authedFetch: vi.fn() }));

import { buildCompetitorClient } from "./competitorDefault";

afterEach(() => vi.restoreAllMocks());

describe("buildCompetitorClient", () => {
  it.each([undefined, "", "   "])("with no service address (%j) it says 'not switched on yet' and makes no request", async (address) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(buildCompetitorClient(address).analyze("https://rival.example/")).rejects.toMatchObject({
      code: "not_connected",
      message: "This feature is not switched on yet.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with an address that is not plain https it refuses the same way, shows the mistake in the console, and makes no request", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(buildCompetitorClient("http://insecure.example").analyze("https://rival.example/")).rejects.toMatchObject({ code: "not_connected" });
    expect(errorSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
